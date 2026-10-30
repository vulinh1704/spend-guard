/**
 * x402 v2 and the 'exact' EVM scheme (EIP-3009), offline. Signatures are real EIP-712 signatures
 * from throwaway keys and the paywall checks them for real; only the chain is fake, shaped like
 * viem's clients.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeFunctionData, domainSeparator, encodeAbiParameters, encodeEventTopics, erc20Abi, parseSignature, parseTransaction, recoverTypedDataAddress, serializeSignature, toHex, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPaidApi } from '../demo/paid-api.js';
import { Guard, GuardRefused } from '../src/guard.js';
import { Ledger } from '../src/ledger.js';
import { ARC_USDC, ARC_USDC_DOMAIN, ArcRail } from '../src/rails/arc.js';
import { gatewayOffer, GatewayRail } from '../src/rails/gateway.js';
import { chainIdOf, settleAuthorization, signAuthorization, typedData, verifyAuthorization } from '../src/rails/eip3009.js';
import { assetKey, caip2, decodePayment, encodePayment, networkName, payingFetch, pickOffer, pickRequirement, readPaymentRequired } from '../src/x402.js';

const KEY = generatePrivateKey();
const AGENT = privateKeyToAccount(KEY);
const STRANGER = privateKeyToAccount(generatePrivateKey());
const FACILITATOR = privateKeyToAccount(generatePrivateKey());
const address = () => privateKeyToAccount(generatePrivateKey()).address;
const PAYEES = { weather: address(), news: address(), quotes: address(), maps: address(), thief: address() };
const ARC = 'eip155:5042002';
const OTHER_TOKEN = address();
const requirement = (over = {}) => ({ scheme: 'exact', network: ARC, amount: '10000', asset: ARC_USDC, payTo: PAYEES.weather, maxTimeoutSeconds: 60, extra: ARC_USDC_DOMAIN, ...over });

function transferLog({ from, to, value, hash, token = ARC_USDC }) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockHash: `0x${'00'.repeat(32)}`, blockNumber: 1n, logIndex: 0, transactionHash: hash, transactionIndex: 0, removed: false,
  };
}

/**
 * Just enough of Arc's USDC for a facilitator: one balance for everyone, used nonces, and a Transfer
 * log for every submitted authorization. It does not check signatures: the paywall must.
 */
function fakeChain({ balance = 10n ** 9n, simulation, receipt, latency = 0 } = {}) {
  const used = new Set();
  const sent = [];
  const receipts = new Map();
  return {
    sent,
    publicClient: {
      readContract: async ({ functionName, args }) => {
        await sleep(latency);
        return functionName === 'authorizationState' ? used.has(args[1]) : balance;
      },
      simulateContract: async (request) => {
        if (simulation) throw simulation;
        return { request };
      },
      waitForTransactionReceipt: async ({ hash }) => receipts.get(hash),
    },
    walletClient: {
      account: FACILITATOR,
      writeContract: async (request) => {
        const [from, to, value, , , nonce] = request.args;
        const hash = toHex(sent.length + 1, { size: 32 });
        used.add(nonce);
        sent.push(request);
        receipts.set(hash, receipt ?? { status: 'success', logs: [transferLog({ from, to, value, hash })] });
        return hash;
      },
    },
  };
}

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function paywall({ chain = fakeChain(), now } = {}) {
  const server = createPaidApi({ network: 'arc-testnet', asset: 'usdc', payees: PAYEES, verify: async () => 'pay with a signature', exact: { ...chain, now } });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`;
  return { chain, host, base: `http://${host}` };
}

/** An ArcRail on a throwaway key that counts its signatures and must never send a transaction. */
function railCountingSignatures() {
  const rail = new ArcRail({ privateKey: KEY });
  rail.signed = 0;
  const sign = rail.account.signTypedData;
  rail.account.signTypedData = async (...args) => (rail.signed++, sign(...args));
  rail.walletClient.prepareTransactionRequest = async () => assert.fail('the rail sent a transaction');
  rail.walletClient.sendRawTransaction = async () => assert.fail('the rail sent a transaction');
  return rail;
}

function guardFor(host, rail = railCountingSignatures(), ledger = undefined) {
  return new Guard({
    policy: {
      networks: ['arc-testnet'], dailyUsd: 2, perPaymentUsd: 1, askAboveUsd: 1, spikeRatio: 5,
      services: { [host]: { payTo: [PAYEES.weather, PAYEES.news, PAYEES.quotes, PAYEES.maps] } },
    },
    rails: [rail],
    ledger,
  });
}

/** fetch that keeps every request's headers and every response. */
function recordingFetch() {
  const log = [];
  const spy = async (url, init) => {
    const res = await fetch(url, init);
    log.push({ sent: new Headers(init?.headers), res });
    return res;
  };
  return { log, fetch: spy };
}

/** Sends a hand-made PAYMENT-SIGNATURE for the offer `path` shows; returns the 402's reason or the response. */
async function payBy(base, path, makePayment) {
  const offer = await readPaymentRequired(await fetch(`${base}${path}`));
  const payment = await makePayment(offer);
  const res = await fetch(`${base}${path}`, { headers: { 'PAYMENT-SIGNATURE': encodePayment(payment) } });
  if (res.status !== 402) return res;
  await res.text();
  return decodePayment(res.headers.get('payment-required')).error;
}

const signedFor = (over) => async (offer) => ({
  x402Version: 2, resource: offer.resource, accepted: offer.accepts[0],
  payload: await signAuthorization(AGENT, { ...offer.accepts[0], ...over }),
});

describe('x402 v2 with the exact scheme, through the guard', () => {
  test('the agent signs, the paywall settles, and the ledger gets the transaction', async () => {
    const { base, host, chain } = await paywall();
    const rail = railCountingSignatures();
    const guard = guardFor(host, rail);
    const { log, fetch } = recordingFetch();

    const res = await payingFetch(guard, `${base}/weather`, {}, { fetch });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).city, 'Hanoi');

    const offered = decodePayment(log[0].res.headers.get('payment-required'));
    assert.equal(offered.x402Version, 2);
    const payment = decodePayment(log[1].sent.get('payment-signature'));
    assert.equal(log[1].sent.has('x-payment'), false);
    assert.equal(payment.x402Version, 2);
    assert.deepEqual(payment.accepted, offered.accepts[0], 'accepted is the offer, verbatim');
    assert.deepEqual(payment.resource, offered.resource);

    const { signature, authorization } = payment.payload;
    assert.equal(authorization.from, AGENT.address);
    assert.equal(authorization.to, PAYEES.weather);
    assert.equal(authorization.value, '10000');
    assert.equal(await recoverTypedDataAddress({ ...typedData(payment.accepted, authorization), signature }), AGENT.address);

    assert.equal(rail.signed, 1);
    assert.equal(chain.sent.length, 1);
    assert.equal(chain.sent[0].functionName, 'transferWithAuthorization');
    const settlement = decodePayment(res.headers.get('payment-response'));
    assert.deepEqual(settlement, { success: true, transaction: toHex(1, { size: 32 }), amount: '10000', network: ARC, payer: AGENT.address });
    const entry = guard.ledger.entries.at(-1);
    assert.equal(entry.status, 'paid');
    assert.equal(entry.intent.network, 'arc-testnet');
    assert.equal(entry.intent.asset, 'usdc');
    assert.equal(entry.receipt.txid, settlement.transaction);
  });

  test('a payment the guard refuses is never signed', async () => {
    const { base, host, chain } = await paywall();
    const rail = railCountingSignatures();
    const guard = guardFor(host, rail);
    const { log, fetch } = recordingFetch();

    for (let i = 0; i < 2; i++) assert.equal((await payingFetch(guard, `${base}/maps`, {}, { fetch })).status, 200);
    await assert.rejects(payingFetch(guard, `${base}/maps`, {}, { fetch }), (err) => err instanceof GuardRefused && err.reasons[0].code === 'payee-swap');
    for (let i = 0; i < 3; i++) assert.equal((await payingFetch(guard, `${base}/quotes`, {}, { fetch })).status, 200);
    await assert.rejects(payingFetch(guard, `${base}/quotes`, {}, { fetch }), (err) => err.reasons[0].code === 'price-spike');

    assert.equal(rail.signed, 5);
    assert.equal(chain.sent.length, 5);
    assert.equal(log.filter((l) => l.sent.has('payment-signature')).length, 5, 'no payment was sent for the refused calls');
    assert.ok(!chain.sent.some((r) => r.args[1] === PAYEES.thief));
  });

  test('a replayed signature is refused, by the paywall and by the chain', async () => {
    const chain = fakeChain();
    const { base, host } = await paywall({ chain });
    const { log, fetch } = recordingFetch();
    await payingFetch(guardFor(host), `${base}/weather`, {}, { fetch });
    const replay = log[1].sent.get('payment-signature');

    const again = await fetch(`${base}/weather`, { headers: { 'PAYMENT-SIGNATURE': replay } });
    assert.equal(again.status, 402);
    assert.equal(decodePayment(again.headers.get('payment-required')).error, 'invalid_exact_evm_nonce_already_used');

    // A second paywall on the same chain has not seen it, but the token has.
    const other = await paywall({ chain });
    const elsewhere = await fetch(`${other.base}/weather`, { headers: { 'PAYMENT-SIGNATURE': replay } });
    assert.equal(decodePayment(elsewhere.headers.get('payment-required')).error, 'invalid_exact_evm_nonce_already_used');
    assert.equal(chain.sent.length, 1);
  });

  test('two requests racing with one signature are served once', async () => {
    // Reads take a while, as over a real RPC, so the three verifications overlap.
    const { base, chain } = await paywall({ chain: fakeChain({ latency: 25 }) });
    const offer = await readPaymentRequired(await fetch(`${base}/weather`));
    const header = encodePayment(await signedFor()(offer));
    const statuses = await Promise.all([1, 2, 3].map(() => fetch(`${base}/weather`, { headers: { 'PAYMENT-SIGNATURE': header } }).then((r) => (r.body?.cancel(), r.status))));
    assert.deepEqual(statuses.sort(), [200, 402, 402]);
    assert.equal(chain.sent.length, 1);
  });

  test('the paywall refuses the wrong payee, the wrong amount, an altered offer, an old version and an expired signature', async () => {
    const { base, chain } = await paywall();
    assert.equal(await payBy(base, '/weather', signedFor({ payTo: STRANGER.address })), 'invalid_exact_evm_recipient_mismatch');
    assert.equal(await payBy(base, '/weather', signedFor({ amount: '9999' })), 'invalid_exact_evm_payload_authorization_value_mismatch');
    assert.equal(await payBy(base, '/weather', async (offer) => ({ ...(await signedFor()(offer)), accepted: { ...offer.accepts[0], amount: '1' } })), 'no matching payment requirements');
    assert.equal(await payBy(base, '/weather', async (offer) => ({ ...(await signedFor()(offer)), x402Version: 1 })), 'invalid_x402_version');
    assert.equal(await payBy(base, '/weather', async (offer) => {
      const payment = await signedFor()(offer);
      return { ...payment, payload: { ...payment.payload, signature: (await STRANGER.signTypedData(typedData(offer.accepts[0], payment.payload.authorization))) } };
    }), 'invalid_exact_evm_signature');

    // The paywall's clock is two minutes ahead: the 60-second authorization has expired for it.
    const late = await paywall({ now: () => Date.now() + 120_000 });
    assert.equal(await payBy(late.base, '/weather', signedFor()), 'invalid_exact_evm_payload_authorization_valid_before');
    assert.equal(chain.sent.length + late.chain.sent.length, 0, 'nothing was settled');
  });

  test('a failed settlement is reported, and the signed amount still counts against the budget', async () => {
    const { base, host } = await paywall({ chain: fakeChain({ simulation: new Error('FiatTokenV2: invalid signature') }) });
    const guard = guardFor(host);
    const res = await payingFetch(guard, `${base}/news`);
    assert.equal(res.status, 402);
    const settlement = decodePayment(res.headers.get('payment-response'));
    assert.equal(settlement.success, false);
    assert.equal(settlement.errorReason, 'invalid_exact_evm_transaction_simulation_failed');
    // Until it expires, whoever holds the signature could still settle it.
    const entry = guard.ledger.entries.at(-1);
    assert.equal(entry.status, 'paid');
    assert.equal(entry.receipt.txid, undefined);
    assert.equal(guard.ledger.spentToday(Date.now()), 20_000n);
  });

  test('a ledger file gets the settlement as a line of its own, naming the paid entry', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-guard-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'ledger.jsonl');
    const ok = await paywall();
    const failing = await paywall({ chain: fakeChain({ simulation: new Error('FiatTokenV2: invalid signature') }) });
    const guard = guardFor(ok.host, railCountingSignatures(), new Ledger({ file }));
    // The second paywall sells from the same payees but cannot settle.
    guard.policy.services[failing.host] = guard.policy.services[ok.host];
    const reported = [];
    guard.on('settled', (entry) => reported.push(entry));

    assert.equal((await payingFetch(guard, `${ok.base}/weather`)).status, 200);
    assert.equal((await payingFetch(guard, `${failing.base}/news`)).status, 402);

    const [paid, settled, unpaid, refused] = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    // The paid line is written when the authorization is signed, before the paywall settles it.
    assert.equal(paid.status, 'paid');
    assert.equal(paid.receipt.txid, undefined);
    assert.deepEqual([settled.status, settled.entry, settled.txid, settled.settlement.success], ['settled', paid.id, toHex(1, { size: 32 }), true]);
    assert.equal(unpaid.status, 'paid');
    assert.notEqual(unpaid.id, paid.id);
    assert.deepEqual([refused.status, refused.entry, refused.txid, refused.settlement.errorReason], ['settled', unpaid.id, undefined, 'invalid_exact_evm_transaction_simulation_failed']);

    // In memory the settlement joins the entry; it is not a payment of its own.
    assert.deepEqual(guard.ledger.entries.map((e) => e.id), [paid.id, unpaid.id]);
    assert.equal(guard.ledger.entries[0].receipt.txid, settled.txid);
    assert.deepEqual(reported, guard.ledger.entries);
    assert.equal(guard.ledger.spentToday(Date.now()), 30_000n);
  });

  test('the v1 body is still there for transfer-proof clients', async () => {
    const { base } = await paywall();
    const res = await fetch(`${base}/weather`);
    const body = await res.json();
    assert.equal(body.x402Version, 1);
    assert.deepEqual(body.accepts.map((r) => [r.network, r.asset, r.maxAmountRequired]), [['arc-testnet', 'usdc', '10000']]);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

describe('ArcRail signing', () => {
  const offer = (over = {}) => ({ x402Version: 2, ...requirement(), amount: 10_000n, ...over });
  const intent = (x402) => ({ resource: 'https://api.example/x', host: 'api.example', network: 'arc-testnet', asset: 'usdc', amount: 10_000n, payTo: PAYEES.weather, x402 });

  test('signs for the guard-approved payee and amount, and broadcasts nothing', async () => {
    const rail = railCountingSignatures();
    const receipt = await rail.pay(intent(offer({ payTo: PAYEES.thief, amount: 1n })));
    assert.equal(receipt.txid, undefined);
    assert.equal(receipt.proof.authorization.to, PAYEES.weather);
    assert.equal(receipt.proof.authorization.value, '10000');
  });

  test('refuses to sign for another chain or another token', async () => {
    const rail = railCountingSignatures();
    await assert.rejects(rail.pay(intent(offer({ network: 'eip155:5042' }))), /signs for chain 5042002 only/);
    await assert.rejects(rail.pay(intent(offer({ asset: OTHER_TOKEN }))), /not Arc's USDC/);
    assert.equal(rail.signed, 0);
  });

  test('an offer without an EIP-712 domain gets the plain transfer, as before', async () => {
    const rail = new ArcRail({ privateKey: KEY });
    let sent;
    rail.walletClient.prepareTransactionRequest = async (args) => ({ ...args, chainId: 5042002, nonce: 0, gas: 60_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
    rail.walletClient.sendRawTransaction = async ({ serializedTransaction }) => (sent = serializedTransaction);
    rail.publicClient.waitForTransactionReceipt = async () => ({ status: 'success' });
    await rail.pay(intent(offer({ x402Version: 1, extra: undefined })));
    assert.equal(decodeFunctionData({ abi: erc20Abi, data: parseTransaction(sent).data }).functionName, 'transfer');
  });

  test('a v2 offer without an EIP-712 domain gets neither a transfer nor a signature', async () => {
    const rail = railCountingSignatures();
    await assert.rejects(rail.pay(intent(offer({ extra: undefined }))), /without the token's EIP-712 domain/);
    await assert.rejects(rail.pay(intent(offer({ extra: { name: 'USDC' } }))), /without the token's EIP-712 domain/);
    assert.equal(rail.signed, 0);
  });
});

describe('EIP-3009 authorizations', () => {
  const NOW = 1_800_000_000_000;
  const now = () => NOW;
  const T = NOW / 1000;
  const reader = ({ used = false, balance = 10n ** 9n } = {}) => ({ readContract: async ({ functionName }) => (functionName === 'authorizationState' ? used : balance) });

  test('the domain is USDC on Arc testnet, as the token itself reports it', async () => {
    const { authorization } = await signAuthorization(AGENT, requirement(), { now });
    const { domain } = typedData(requirement(), authorization);
    assert.equal(chainIdOf(ARC), 5042002);
    // DOMAIN_SEPARATOR() of 0x3600…0000 on Arc testnet, read on chain.
    assert.equal(domainSeparator({ domain }), '0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0');
  });

  test('a signature recovers to the agent and carries a fresh nonce and a short window', async () => {
    const one = await signAuthorization(AGENT, requirement(), { now });
    const two = await signAuthorization(AGENT, requirement({ maxTimeoutSeconds: 86_400 }), { now });
    assert.deepEqual({ ...one.authorization, nonce: undefined }, { from: AGENT.address, to: PAYEES.weather, value: '10000', validAfter: '0', validBefore: String(T + 60), nonce: undefined });
    assert.equal(two.authorization.validBefore, String(T + 120), 'a day-long timeout is capped at two minutes');
    assert.match(one.authorization.nonce, /^0x[0-9a-f]{64}$/);
    assert.notEqual(one.authorization.nonce, two.authorization.nonce);
    assert.ok(await verifyTypedData({ address: AGENT.address, signature: one.signature, ...typedData(requirement(), one.authorization) }));
  });

  test('verification accepts a good one and names what is wrong with a bad one', async () => {
    const good = await signAuthorization(AGENT, requirement(), { now });
    const check = (payload, req = requirement(), options = {}) => verifyAuthorization(options.client ?? reader(), payload, req, { now: options.now ?? now }).then((r) => r?.reason ?? null);

    assert.equal(await check(good), null);
    assert.equal(await check(good, requirement({ payTo: PAYEES.news })), 'invalid_exact_evm_recipient_mismatch');
    assert.equal(await check(good, requirement({ amount: '10001' })), 'invalid_exact_evm_payload_authorization_value_mismatch');
    assert.equal(await check(good, requirement({ amount: '9999' })), 'invalid_exact_evm_payload_authorization_value_mismatch');
    assert.equal(await check(good, requirement(), { now: () => NOW + 55_000 }), 'invalid_exact_evm_payload_authorization_valid_before');
    assert.equal(await check(good, requirement(), { client: reader({ used: true }) }), 'invalid_exact_evm_nonce_already_used');
    assert.equal(await check(good, requirement(), { client: reader({ balance: 9_999n }) }), 'invalid_exact_evm_insufficient_balance');
    assert.equal(await check({ authorization: good.authorization }), 'invalid_payload');

    const future = { ...good.authorization, validAfter: String(T + 30) };
    assert.equal(await check({ authorization: future, signature: await AGENT.signTypedData(typedData(requirement(), future)) }), 'invalid_exact_evm_payload_authorization_valid_after');
    const forged = await STRANGER.signTypedData(typedData(requirement(), good.authorization));
    assert.equal(await check({ ...good, signature: forged }), 'invalid_exact_evm_signature');
    // Same signer, mirrored s: ecrecover still finds the agent, but FiatToken would refuse it.
    const { r, s, yParity } = parseSignature(good.signature);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = serializeSignature({ r, s: toHex(N - BigInt(s), { size: 32 }), yParity: 1 - yParity });
    assert.equal(await check({ ...good, signature: highS }), 'invalid_exact_evm_signature');
  });

  test('settlement submits (v, r, s) and needs the token Transfer to succeed', async () => {
    const payload = await signAuthorization(AGENT, requirement());
    const ok = fakeChain();
    const settled = await settleAuthorization(ok.publicClient, ok.walletClient, payload, requirement());
    assert.equal(settled.success, true);
    const { args, address: token } = ok.sent[0];
    assert.equal(token, ARC_USDC);
    assert.equal(args.length, 9);
    assert.ok([27, 28].includes(args[6]));

    const hash = toHex(1, { size: 32 });
    const outcome = async (options) => {
      const chain = fakeChain(options);
      return settleAuthorization(chain.publicClient, chain.walletClient, payload, requirement());
    };
    assert.equal((await outcome({ simulation: new Error('FiatTokenV2: authorization is used or canceled') })).errorReason, 'invalid_exact_evm_transaction_simulation_failed');
    assert.equal((await outcome({ receipt: { status: 'reverted', logs: [] } })).errorReason, 'invalid_exact_evm_transaction_failed');
    const short = transferLog({ from: AGENT.address, to: PAYEES.weather, value: 9_999n, hash });
    assert.equal((await outcome({ receipt: { status: 'success', logs: [short] } })).errorReason, 'invalid_exact_evm_transfer_event_mismatch');
    const fake = transferLog({ from: AGENT.address, to: PAYEES.weather, value: 10_000n, hash, token: OTHER_TOKEN });
    assert.equal((await outcome({ receipt: { status: 'success', logs: [fake] } })).errorReason, 'invalid_exact_evm_transfer_event_mismatch');

    const stuck = fakeChain();
    stuck.publicClient.waitForTransactionReceipt = async () => Promise.reject(new Error('timed out'));
    assert.deepEqual(await settleAuthorization(stuck.publicClient, stuck.walletClient, payload, requirement()), { success: false, errorReason: 'settlement_pending', transaction: hash, network: ARC, payer: AGENT.address });
  });
});

describe('reading x402 offers', () => {
  const v1 = { x402Version: 1, error: 'payment required', accepts: [{ scheme: 'exact', network: 'near-testnet', maxAmountRequired: '1', payTo: 'a.testnet', asset: 'near' }] };
  const v2 = { x402Version: 2, resource: { url: 'http://x/weather', description: 'Hoan Kiem → My Dinh' }, accepts: [requirement()] };
  const response402 = (body, headers = {}) => new Response(JSON.stringify(body), { status: 402, headers });

  test('the PAYMENT-REQUIRED header wins over the body; a v1 body works alone', async () => {
    assert.deepEqual(await readPaymentRequired(response402(v1, { 'PAYMENT-REQUIRED': encodePayment(v2) })), v2);
    assert.deepEqual(await readPaymentRequired(response402(v1)), v1);
    const { x402Version, ...unversioned } = v1;
    assert.equal((await readPaymentRequired(response402(unversioned))).x402Version, 1);
    await assert.rejects(readPaymentRequired(response402({ error: 'nope' }), 'http://x'), /without an x402 offer/);
    await assert.rejects(readPaymentRequired(response402(v1, { 'PAYMENT-REQUIRED': '%%%' }), 'http://x'), /unreadable PAYMENT-REQUIRED header/);
  });

  test('headers are standard base64 of UTF-8 JSON, padded', () => {
    const header = encodePayment(v2);
    assert.match(header, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.equal(header, Buffer.from(JSON.stringify(v2), 'utf8').toString('base64'));
    assert.deepEqual(decodePayment(header), v2);
  });

  test('CAIP-2 ids map to the network names policies use, and token contracts to assets', () => {
    assert.equal(networkName('eip155:5042002'), 'arc-testnet');
    assert.equal(networkName('eip155:5042'), 'arc');
    assert.equal(networkName('near-testnet'), 'near-testnet');
    assert.equal(caip2('arc-testnet'), ARC);
    assert.equal(caip2('eip155:1'), 'eip155:1');
    assert.equal(assetKey(ARC, ARC_USDC), 'usdc');
    assert.equal(assetKey('arc-testnet', ARC_USDC), 'usdc');
    assert.equal(assetKey(ARC, OTHER_TOKEN), null);
    assert.equal(assetKey('near-testnet', 'near'), 'near');
  });

  test('only exact EIP-3009 offers in known tokens on the guard networks are picked', () => {
    const arc = requirement();
    const skipped = [
      requirement({ extra: { ...ARC_USDC_DOMAIN, assetTransferMethod: 'permit2' } }),
      requirement({ extra: { ...ARC_USDC_DOMAIN, paymentFlow: 'escrow' } }),
      requirement({ scheme: 'upto' }),
      requirement({ asset: OTHER_TOKEN }),
      requirement({ network: 'eip155:5042' }),
      requirement({ extra: undefined }),
      requirement({ extra: { name: 'USDC' } }),
    ];
    assert.equal(pickRequirement([...skipped, arc], ['arc-testnet'], 2), arc);
    assert.equal(pickRequirement(skipped, ['arc-testnet'], 2), null);
    // A v1 paywall may check a plain transfer instead, as the demo's does.
    assert.equal(pickRequirement([requirement({ extra: undefined })], ['arc-testnet'], 1)?.network, ARC);
  });

  test('a v2 offer without the token\'s EIP-712 domain is refused before anything is signed or sent', async () => {
    for (const extra of [undefined, {}, { name: 'USDC' }]) {
      const offered = { ...v2, accepts: [{ ...requirement(), extra }] };
      const sent = [];
      const fakeFetch = async (url, init) => (sent.push(new Headers(init?.headers)), response402({}, { 'PAYMENT-REQUIRED': encodePayment(offered) }));
      const rail = railCountingSignatures();
      const guard = guardFor('x', rail);
      await assert.rejects(payingFetch(guard, 'http://x/weather', {}, { fetch: fakeFetch }), /asks for exact 0x3600.* without its EIP-712 domain on arc-testnet/);
      assert.equal(rail.signed, 0, `extra: ${JSON.stringify(extra)}`);
      assert.equal(sent.length, 1, 'no PAYMENT-SIGNATURE was sent');
      assert.equal(guard.ledger.entries.length, 0);
    }
  });

  test('a Circle Gateway offer goes to the Gateway rail, never to the token\'s own EIP-3009', async () => {
    const gateway = gatewayOffer({ payTo: PAYEES.weather, amount: 10_000n });
    const arc = railCountingSignatures();
    const both = new Guard({ policy: { networks: ['arc-testnet', 'arc-testnet-gateway'] }, rails: [arc, new GatewayRail({ privateKey: KEY, client: {} })] });
    assert.equal(pickOffer({ x402Version: 2, accepts: [gateway, requirement()] }, both).network, 'arc-testnet-gateway');
    assert.equal(pickOffer({ x402Version: 2, accepts: [requirement(), gateway] }, both).network, 'arc-testnet', 'the server\'s order still decides');
    // Its domain names the Gateway Wallet, not the token: the Arc rail must not sign it at all.
    assert.equal(pickRequirement([gateway], ['arc-testnet'], 2), null);
    const guard = guardFor('x', arc);
    const fakeFetch = async () => response402({}, { 'PAYMENT-REQUIRED': encodePayment({ ...v2, accepts: [gateway] }) });
    await assert.rejects(payingFetch(guard, 'http://x/weather', {}, { fetch: fakeFetch }), /this guard pays the exact scheme in known tokens only/);
    assert.equal(arc.signed, 0);
    assert.equal(guard.ledger.entries.length, 0);
  });

  test('an offer the guard cannot pay says why, before the guard is asked', async () => {
    const permit2 = { ...v2, accepts: [requirement({ extra: { ...ARC_USDC_DOMAIN, assetTransferMethod: 'permit2' } })] };
    const fakeFetch = async () => response402({}, { 'PAYMENT-REQUIRED': encodePayment(permit2) });
    const rail = railCountingSignatures();
    const guard = guardFor('x', rail);
    await assert.rejects(payingFetch(guard, 'http://x/weather', {}, { fetch: fakeFetch }), /asks for exact 0x3600.* via permit2 on arc-testnet; this guard pays the exact scheme in known tokens only/);
    assert.equal(guard.ledger.entries.length, 0);
    assert.equal(rail.signed, 0);
  });
});
