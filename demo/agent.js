/**
 * A scripted agent run against the demo paywall: the same calls an LLM agent would make while
 * gathering data for a trip, so the guard's decisions can be shown without a model in the loop.
 *
 *   node demo/agent.js                 # mock payments, offline
 *   node demo/agent.js --near          # real NEAR testnet transfers (needs .env, see scripts/)
 *   node demo/agent.js --near-guard    # NEAR testnet through the guard contract: the agent holds only
 *                                      # a function-call key for pay() (needs NEAR_GUARD_ID and
 *                                      # NEAR_GUARD_AGENT_KEY in .env, see scripts/near-guard-deploy.js)
 *   node demo/agent.js --arc           # real USDC transfers on Circle's Arc testnet (needs .env)
 *   node demo/agent.js --arc-x402      # x402 v2 'exact' on Arc: the agent only signs EIP-3009
 *                                      # authorizations; the paywall settles them and pays the gas
 *                                      # (needs ARC_FACILITATOR_PRIVATE_KEY, see scripts/arc-facilitator.js)
 *   node demo/agent.js --gateway       # Circle Gateway nanopayments on Arc testnet (needs .env and a
 *                                      # Gateway deposit, see scripts/gateway-deposit.js)
 *   node demo/agent.js --dashboard     # also serves the live page on 127.0.0.1, port DASHBOARD_PORT
 *                                      # (default 4400, or a free one when it is taken), paces the
 *                                      # calls for watching, and stays up until Ctrl+C;
 *                                      # a flagged payment waits there for Approve or Deny
 *                                      # (declined after APPROVAL_TIMEOUT seconds, default 120)
 */
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWalletClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createDashboard, listenLocal } from './dashboard.js';
import { createGatewaySeller } from './gateway-seller.js';
import { createPaidApi, PAYEES } from './paid-api.js';
import { Approvals } from '../src/approval.js';
import { Guard, GuardRefused } from '../src/guard.js';
import { formatUsd } from '../src/money.js';
import { ARC_USDC, ArcRail, arcTestnet, checkArcPayment } from '../src/rails/arc.js';
import { GatewayRail, gatewayTransferUrl } from '../src/rails/gateway.js';
import { MockRail } from '../src/rails/mock.js';
import { checkNearPayment, formatNear, NearGuardRail, NearRail } from '../src/rails/near.js';
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
  if (mode === 'near' || mode === 'near-guard') {
    const rail = mode === 'near'
      ? new NearRail({ accountId: env.NEAR_ACCOUNT_ID, privateKey: env.NEAR_PRIVATE_KEY, network: 'near-testnet' })
      : new NearGuardRail({ guardId: env.NEAR_GUARD_ID, privateKey: env.NEAR_GUARD_AGENT_KEY, network: 'near-testnet' });
    const payees = { weather: env.PAYEE_WEATHER, news: env.PAYEE_NEWS, quotes: env.PAYEE_QUOTES, maps: env.PAYEE_MAPS, thief: env.PAYEE_THIEF };
    const who = mode === 'near' ? 'agent account' : 'guard contract';
    return {
      rail, payees,
      label: mode === 'near' ? `${rail.accountId} · NEAR testnet` : `${rail.guardId} · NEAR testnet · guard contract, function-call key for pay() only`,
      paywall: createPaidApi({ network: 'near-testnet', asset: 'near', payees, verify: (p, e) => checkNearPayment(rail.provider, p, e) }),
      explorer: (txid) => `https://testnet.nearblocks.io/txns/${txid}`,
      balance: () => rail.balance(),
      // What left the account beyond the payments is gas (with the guard contract, the agent key's
      // gas is charged to the guard's account too).
      showBalance: (before, after, paid) => `${who} ${formatNear(before)} → ${formatNear(after)} NEAR (${formatNear(after - before)}: ${formatNear(paid)} paid, ${formatNear(before - after - paid)} gas)`,
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
      // USDC has 6 decimals, so atomic units are micro-dollars. With x402 exact the difference is
      // the payments alone: the paywall paid the gas.
      showBalance: (before, after) => `agent wallet ${formatUsd(before)} → ${formatUsd(after)} USDC (${formatUsd(after - before)})`,
    };
  }
  if (mode === 'gateway') {
    const rail = new GatewayRail({ privateKey: env.ARC_PRIVATE_KEY });
    const payees = { weather: env.ARC_PAYEE_WEATHER, news: env.ARC_PAYEE_NEWS, quotes: env.ARC_PAYEE_QUOTES, maps: env.ARC_PAYEE_MAPS, thief: env.ARC_PAYEE_THIEF };
    return {
      rail, payees, label: `${rail.address} · Circle Gateway on Arc testnet (USDC)`,
      paywall: createGatewaySeller({ payees }),
      // A receipt's txid is the authorization nonce; Gateway's page for it shows the batch tx once settled.
      explorer: gatewayTransferUrl,
    };
  }
  return { rail: new MockRail('near-testnet'), payees: PAYEES, label: 'mock payments · offline', paywall: createPaidApi(), explorer: undefined };
}

const mode = ['near-guard', 'near', 'arc-x402', 'arc', 'gateway'].find((m) => process.argv.includes(`--${m}`)) ?? 'mock';
const { rail, payees, label, paywall, explorer, balance, showBalance } = setUp(mode);
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
  const wanted = Number(process.env.DASHBOARD_PORT ?? 4400);
  dashboard = createDashboard(guard, { account: label, explorer, approvals });
  const port = await listenLocal(dashboard, wanted);
  if (wanted && port !== wanted) console.log(dim(`port ${wanted} is taken, so the dashboard takes a free one`));
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
  const after = await balance();
  const paid = guard.ledger.entries.filter((e) => e.status === 'paid').reduce((sum, e) => sum + e.intent.amount, 0n);
  console.log(dim(showBalance(before, after, paid)));
}
paywall.close();
if (dashboard) console.log(dim('dashboard stays up; Ctrl+C to stop'));
