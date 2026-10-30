/**
 * A scripted agent run against the demo paywall: the same calls an LLM agent would make while
 * gathering data for a trip, so the guard's decisions can be shown without a model in the loop.
 *
 *   node demo/agent.js                 # mock payments, offline
 *   node demo/agent.js --near          # real NEAR testnet transfers (needs .env, see scripts/)
 *   node demo/agent.js --arc           # real USDC transfers on Circle's Arc testnet (needs .env)
 *   node demo/agent.js --arc-x402      # x402 v2 'exact' on Arc: the agent only signs EIP-3009
 *                                      # authorizations; the paywall settles them and pays the gas
 *                                      # (needs ARC_FACILITATOR_PRIVATE_KEY, see scripts/arc-facilitator.js)
 *   node demo/agent.js --dashboard     # also serves the live page on DASHBOARD_PORT (default 4400),
 *                                      # paces the calls for watching, and stays up until Ctrl+C
 */
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWalletClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createDashboard } from './dashboard.js';
import { createPaidApi, PAYEES } from './paid-api.js';
import { Guard, GuardRefused } from '../src/guard.js';
import { formatUsd } from '../src/money.js';
import { ARC_USDC, ArcRail, arcTestnet, checkArcPayment } from '../src/rails/arc.js';
import { MockRail } from '../src/rails/mock.js';
import { checkNearPayment, NearRail } from '../src/rails/near.js';
import { payingFetch } from '../src/x402.js';

const PLAN = ['weather', 'news', 'quotes', 'quotes', 'quotes', 'quotes', 'maps', 'maps', 'maps', 'weather'];

const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const red = color(31);
const yellow = color(33);
const dim = color(2);

/** The rail, the paywall it pays, and how to show its transactions, per chain. */
function setUp(mode) {
  if (mode !== 'mock' && existsSync('.env')) process.loadEnvFile('.env');
  const env = process.env;
  if (mode === 'near') {
    const rail = new NearRail({ accountId: env.NEAR_ACCOUNT_ID, privateKey: env.NEAR_PRIVATE_KEY, network: 'near-testnet' });
    const payees = { weather: env.PAYEE_WEATHER, news: env.PAYEE_NEWS, quotes: env.PAYEE_QUOTES, maps: env.PAYEE_MAPS, thief: env.PAYEE_THIEF };
    return {
      rail, payees, label: `${rail.accountId} · NEAR testnet`,
      paywall: createPaidApi({ network: 'near-testnet', asset: 'near', payees, verify: (p, e) => checkNearPayment(rail.provider, p, e) }),
      explorer: (txid) => `https://testnet.nearblocks.io/txns/${txid}`,
    };
  }
  if (mode === 'arc' || mode === 'arc-x402') {
    const rail = new ArcRail({ privateKey: env.ARC_PRIVATE_KEY });
    const payees = { weather: env.ARC_PAYEE_WEATHER, news: env.ARC_PAYEE_NEWS, quotes: env.ARC_PAYEE_QUOTES, maps: env.ARC_PAYEE_MAPS, thief: env.ARC_PAYEE_THIEF };
    let exact;
    if (mode === 'arc-x402') {
      if (!env.ARC_FACILITATOR_PRIVATE_KEY) throw new Error('no ARC_FACILITATOR_PRIVATE_KEY in .env; run node scripts/arc-facilitator.js');
      // The paywall's own key: it submits the agent's authorizations and pays their gas.
      const walletClient = createWalletClient({ account: privateKeyToAccount(env.ARC_FACILITATOR_PRIVATE_KEY), chain: arcTestnet, transport: http() });
      exact = { publicClient: rail.publicClient, walletClient };
    }
    return {
      rail, payees, label: `${rail.address} · Arc testnet (USDC)${exact ? ' · x402 v2 exact, EIP-3009' : ''}`,
      paywall: createPaidApi({ network: 'arc-testnet', asset: 'usdc', payees, verify: (p, e) => checkArcPayment(rail.publicClient, p, e), exact }),
      explorer: (txid) => `https://testnet.arcscan.app/tx/${txid}`,
      balance: () => rail.publicClient.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [rail.address] }),
    };
  }
  return { rail: new MockRail('near-testnet'), payees: PAYEES, label: 'mock payments · offline', paywall: createPaidApi(), explorer: undefined };
}

const mode = process.argv.includes('--near') ? 'near' : process.argv.includes('--arc-x402') ? 'arc-x402' : process.argv.includes('--arc') ? 'arc' : 'mock';
const { rail, payees, label, paywall, explorer, balance } = setUp(mode);
await new Promise((resolve) => paywall.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${paywall.address().port}`;

const guard = new Guard({
  policy: {
    networks: [rail.network],
    dailyUsd: 1,
    perPaymentUsd: 0.5,
    askAboveUsd: 0.25,
    spikeRatio: 5,
    services: { [new URL(base).host]: { payTo: [payees.weather, payees.news, payees.quotes, payees.maps] } },
  },
  rails: [rail],
  approve: async (intent, verdict) => {
    console.log(yellow(`  ? asks you: ${verdict.reasons.map((r) => r.message).join('; ')} → no`));
    return false;
  },
});

const withDashboard = process.argv.includes('--dashboard');
let dashboard;
if (withDashboard) {
  const port = Number(process.env.DASHBOARD_PORT ?? 4400);
  dashboard = createDashboard(guard, { account: label, explorer });
  await new Promise((resolve) => dashboard.listen(port, resolve));
  console.log(`dashboard on http://localhost:${port}; starting in 3s`);
  await sleep(3000);
}

if (mode !== 'mock') console.log(dim(`agent ${label}\n`));
const before = await balance?.();
for (const name of PLAN) {
  if (withDashboard) await sleep(1200);
  try {
    const res = await payingFetch(guard, `${base}/${name}`);
    const paid = guard.ledger.entries.at(-1);
    if (!res.ok) {
      // Signed but not delivered: the signature still counts against the budget until it expires.
      console.log(`${red(`✗ ${res.status}`)}    /${name.padEnd(8)} ${paid.receipt.settlement?.errorReason ?? (await res.text())}`);
      continue;
    }
    const tx = explorer && paid.receipt.txid ? dim(` ${explorer(paid.receipt.txid)}`) : '';
    console.log(`${green('✓ paid')} ${formatUsd(paid.usd).padEnd(7)} /${name.padEnd(8)} ${dim(JSON.stringify(await res.json()))}${tx}`);
  } catch (err) {
    if (!(err instanceof GuardRefused)) throw err;
    console.log(`${red(`✗ ${err.status}`)} /${name.padEnd(8)} ${err.reasons.map((r) => r.message).join('; ')}`);
  }
}

console.log(dim(`\nspent today ${formatUsd(guard.ledger.spentToday(Date.now()))} of $1.00; ${guard.ledger.entries.filter((e) => e.status !== 'paid').length} payments stopped`));
if (balance) {
  // USDC has 6 decimals, so atomic units are micro-dollars. With x402 exact the difference is the
  // payments alone: the paywall paid the gas.
  const after = await balance();
  console.log(dim(`agent wallet ${formatUsd(before)} → ${formatUsd(after)} USDC (${formatUsd(after - before)})`));
}
paywall.close();
if (dashboard) console.log(dim('dashboard stays up; Ctrl+C to stop'));
