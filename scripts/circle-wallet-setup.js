/**
 * Sets up the Circle developer-controlled wallet the agent pays from on Arc testnet, so the agent
 * never holds a private key. Needs CIRCLE_API_KEY (a TEST_API_KEY) and CIRCLE_ENTITY_SECRET in .env,
 * which only you can create (docs/circle-wallets.md). Creates a wallet set and one EOA wallet,
 * appends the non-secret CIRCLE_WALLET_SET_ID, CIRCLE_WALLET_ID and CIRCLE_WALLET_ADDRESS to .env
 * and prints the wallet; run it again to see the wallet and its balance. Needs Node 22+.
 *
 *   node scripts/circle-wallet-setup.js            # create the wallet, or show it
 *   node scripts/circle-wallet-setup.js --faucet   # also ask Circle's testnet faucet for USDC
 *   node scripts/circle-wallet-setup.js --fund 2   # also send 2 test USDC from the Arc agent key (ARC_PRIVATE_KEY)
 *   node scripts/circle-wallet-setup.js --sign     # Circle signs a test authorization; USDC checks it (eth_call, nothing sent)
 *   node scripts/circle-wallet-setup.js --pay      # pay the demo paywall's /weather once, through the guard
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { createPublicClient, http, parseUnits } from 'viem';
import { createPaidApi } from '../demo/paid-api.js';
import { Guard } from '../src/guard.js';
import { ARC_USDC, ArcRail, arcTestnet, checkArcPayment } from '../src/rails/arc.js';
import { CircleWalletRail, circleClientFromEnv, circleWalletRailFromEnv, TRANSFER_WITH_AUTHORIZATION } from '../src/rails/circle-wallet.js';
import { payingFetch } from '../src/x402.js';

/** USDC's EIP-3009 entry point, the overload that takes the signature as bytes. */
const TRANSFER_WITH_AUTHORIZATION_ABI = [{
  type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', outputs: [],
  inputs: [...TRANSFER_WITH_AUTHORIZATION, { name: 'signature', type: 'bytes' }],
}];
const explorer = (path) => `https://testnet.arcscan.app/${path}`;

if (existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
const args = process.argv.slice(2);

/** Appends non-secret settings to .env (git-ignored) and to this run's environment. */
function remember(values) {
  const text = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  appendFileSync('.env', (text && !text.endsWith('\n') ? '\n' : '') + Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  chmodSync('.env', 0o600);
  Object.assign(env, values);
}

try {
  const client = await circleClientFromEnv(env);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

  if (!env.CIRCLE_WALLET_ID) {
    // Saved one step at a time, so a rerun after a failure reuses the set instead of making another.
    if (!env.CIRCLE_WALLET_SET_ID) {
      const set = (await client.createWalletSet({ name: 'spend-guard', idempotencyKey: randomUUID() })).data?.walletSet;
      if (!set?.id) throw new Error('Circle created no wallet set');
      remember({ CIRCLE_WALLET_SET_ID: set.id });
    }
    // An EOA: USDC accepts its EIP-3009 signatures as they are, and it pays its own gas (USDC on Arc).
    const { wallets: [wallet] = [] } = (await client.createWallets({
      walletSetId: env.CIRCLE_WALLET_SET_ID, blockchains: ['ARC-TESTNET'], count: 1, accountType: 'EOA',
      metadata: [{ name: 'spend-guard agent', refId: 'spend-guard-agent' }], idempotencyKey: randomUUID(),
    })).data ?? {};
    if (!wallet?.id) throw new Error('Circle created no wallet');
    remember({ CIRCLE_WALLET_ID: wallet.id, CIRCLE_WALLET_ADDRESS: wallet.address });
    console.log(`created Circle wallet ${wallet.id} in wallet set ${env.CIRCLE_WALLET_SET_ID}; saved both to .env`);
  }

  const rail = await circleWalletRailFromEnv(env, { client });
  console.log(`Circle wallet ${rail.walletId}: ${rail.address} on Arc testnet\n  ${explorer(`address/${rail.address}`)}`);

  if (args.includes('--faucet')) {
    await client.requestTestnetTokens({ address: rail.address, blockchain: 'ARC-TESTNET', usdc: true });
    console.log('asked Circle\'s faucet for test USDC; it can take a minute to arrive');
  }

  if (args.includes('--fund')) {
    const fund = args[args.indexOf('--fund') + 1] ?? '';
    const amount = /^\d+(\.\d{1,6})?$/.test(fund) ? parseUnits(fund, 6) : 0n;
    if (!(amount > 0n && amount <= parseUnits('5', 6))) throw new Error('--fund takes an amount of test USDC above 0 and up to 5');
    if (!env.ARC_PRIVATE_KEY) throw new Error('--fund sends from ARC_PRIVATE_KEY; run node scripts/arc-testnet-wallet.js first');
    const from = new ArcRail({ privateKey: env.ARC_PRIVATE_KEY });
    const { txid } = await from.pay({ resource: 'circle-wallet-setup --fund', asset: 'usdc', amount, payTo: rail.address });
    console.log(`sent ${fund} test USDC from ${from.address}\n  ${explorer(`tx/${txid}`)}`);
  }

  const balances = (await client.getWalletTokenBalance({ id: rail.walletId, tokenAddresses: [ARC_USDC] })).data?.tokenBalances ?? [];
  console.log(`  balance by Circle: ${balances[0]?.amount ?? '0'} USDC`);

  if (args.includes('--sign')) {
    // A 0.000001 USDC authorization to the wallet itself: harmless if it ever leaked.
    const signer = new CircleWalletRail({ client, walletId: rail.walletId, address: rail.address, mode: 'authorization' });
    const { proof } = await signer.pay({ resource: 'circle-wallet-setup --sign', host: 'setup', network: 'arc-testnet', asset: 'usdc', amount: 1n, payTo: rail.address, description: 'test authorization, never settled' });
    const a = proof.authorization;
    try {
      // eth_call only: USDC runs every check (signature, nonce, expiry, balance) and nothing is sent.
      await publicClient.simulateContract({
        account: rail.address, address: ARC_USDC, abi: TRANSFER_WITH_AUTHORIZATION_ABI, functionName: 'transferWithAuthorization',
        args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, proof.signature],
      });
      console.log('Circle signed an EIP-3009 authorization and Arc USDC accepts it (simulated; nothing sent)');
    } catch (err) {
      // The balance is checked after the signature, so this revert still means the signature is good.
      if (!/exceeds balance/.test(err.shortMessage ?? err.message)) throw err;
      console.log('Circle\'s signature is valid on Arc USDC; the wallet has no USDC yet (--faucet or --fund)');
    }
  }

  if (args.includes('--pay')) {
    if (!env.ARC_PAYEE_WEATHER) throw new Error('--pay needs the demo payees; run node scripts/arc-testnet-wallet.js first');
    const payees = { weather: env.ARC_PAYEE_WEATHER };
    const paywall = createPaidApi({ network: 'arc-testnet', asset: 'usdc', payees, verify: (p, e) => checkArcPayment(publicClient, p, e) });
    await new Promise((resolve) => paywall.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${paywall.address().port}`;
    const guard = new Guard({
      policy: { networks: ['arc-testnet'], dailyUsd: 0.05, perPaymentUsd: 0.02, askAboveUsd: 0.02, services: { [new URL(base).host]: { payTo: [payees.weather] } } },
      rails: [rail],
    });
    try {
      const res = await payingFetch(guard, `${base}/weather`);
      const { receipt } = guard.ledger.entries.at(-1);
      console.log(`paid /weather through the guard: HTTP ${res.status} ${JSON.stringify(await res.json())}`);
      console.log(`  Circle transaction ${receipt.circle.transactionId}\n  ${explorer(`tx/${receipt.txid}`)}`);
    } finally {
      paywall.close();
    }
  }
} catch (err) {
  // Only the message and Circle's status and code: never dump the error object, the request is in there.
  console.error(`circle-wallet-setup: ${err.shortMessage ?? err.message}${err.status ? ` (HTTP ${err.status}, code ${err.code})` : ''}`);
  process.exitCode = 1;
}
