/**
 * A scripted agent run against the demo paywall: the same calls an LLM agent would make while
 * gathering data for a trip, so the guard's decisions can be shown without a model in the loop.
 *
 *   node demo/agent.js                 # mock payments, offline
 *   node demo/agent.js --near          # real NEAR testnet transfers (needs .env, see scripts/)
 *   node demo/agent.js --arc           # real USDC transfers on Circle's Arc testnet (needs .env)
 *   node demo/agent.js --dashboard     # also serves the live page on DASHBOARD_PORT (default 4400),
 *                                      # paces the calls for watching, and stays up until Ctrl+C;
 *                                      # a flagged payment waits there for Approve or Deny
 *                                      # (declined after APPROVAL_TIMEOUT seconds, default 120)
 */
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDashboard } from './dashboard.js';
import { createPaidApi, PAYEES } from './paid-api.js';
import { Approvals } from '../src/approval.js';
import { Guard, GuardRefused } from '../src/guard.js';
import { formatUsd } from '../src/money.js';
import { ArcRail, checkArcPayment } from '../src/rails/arc.js';
import { MockRail } from '../src/rails/mock.js';
import { checkNearPayment, NearRail } from '../src/rails/near.js';
import { payingFetch } from '../src/x402.js';

const PLAN = ['weather', 'news', 'quotes', 'quotes', 'quotes', 'quotes', 'maps', 'maps', 'maps', 'weather', 'report'];

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
  if (mode === 'arc') {
    const rail = new ArcRail({ privateKey: env.ARC_PRIVATE_KEY });
    const payees = { weather: env.ARC_PAYEE_WEATHER, news: env.ARC_PAYEE_NEWS, quotes: env.ARC_PAYEE_QUOTES, maps: env.ARC_PAYEE_MAPS, thief: env.ARC_PAYEE_THIEF };
    return {
      rail, payees, label: `${rail.address} · Arc testnet (USDC)`,
      paywall: createPaidApi({ network: 'arc-testnet', asset: 'usdc', payees, verify: (p, e) => checkArcPayment(rail.publicClient, p, e) }),
      explorer: (txid) => `https://testnet.arcscan.app/tx/${txid}`,
    };
  }
  return { rail: new MockRail('near-testnet'), payees: PAYEES, label: 'mock payments · offline', paywall: createPaidApi(), explorer: undefined };
}

const mode = process.argv.includes('--near') ? 'near' : process.argv.includes('--arc') ? 'arc' : 'mock';
const { rail, payees, label, paywall, explorer } = setUp(mode);
await new Promise((resolve) => paywall.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${paywall.address().port}`;

const withDashboard = process.argv.includes('--dashboard');
// With the dashboard a flagged payment waits for a click there; without it the demo answers no.
const approvals = withDashboard ? new Approvals({ timeoutMs: Number(process.env.APPROVAL_TIMEOUT ?? 120) * 1000 }) : null;

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
    const why = verdict.reasons.map((r) => r.message).join('; ');
    if (!approvals) {
      console.log(yellow(`  ? asks you: ${why} → no`));
      return false;
    }
    console.log(yellow(`  ? waiting for your answer on the dashboard: ${why}`));
    return approvals.ask(intent, verdict);
  },
});

let dashboard;
if (withDashboard) {
  const port = Number(process.env.DASHBOARD_PORT ?? 4400);
  dashboard = createDashboard(guard, { account: label, explorer, approvals });
  await new Promise((resolve) => dashboard.listen(port, resolve));
  console.log(`dashboard on http://localhost:${port}; starting in 3s`);
  await sleep(3000);
}

if (mode !== 'mock') console.log(dim(`agent ${label}\n`));
for (const name of PLAN) {
  if (withDashboard) await sleep(1200);
  try {
    const res = await payingFetch(guard, `${base}/${name}`);
    const paid = guard.ledger.entries.at(-1);
    const tx = explorer ? dim(` ${explorer(paid.receipt.txid)}`) : '';
    console.log(`${green('✓ paid')} ${formatUsd(paid.usd).padEnd(7)} /${name.padEnd(8)} ${dim(JSON.stringify(await res.json()))}${tx}`);
  } catch (err) {
    if (!(err instanceof GuardRefused)) throw err;
    console.log(`${red(`✗ ${err.status}`)} /${name.padEnd(8)} ${err.reasons.map((r) => r.message).join('; ')}`);
  }
}

console.log(dim(`\nspent today ${formatUsd(guard.ledger.spentToday(Date.now()))} of $1.00; ${guard.ledger.entries.filter((e) => e.status !== 'paid').length} payments stopped`));
paywall.close();
if (dashboard) console.log(dim('dashboard stays up; Ctrl+C to stop'));
