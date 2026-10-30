/**
 * Drives `spend-guard mcp` with the official MCP client, as Claude Desktop or Claude Code would,
 * against the demo paywall: honest paid calls, a payee swap, and a payment that waits for you on
 * the dashboard (open the URL the server prints and press Approve or Deny).
 *
 *   node scripts/mcp-demo.js          # mock payments, offline
 *   node scripts/mcp-demo.js --arc    # real USDC on Arc testnet (ARC_* in .env, see arc-testnet-wallet.js)
 *
 * DASHBOARD_PORT (default 4400) and APPROVAL_TIMEOUT (seconds, default 120) go to the server.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPublicClient, http } from 'viem';
import { createPaidApi, PAYEES } from '../demo/paid-api.js';
import { arcTestnet, checkArcPayment } from '../src/rails/arc.js';

const PLAN = ['weather', 'news', 'maps', 'maps', 'maps', 'report'];
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

const arc = process.argv.includes('--arc');
if (arc && existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
const payees = arc
  ? { weather: env.ARC_PAYEE_WEATHER, news: env.ARC_PAYEE_NEWS, quotes: env.ARC_PAYEE_QUOTES, maps: env.ARC_PAYEE_MAPS, thief: env.ARC_PAYEE_THIEF }
  : PAYEES;
const publicClient = arc ? createPublicClient({ chain: arcTestnet, transport: http() }) : null;
const paywall = arc
  ? createPaidApi({ network: 'arc-testnet', asset: 'usdc', payees, verify: (p, e) => checkArcPayment(publicClient, p, e) })
  : createPaidApi();
await new Promise((resolve) => paywall.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${paywall.address().port}`;

// The policy the user would keep in a file next to their MCP client's config.
const dir = mkdtempSync(path.join(os.tmpdir(), 'spend-guard-demo-'));
const policy = path.join(dir, 'policy.json');
writeFileSync(policy, JSON.stringify({
  networks: [arc ? 'arc-testnet' : 'near-testnet'],
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
    SPEND_GUARD_RAILS: arc ? 'arc' : 'mock',
    SPEND_GUARD_DASHBOARD_PORT: env.DASHBOARD_PORT ?? '4400',
    SPEND_GUARD_APPROVAL_TIMEOUT: env.APPROVAL_TIMEOUT ?? '120',
    ...(arc ? { ARC_PRIVATE_KEY: env.ARC_PRIVATE_KEY } : {}),
  },
  stderr: 'inherit',
});
const client = new Client({ name: 'spend-guard-demo', version: '0.1.0' });

try {
  await client.connect(transport);
  for (const name of PLAN) {
    const result = await client.callTool({ name: 'pay_and_fetch', arguments: { url: `${base}/${name}` } }, undefined, {
      onprogress: (p) => console.log(dim(`  … ${p.message}`)),
      timeout: 60_000,
      resetTimeoutOnProgress: true,
    });
    const lines = result.content[0].text.split('\n');
    console.log(`${result.isError ? '✗' : '✓'} /${name.padEnd(8)} ${result.isError ? lines.slice(0, 2).join(' ') : lines[1]}`);
    const tx = arc && lines[1].match(/transaction (0x[0-9a-f]{64})/)?.[1];
    if (tx) console.log(dim(`  https://testnet.arcscan.app/tx/${tx}`));
  }
  console.log(`\n${(await client.callTool({ name: 'spending_status', arguments: { limit: 1 } })).content[0].text.split('\n').slice(0, 2).join('\n')}`);
} finally {
  await client.close();
  paywall.close();
  rmSync(dir, { recursive: true, force: true });
}
