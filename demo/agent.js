/**
 * A scripted agent run against the demo paywall: the same calls an LLM agent would make while
 * gathering data for a trip, so the guard's decisions can be shown without a model in the loop.
 *
 *   node demo/agent.js                 # starts its own paywall on a free port
 *   API=http://localhost:4402 node demo/agent.js
 */
import { createPaidApi, PAYEES } from './paid-api.js';
import { Guard, GuardRefused } from '../src/guard.js';
import { formatUsd } from '../src/money.js';
import { MockRail } from '../src/rails/mock.js';
import { payingFetch } from '../src/x402.js';

const PLAN = ['weather', 'news', 'quotes', 'quotes', 'quotes', 'quotes', 'maps', 'maps', 'maps', 'weather'];

const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const red = color(31);
const yellow = color(33);
const dim = color(2);

let server;
let base = process.env.API;
if (!base) {
  server = createPaidApi();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

const guard = new Guard({
  policy: {
    networks: ['near-testnet'],
    dailyUsd: 1,
    perPaymentUsd: 0.5,
    askAboveUsd: 0.25,
    spikeRatio: 5,
    services: { [new URL(base).host]: { payTo: [PAYEES.weather, PAYEES.news, PAYEES.quotes, PAYEES.maps] } },
  },
  rails: [new MockRail('near-testnet')],
  approve: async (intent, verdict) => {
    console.log(yellow(`  ? asks you: ${verdict.reasons.map((r) => r.message).join('; ')} → no`));
    return false;
  },
});

for (const name of PLAN) {
  const url = `${base}/${name}`;
  try {
    const res = await payingFetch(guard, url);
    const paid = guard.ledger.entries.at(-1);
    console.log(`${green('✓ paid')} ${formatUsd(paid.usd).padEnd(7)} /${name.padEnd(8)} ${dim(JSON.stringify(await res.json()))}`);
  } catch (err) {
    if (!(err instanceof GuardRefused)) throw err;
    console.log(`${red(`✗ ${err.status}`)} /${name.padEnd(8)} ${err.reasons.map((r) => r.message).join('; ')}`);
  }
}

console.log(dim(`\nspent today ${formatUsd(guard.ledger.spentToday(Date.now()))} of $1.00; ${guard.ledger.entries.filter((e) => e.status !== 'paid').length} payments stopped`));
server?.close();
