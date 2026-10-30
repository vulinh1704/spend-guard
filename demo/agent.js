/**
 * A scripted agent run against the demo paywall: the same calls an LLM agent would make while
 * gathering data for a trip, so the guard's decisions can be shown without a model in the loop.
 *
 *   node demo/agent.js                 # mock payments, offline
 *   node demo/agent.js --near          # real NEAR testnet transfers (needs .env, see scripts/)
 *   node demo/agent.js --dashboard     # also serves the live page on DASHBOARD_PORT (default 4400),
 *                                      # paces the calls for watching, and stays up until Ctrl+C
 */
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDashboard } from './dashboard.js';
import { createPaidApi, PAYEES } from './paid-api.js';
import { Guard, GuardRefused } from '../src/guard.js';
import { formatUsd } from '../src/money.js';
import { MockRail } from '../src/rails/mock.js';
import { checkNearPayment, NearRail } from '../src/rails/near.js';
import { payingFetch } from '../src/x402.js';

const PLAN = ['weather', 'news', 'quotes', 'quotes', 'quotes', 'quotes', 'maps', 'maps', 'maps', 'weather'];

const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const red = color(31);
const yellow = color(33);
const dim = color(2);

const near = process.argv.includes('--near');
let rail;
let paywall;
let payees = PAYEES;
if (near) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = process.env;
  rail = new NearRail({ accountId: env.NEAR_ACCOUNT_ID, privateKey: env.NEAR_PRIVATE_KEY, network: 'near-testnet' });
  payees = { weather: env.PAYEE_WEATHER, news: env.PAYEE_NEWS, quotes: env.PAYEE_QUOTES, maps: env.PAYEE_MAPS, thief: env.PAYEE_THIEF };
  paywall = createPaidApi({ network: 'near-testnet', asset: 'near', payees, verify: (payload, expected) => checkNearPayment(rail.provider, payload, expected) });
} else {
  rail = new MockRail('near-testnet');
  paywall = createPaidApi();
}
await new Promise((resolve) => paywall.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${paywall.address().port}`;

const guard = new Guard({
  policy: {
    networks: ['near-testnet'],
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
  dashboard = createDashboard(guard, {
    account: near ? `${rail.accountId} · NEAR testnet` : 'mock payments · offline',
    explorer: near ? (txid) => `https://testnet.nearblocks.io/txns/${txid}` : undefined,
  });
  await new Promise((resolve) => dashboard.listen(port, resolve));
  console.log(`dashboard on http://localhost:${port}; starting in 3s`);
  await sleep(3000);
}

if (near) console.log(dim(`agent ${rail.accountId} paying on NEAR testnet\n`));
for (const name of PLAN) {
  if (withDashboard) await sleep(1200);
  try {
    const res = await payingFetch(guard, `${base}/${name}`);
    const paid = guard.ledger.entries.at(-1);
    const tx = near ? dim(` https://testnet.nearblocks.io/txns/${paid.receipt.txid}`) : '';
    console.log(`${green('✓ paid')} ${formatUsd(paid.usd).padEnd(7)} /${name.padEnd(8)} ${dim(JSON.stringify(await res.json()))}${tx}`);
  } catch (err) {
    if (!(err instanceof GuardRefused)) throw err;
    console.log(`${red(`✗ ${err.status}`)} /${name.padEnd(8)} ${err.reasons.map((r) => r.message).join('; ')}`);
  }
}

console.log(dim(`\nspent today ${formatUsd(guard.ledger.spentToday(Date.now()))} of $1.00; ${guard.ledger.entries.filter((e) => e.status !== 'paid').length} payments stopped`));
paywall.close();
if (dashboard) console.log(dim('dashboard stays up; Ctrl+C to stop'));
