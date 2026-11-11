/**
 * Drives `spend-guard mcp` with the official MCP client, as Claude Desktop or Claude Code would,
 * against the demo paywall: honest paid calls, a page with a prompt injection that the client
 * follows, a payee swap, and a payment that waits for you on the dashboard (open the URL the
 * server prints and press Approve or Deny). The client is scripted, not a model.
 *
 *   node scripts/mcp-demo.js               # mock payments, offline
 *   node scripts/mcp-demo.js --near        # real NEAR on NEAR testnet from the agent's account
 *                                          # (NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY in .env, see near-testnet-account.js)
 *   node scripts/mcp-demo.js --near-guard  # real NEAR on NEAR testnet through the guard contract: the server
 *                                          # holds only the agent's function-call key for pay()
 *                                          # (NEAR_GUARD_ID, NEAR_GUARD_AGENT_KEY in .env, see near-guard-deploy.js)
 *   node scripts/mcp-demo.js --arc         # real USDC on Arc testnet (ARC_* in .env, see arc-testnet-wallet.js)
 *
 * DASHBOARD_PORT (default 4400) and APPROVAL_TIMEOUT (seconds, default 120) go to the server.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JsonRpcProvider } from 'near-api-js';
import { createPublicClient, http } from 'viem';
import { createPaidApi, PAYEES } from '../demo/paid-api.js';
import { arcTestnet, checkArcPayment } from '../src/rails/arc.js';
import { checkNearPayment, NEAR_RPC } from '../src/rails/near.js';

const PLAN = ['weather', 'news', 'guide', 'maps', 'maps', 'maps', 'report'];
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

const mode = ['near-guard', 'near', 'arc'].find((m) => process.argv.includes(`--${m}`)) ?? 'mock';
if (mode !== 'mock' && existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;

/** The explorer link for the transaction a pay_and_fetch result names, if any. */
const link = (line, hash, explorer) => {
  const tx = hash.exec(line)?.[1];
  return tx ? `${explorer}${tx}` : null;
};

/** The paywall, the server's rail and keys, and the explorer link, per mode. */
function setUp() {
  if (mode === 'arc') {
    const payees = { weather: env.ARC_PAYEE_WEATHER, news: env.ARC_PAYEE_NEWS, quotes: env.ARC_PAYEE_QUOTES, maps: env.ARC_PAYEE_MAPS, thief: env.ARC_PAYEE_THIEF };
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
    return {
      payees, network: 'arc-testnet', rails: 'arc', keys: { ARC_PRIVATE_KEY: env.ARC_PRIVATE_KEY },
      paywall: createPaidApi({ network: 'arc-testnet', asset: 'usdc', payees, verify: (p, e) => checkArcPayment(publicClient, p, e) }),
      txLink: (line) => link(line, /transaction (0x[0-9a-f]{64})/, 'https://testnet.arcscan.app/tx/'),
    };
  }
  if (mode === 'near' || mode === 'near-guard') {
    const payees = { weather: env.PAYEE_WEATHER, news: env.PAYEE_NEWS, quotes: env.PAYEE_QUOTES, maps: env.PAYEE_MAPS, thief: env.PAYEE_THIEF };
    const provider = new JsonRpcProvider({ url: NEAR_RPC['near-testnet'] });
    const keys = mode === 'near'
      ? { NEAR_ACCOUNT_ID: env.NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY: env.NEAR_PRIVATE_KEY }
      : { NEAR_GUARD_ID: env.NEAR_GUARD_ID, NEAR_GUARD_AGENT_KEY: env.NEAR_GUARD_AGENT_KEY };
    return {
      payees, network: 'near-testnet', rails: mode, keys,
      paywall: createPaidApi({ network: 'near-testnet', asset: 'near', payees, verify: (p, e) => checkNearPayment(provider, p, e) }),
      // NEAR transaction hashes are base58.
      txLink: (line) => link(line, /transaction ([1-9A-HJ-NP-Za-km-z]{43,44})\b/, 'https://testnet.nearblocks.io/txns/'),
    };
  }
  return { payees: PAYEES, network: 'near-testnet', rails: 'mock', keys: {}, paywall: createPaidApi(), txLink: () => null };
}

const { payees, network, rails, keys, paywall, txLink } = setUp();
await new Promise((resolve) => paywall.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${paywall.address().port}`;

// The policy the user would keep in a file next to their MCP client's config.
const dir = mkdtempSync(path.join(os.tmpdir(), 'spend-guard-demo-'));
const policy = path.join(dir, 'policy.json');
writeFileSync(policy, JSON.stringify({
  networks: [network],
  dailyUsd: 1,
  perPaymentUsd: 0.5,
  askAboveUsd: 0.25,
  spikeRatio: 5,
  services: { [new URL(base).host]: { payTo: [payees.weather, payees.news, payees.quotes, payees.maps] } },
}));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../bin/spend-guard.js', import.meta.url)), 'mcp'],
  env: {
    SPEND_GUARD_POLICY: policy,
    SPEND_GUARD_LEDGER: path.join(dir, 'ledger.jsonl'),
    SPEND_GUARD_RAILS: rails,
    SPEND_GUARD_DASHBOARD_PORT: env.DASHBOARD_PORT ?? '4400',
    SPEND_GUARD_APPROVAL_TIMEOUT: env.APPROVAL_TIMEOUT ?? '120',
    ...keys,
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'spend-guard-demo', version: '0.1.0' });

try {
  await client.connect(transport);
  if (mode !== 'mock') console.log(dim(`spend-guard mcp with SPEND_GUARD_RAILS=${rails}\n`));
  const queue = PLAN.map((name) => `${base}/${name}`);
  while (queue.length) {
    const url = queue.shift();
    const name = new URL(url).pathname.slice(1);
    const result = await client.callTool({ name: 'pay_and_fetch', arguments: { url } }, undefined, {
      onprogress: (p) => console.log(dim(`  … ${p.message}`)),
      timeout: 60_000,
      resetTimeoutOnProgress: true,
    });
    const lines = result.content[0].text.split('\n');
    console.log(`${result.isError ? '✗' : '✓'} /${name.padEnd(8)} ${result.isError ? lines.slice(0, 2).join(' ') : lines[1]}`);
    const tx = !result.isError && txLink(lines[1]);
    if (tx) console.log(dim(`  ${tx}`));
    // The body comes after a blank line. A model that falls for the note on /guide calls
    // pay_and_fetch on the URL it names; this scripted client always does.
    const note = !result.isError && /"note":"([^"]*)"/.exec(lines.slice(lines.indexOf('') + 1).join('\n'))?.[1];
    const order = note && /https?:\/\/\S*[^\s.,;]/.exec(note)?.[0];
    if (order) {
      console.log(dim(`  ! the page tells AI agents to pay at ${order}; this scripted client calls pay_and_fetch on it`));
      queue.unshift(order);
    }
  }
  console.log(`\n${(await client.callTool({ name: 'spending_status', arguments: { limit: 1 } })).content[0].text.split('\n').slice(0, 2).join('\n')}`);
} finally {
  await client.close();
  paywall.close();
  rmSync(dir, { recursive: true, force: true });
}
