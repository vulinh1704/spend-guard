/**
 * The Circle wallet rail against fake Circle clients: a throwaway key stands in for Circle's MPC
 * signer, so the signatures are real EIP-712 ones, and nothing touches the network. The last tests
 * run Circle's real SDK (and the setup script) against a local fake of Circle's API, to pin what
 * goes over the wire.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getTypesForEIP712Domain, hashDomain, hexToBigInt, numberToHex, parseSignature, recoverTypedDataAddress, serializeSignature } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPaidApi } from '../demo/paid-api.js';
import { Guard } from '../src/guard.js';
import { ARC_USDC } from '../src/rails/arc.js';
import {
  ARC_TESTNET_USDC_DOMAIN, ARC_TESTNET_USDC_TOKEN_ID, CircleWalletRail, circleClientFromEnv, circleWalletRailFromEnv, TRANSFER_WITH_AUTHORIZATION,
} from '../src/rails/circle-wallet.js';
import { payingFetch } from '../src/x402.js';

const account = privateKeyToAccount(generatePrivateKey());
const ADDRESS = account.address;
const PAYEE = privateKeyToAccount(generatePrivateKey()).address;
const HASH = `0x${'ab'.repeat(32)}`;
const NOW = 1_800_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const intent = { resource: 'https://api.example/weather', host: 'api.example', network: 'arc-testnet', asset: 'usdc', amount: 10_000n, payTo: PAYEE, description: '/weather, one call' };
/** What a v2 paywall offers for USDC on Arc testnet (x402 'exact', EIP-3009). */
const offer = { scheme: 'exact', network: 'eip155:5042002', amount: '10000', asset: ARC_USDC, payTo: PAYEE, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } };

/** Shaped like Circle's SDK: every call resolves to {data}; signTypedData signs the JSON it gets. */
function fakeClient({ fail, state = 'COMPLETE', id = 'tx-1', signer = account, prefix = true, tweak = (sig) => sig, hang = false } = {}) {
  const calls = [];
  return {
    calls,
    createTransaction: async (input) => (calls.push(['createTransaction', input]), { data: id ? { id, state: 'INITIATED' } : {} }),
    getTransaction: async (input) => {
      calls.push(['getTransaction', input]);
      if (hang) await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason)));
      if (fail) throw new Error(`Transaction ${input.id} ${fail}`);
      return { data: { transaction: { id: input.id, state, txHash: state === 'COMPLETE' ? HASH : undefined } } };
    },
    signTypedData: async (input) => {
      calls.push(['signTypedData', input]);
      const signature = tweak(await signer.signTypedData(JSON.parse(input.data)));
      return { data: { signature: prefix ? signature : signature.slice(2) } };
    },
  };
}

const rail = (client, options = {}) => new CircleWalletRail({ client, walletId: 'w-1', address: ADDRESS, now: () => NOW, ...options });
const signedData = (client) => JSON.parse(client.calls.find(([name]) => name === 'signTypedData')[1].data);
const typedOf = ({ authorization: a }) => ({
  domain: ARC_TESTNET_USDC_DOMAIN, types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION }, primaryType: 'TransferWithAuthorization',
  message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
});

describe('Circle wallet rail: transfers', () => {
  test('asks Circle for a USDC transfer, waits for it and returns the tx hash as proof', async () => {
    const client = fakeClient();
    const receipt = await rail(client).pay(intent);
    const [[, created], [, polled]] = client.calls;
    assert.match(created.idempotencyKey, UUID);
    assert.deepEqual({ ...created, idempotencyKey: 'x' }, {
      walletId: 'w-1', tokenId: ARC_TESTNET_USDC_TOKEN_ID, destinationAddress: PAYEE, amount: ['0.01'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } }, idempotencyKey: 'x', refId: 'api.example',
    });
    assert.equal(polled.id, 'tx-1');
    assert.equal(polled.waitForState, 'COMPLETE');
    assert.ok(polled.signal instanceof AbortSignal);
    assert.deepEqual(receipt, { network: 'arc-testnet', txid: HASH, proof: { txid: HASH, sender: ADDRESS }, circle: { transactionId: 'tx-1' } });
  });

  test('sends amounts in decimal USDC, as Circle expects', async () => {
    for (const [amount, expected] of [[1n, '0.000001'], [2_500_000n, '2.5'], [10_000n, '0.01']]) {
      const client = fakeClient();
      await rail(client).pay({ ...intent, amount });
      assert.deepEqual(client.calls[0][1].amount, [expected]);
    }
  });

  test('a transfer Circle denies, drops or never finishes is an error, not a receipt', async () => {
    await assert.rejects(rail(fakeClient({ fail: 'DENIED (SCREENING)' })).pay(intent), /Circle transaction tx-1 .*DENIED \(SCREENING\)/);
    await assert.rejects(rail(fakeClient({ id: null })).pay(intent), /did not accept/);
    await assert.rejects(rail(fakeClient({ state: 'CONFIRMED' })).pay(intent), /ended CONFIRMED/);
    await assert.rejects(rail(fakeClient({ hang: true }), { timeoutMs: 20 }).pay(intent), /still pending after 0.02s; check it in Circle/);
  });

  test('only USDC is paid on this rail', async () => {
    const client = fakeClient();
    await assert.rejects(rail(client).pay({ ...intent, asset: 'near' }), /pays in USDC/);
    assert.equal(client.calls.length, 0);
  });
});

describe('Circle wallet rail: EIP-3009 authorizations', () => {
  test('the pinned domain is Arc testnet USDC\'s on-chain DOMAIN_SEPARATOR', () => {
    const types = { EIP712Domain: getTypesForEIP712Domain({ domain: ARC_TESTNET_USDC_DOMAIN }) };
    assert.equal(hashDomain({ domain: ARC_TESTNET_USDC_DOMAIN, types }), '0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0');
  });

  test('Circle signs a TransferWithAuthorization for exactly what the guard approved', async () => {
    const client = fakeClient();
    const receipt = await rail(client, { mode: 'authorization' }).pay(intent);
    const data = signedData(client);
    assert.ok(data.types.EIP712Domain, 'the domain types travel with the data, or Circle signs an empty domain');
    assert.deepEqual(data.domain, ARC_TESTNET_USDC_DOMAIN);
    assert.equal(data.primaryType, 'TransferWithAuthorization');
    const expected = { from: ADDRESS, to: PAYEE, value: '10000', validAfter: '0', validBefore: String(NOW / 1000 + 300) };
    // viem writes addresses in lower case; they hash the same.
    assert.deepEqual({ ...data.message, nonce: 'n' }, { ...expected, from: ADDRESS.toLowerCase(), to: PAYEE.toLowerCase(), nonce: 'n' });
    assert.match(client.calls[0][1].memo, /^x402 api\.example: \/weather, one call$/);

    const { signature, authorization } = receipt.proof;
    assert.equal(await recoverTypedDataAddress({ ...typedOf(receipt.proof), signature }), ADDRESS);
    assert.deepEqual(authorization, { ...expected, nonce: data.message.nonce });
    assert.deepEqual(receipt.authorization, { nonce: authorization.nonce, validBefore: authorization.validBefore });
    assert.equal(receipt.network, 'arc-testnet');
    assert.equal(receipt.txid, undefined, 'nothing is on chain until the paywall settles');
  });

  test('a signature from another key is refused; a bare hex signature is normalized', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(rail(fakeClient({ signer: other }), { mode: 'authorization' }).pay(intent), /recovers to .*not the wallet/);
    const receipt = await rail(fakeClient({ prefix: false }), { mode: 'authorization' }).pay(intent);
    assert.match(receipt.proof.signature, /^0x[0-9a-f]{130}$/);
  });

  test('a valid signature USDC\'s ECRecover would refuse (v 0/1, high s) comes back in the form it accepts', async () => {
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // secp256k1's order
    const tweaks = {
      'v as 0/1': (sig) => sig.slice(0, -2) + (parseInt(sig.slice(-2), 16) - 27).toString(16).padStart(2, '0'),
      'high s': (sig) => {
        const { r, s, yParity } = parseSignature(sig);
        return serializeSignature({ r, s: numberToHex(N - hexToBigInt(s), { size: 32 }), yParity: 1 - yParity });
      },
    };
    for (const [label, tweak] of Object.entries(tweaks)) {
      const receipt = await rail(fakeClient({ tweak }), { mode: 'authorization' }).pay(intent);
      // The key signs deterministically (RFC 6979) with low s and v 27/28: the same bytes must come back.
      assert.equal(receipt.proof.signature, await account.signTypedData(typedOf(receipt.proof)), label);
    }
  });

  test('every authorization gets a fresh nonce', async () => {
    const r = rail(fakeClient(), { mode: 'authorization' });
    const [a, b] = [await r.pay(intent), await r.pay(intent)];
    assert.notEqual(a.proof.authorization.nonce, b.proof.authorization.nonce);
  });
});

describe('Circle wallet rail: the paywall\'s offer picks the way to pay', () => {
  test('an x402 exact offer is signed within its timeout; no offer means a transfer', async () => {
    const signing = fakeClient();
    const receipt = await rail(signing).pay({ ...intent, x402: offer });
    assert.equal(receipt.proof.authorization.validBefore, String(NOW / 1000 + 60));
    assert.deepEqual(signing.calls.map(([name]) => name), ['signTypedData']);

    const normalized = fakeClient();
    await rail(normalized).pay({ ...intent, x402: { version: 2, raw: offer } });
    assert.deepEqual(normalized.calls.map(([name]) => name), ['signTypedData']);

    const pushing = fakeClient();
    await rail(pushing).pay(intent);
    assert.deepEqual(pushing.calls.map(([name]) => name), ['createTransaction', 'getTransaction']);
  });

  test('signs what the guard approved, not the offer\'s numbers', async () => {
    const client = fakeClient();
    const receipt = await rail(client).pay({ ...intent, x402: { ...offer, amount: '999999', payTo: ADDRESS } });
    assert.equal(receipt.proof.authorization.value, '10000');
    assert.equal(receipt.proof.authorization.to, PAYEE);
  });

  test('an offer for another chain, token or transfer method is refused before Circle is asked', async () => {
    const cases = [
      [{ ...offer, network: 'eip155:5042' }, /signs only for USDC 2 on chain 5042002/], // Arc mainnet: same address, real money
      [{ ...offer, asset: PAYEE }, /signs only for/],
      [{ ...offer, extra: { name: 'USD Coin', version: '2' } }, /signs only for/],
      [{ ...offer, extra: { ...offer.extra, assetTransferMethod: 'permit2' } }, /EIP-3009 authorizations only/],
      [{ ...offer, extra: { ...offer.extra, paymentFlow: 'escrow' } }, /EIP-3009 authorizations only/],
    ];
    for (const [x402, error] of cases) {
      const client = fakeClient();
      await assert.rejects(rail(client).pay({ ...intent, x402 }), error);
      assert.equal(client.calls.length, 0);
    }
  });

  test('an x402 v2 offer the wallet can\'t sign is refused, not paid by a transfer the paywall would ignore', async () => {
    const cases = [
      { ...offer, extra: undefined },
      { ...offer, extra: {} },
      { ...offer, scheme: 'upto' },
      { ...offer, network: 'eip155:5042', extra: undefined }, // Arc mainnet
      { x402Version: 2, ...offer, network: 'arc-testnet', extra: undefined },
      { version: 2, raw: { ...offer, network: 'arc-testnet', extra: undefined } },
      { x402Version: 1, ...offer, network: 'arc-testnet', scheme: 'upto', extra: undefined },
    ];
    for (const x402 of cases) {
      const client = fakeClient();
      await assert.rejects(rail(client).pay({ ...intent, x402 }), /pays 'exact' only|can't sign it, and a transfer would not unlock it/);
      assert.equal(client.calls.length, 0, JSON.stringify(x402));
    }
  });

  test('an x402 v1 offer without a domain, like the demo paywall\'s, is paid by transfer', async () => {
    const v1 = { scheme: 'exact', network: 'arc-testnet', maxAmountRequired: '10000', payTo: PAYEE, asset: 'usdc', resource: intent.resource };
    // The same offer as the x402 client reads it: version 1, CAIP-2 network.
    const read = { x402Version: 1, scheme: 'exact', network: 'eip155:5042002', asset: 'usdc', amount: 10_000n, payTo: PAYEE };
    for (const x402 of [v1, read]) {
      const client = fakeClient();
      await rail(client).pay({ ...intent, x402 });
      assert.deepEqual(client.calls.map(([name]) => name), ['createTransaction', 'getTransaction']);
    }
  });

  test('transfer mode ignores the offer', async () => {
    const client = fakeClient();
    await rail(client, { mode: 'transfer' }).pay({ ...intent, x402: offer });
    assert.deepEqual(client.calls.map(([name]) => name), ['createTransaction', 'getTransaction']);
  });
});

describe('Circle wallet rail behind the guard', () => {
  async function run(client, path = 'weather') {
    const payees = { weather: PAYEE, news: PAYEE, quotes: PAYEE, maps: PAYEE, thief: privateKeyToAccount(generatePrivateKey()).address };
    // Stands in for checkArcPayment: the proof must name Circle's tx hash and the Circle wallet.
    const verify = async (p) => (p?.txid === HASH && p?.sender === ADDRESS ? null : 'not paid');
    const api = createPaidApi({ network: 'arc-testnet', asset: 'usdc', payees, verify });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${api.address().port}`;
    const guard = new Guard({
      policy: { networks: ['arc-testnet'], dailyUsd: 1, perPaymentUsd: 0.5, askAboveUsd: 0.25, services: { [new URL(base).host]: { payTo: [PAYEE] } } },
      rails: [rail(client)],
    });
    try {
      const res = await payingFetch(guard, `${base}/${path}`).catch((err) => err);
      return { res, entries: guard.ledger.entries };
    } finally {
      api.close();
    }
  }

  test('a Circle transfer pays the paywall and lands in the ledger', async () => {
    const { res, entries } = await run(fakeClient());
    assert.equal(res.status, 200);
    assert.deepEqual(entries.map((e) => e.status), ['paid']);
    assert.equal(entries[0].receipt.circle.transactionId, 'tx-1');
  });

  test('a transfer Circle\'s screening denies is recorded as failed with Circle\'s reason', async () => {
    const { res, entries } = await run(fakeClient({ fail: 'DENIED (SCREENING)' }));
    assert.match(res.message, /DENIED/);
    assert.deepEqual(entries.map((e) => e.status), ['failed']);
    assert.match(entries[0].error, /DENIED \(SCREENING\)/);
  });
});

describe('Circle wallet rail from the environment', () => {
  const wallet = { id: 'w-1', address: ADDRESS, blockchain: 'ARC-TESTNET', accountType: 'EOA', state: 'LIVE' };
  const clientWith = (w) => ({ ...fakeClient(), getWallet: async ({ id }) => ({ data: { wallet: { ...w, id } } }) });
  const env = { CIRCLE_WALLET_ID: 'w-1' };

  test('builds the rail for a live Arc testnet wallet', async () => {
    const r = await circleWalletRailFromEnv({ ...env, CIRCLE_WALLET_ADDRESS: ADDRESS.toLowerCase() }, { client: clientWith(wallet), mode: 'authorization' });
    assert.equal(r.walletId, 'w-1');
    assert.equal(r.address, ADDRESS);
    assert.equal(r.mode, 'authorization');
  });

  test('refuses a wallet on another chain, a frozen one, a stale address or a contract wallet for signing', async () => {
    await assert.rejects(circleWalletRailFromEnv({}, { client: clientWith(wallet) }), /CIRCLE_WALLET_ID missing/);
    await assert.rejects(circleWalletRailFromEnv(env, { client: clientWith({ ...wallet, blockchain: 'ARC' }) }), /on ARC, not ARC-TESTNET/);
    await assert.rejects(circleWalletRailFromEnv(env, { client: clientWith({ ...wallet, state: 'FROZEN' }) }), /FROZEN, not LIVE/);
    await assert.rejects(circleWalletRailFromEnv({ ...env, CIRCLE_WALLET_ADDRESS: PAYEE }, { client: clientWith(wallet) }), /CIRCLE_WALLET_ADDRESS/);
    await assert.rejects(circleWalletRailFromEnv(env, { client: clientWith({ ...wallet, accountType: 'SCA' }), mode: 'authorization' }), /needs an EOA/);
  });

  test('a contract wallet is refused in the default mode too, which signs x402 offers; transfer mode takes it', async () => {
    const sca = clientWith({ ...wallet, accountType: 'SCA' });
    await assert.rejects(circleWalletRailFromEnv(env, { client: sca }), /SCA; signing authorizations needs an EOA, so use mode 'transfer'/);
    assert.equal((await circleWalletRailFromEnv(env, { client: sca, mode: 'transfer' })).mode, 'transfer');
  });

  test('the Circle client needs both secrets and a testnet API key', async () => {
    await assert.rejects(circleClientFromEnv({}), /CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET missing/);
    const error = await circleClientFromEnv({ CIRCLE_API_KEY: 'LIVE_API_KEY:id:secret', CIRCLE_ENTITY_SECRET: 'f'.repeat(64) }).catch((err) => err);
    assert.match(error.message, /not a testnet key/);
    assert.doesNotMatch(error.message, /id:secret/, 'the key itself is never echoed');
  });
});

/** A local stand-in for Circle's API, enough for the calls the rail makes. */
function fakeCircleApi(signer) {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : undefined;
    requests.push({ method: req.method, path: req.url.split('?')[0], auth: req.headers.authorization, body: json });
    const reply = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
    const route = `${req.method} ${req.url.split('?')[0]}`;
    const wallet = { id: 'w-1', address: signer.address.toLowerCase(), blockchain: 'ARC-TESTNET', accountType: 'EOA', state: 'LIVE', walletSetId: 'ws-1', custodyType: 'DEVELOPER' };
    if (route === 'GET /v1/w3s/config/entity/publicKey') return reply(200, { publicKey });
    if (route === 'POST /v1/w3s/developer/walletSets') return reply(201, { walletSet: { id: 'ws-1', custodyType: 'DEVELOPER' } });
    if (route === 'POST /v1/w3s/developer/wallets') return reply(201, { wallets: [wallet] });
    if (route === 'GET /v1/w3s/wallets/w-1') return reply(200, { wallet });
    if (route === 'GET /v1/w3s/wallets/w-1/balances') return reply(200, { tokenBalances: [{ amount: '1.5', token: { id: ARC_TESTNET_USDC_TOKEN_ID, symbol: 'USDC', decimals: 6 } }] });
    if (route === 'POST /v1/w3s/developer/transactions/transfer') return reply(201, { id: 'tx-1', state: 'INITIATED' });
    if (route === 'GET /v1/w3s/transactions/tx-1') return reply(200, { transaction: { id: 'tx-1', state: 'COMPLETE', txHash: HASH } });
    if (route === 'POST /v1/w3s/developer/sign/typedData') return reply(200, { signature: await signer.signTypedData(JSON.parse(json.data)) });
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 156001, message: 'not found' }));
  });
  return { server, requests };
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const SETUP = fileURLToPath(new URL('../scripts/circle-wallet-setup.js', import.meta.url));

describe('Circle wallet rail with Circle\'s SDK', { skip: nodeMajor < 22 && 'the Circle SDK needs Node 22+' }, () => {
  async function withApi(fn) {
    const { server, requests } = fakeCircleApi(account);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const env = { CIRCLE_API_KEY: 'TEST_API_KEY:key-id:key-secret', CIRCLE_ENTITY_SECRET: randomBytes(32).toString('hex'), CIRCLE_BASE_URL: `http://127.0.0.1:${server.address().port}` };
    try {
      await fn(env, requests);
    } finally {
      server.close();
    }
  }

  test('the setup script creates one wallet and keeps only non-secret ids in .env', () => withApi(async (env, requests) => {
    const dir = mkdtempSync(join(tmpdir(), 'circle-setup-'));
    try {
      const run = () => promisify(execFile)(process.execPath, [SETUP], { cwd: dir, env: { PATH: process.env.PATH, ...env } });
      const first = await run();
      const second = await run();
      const saved = readFileSync(join(dir, '.env'), 'utf8');
      assert.equal(saved, `CIRCLE_WALLET_SET_ID=ws-1\nCIRCLE_WALLET_ID=w-1\nCIRCLE_WALLET_ADDRESS=${ADDRESS.toLowerCase()}\n`);
      assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
      assert.match(first.stdout, /created Circle wallet w-1 in wallet set ws-1/);
      assert.match(second.stdout, new RegExp(`Circle wallet w-1: ${ADDRESS} on Arc testnet[\\s\\S]*balance by Circle: 1.5 USDC`));
      assert.doesNotMatch(second.stdout, /created/);
      assert.equal(requests.filter((q) => q.path === '/v1/w3s/developer/wallets').length, 1, 'a rerun reuses the wallet');
      const created = requests.find((q) => q.path === '/v1/w3s/developer/wallets').body;
      assert.deepEqual([created.walletSetId, created.blockchains, created.accountType, created.count], ['ws-1', ['ARC-TESTNET'], 'EOA', 1]);
      for (const out of [first.stdout, first.stderr, second.stdout, second.stderr, saved]) {
        assert.ok(!out.includes(env.CIRCLE_API_KEY) && !out.includes(env.CIRCLE_ENTITY_SECRET), 'secrets are never printed or written');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  test('the setup script reports Circle\'s errors without the request that carried the key', () => withApi(async (env) => {
    const dir = mkdtempSync(join(tmpdir(), 'circle-setup-'));
    try {
      const failed = await promisify(execFile)(process.execPath, [SETUP], { cwd: dir, env: { PATH: process.env.PATH, ...env, CIRCLE_WALLET_ID: 'w-404' } }).catch((err) => err);
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, /^circle-wallet-setup: .*\(HTTP 404, code 156001\)\n$/);
      assert.ok(!failed.stderr.includes(env.CIRCLE_API_KEY) && !failed.stderr.includes(env.CIRCLE_ENTITY_SECRET));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  test('the rail sends the requests Circle\'s API expects', () => withApi(async (api, requests) => {
    const env = { ...api, CIRCLE_WALLET_ID: 'w-1' };
    const r = await circleWalletRailFromEnv(env, { now: () => NOW });
    assert.equal(r.address, ADDRESS);

    const paid = await r.pay(intent);
    assert.equal(paid.txid, HASH);
    const transfer = requests.find((q) => q.path === '/v1/w3s/developer/transactions/transfer');
    assert.equal(transfer.auth, `Bearer ${env.CIRCLE_API_KEY}`);
    assert.equal(typeof transfer.body.entitySecretCiphertext, 'string');
    assert.notEqual(transfer.body.entitySecretCiphertext, env.CIRCLE_ENTITY_SECRET, 'the entity secret travels encrypted');
    assert.deepEqual({ ...transfer.body, entitySecretCiphertext: 'c', idempotencyKey: 'k' }, {
      entitySecretCiphertext: 'c', idempotencyKey: 'k', walletId: 'w-1', tokenId: ARC_TESTNET_USDC_TOKEN_ID,
      destinationAddress: PAYEE, amounts: ['0.01'], feeLevel: 'MEDIUM', refId: 'api.example',
    });

    const signed = await r.pay({ ...intent, x402: offer });
    const sign = requests.find((q) => q.path === '/v1/w3s/developer/sign/typedData');
    assert.equal(sign.body.walletId, 'w-1');
    assert.equal(JSON.parse(sign.body.data).domain.verifyingContract, ARC_USDC);
    assert.equal(await recoverTypedDataAddress({ ...typedOf(signed.proof), signature: signed.proof.signature }), ADDRESS);
  }));
});
