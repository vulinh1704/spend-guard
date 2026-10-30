#!/usr/bin/env node
import { createDashboard } from '../demo/dashboard.js';
import { Approvals } from '../src/approval.js';
import { guardFromEnv, serveMcp, toolRunner, VERSION } from '../src/mcp.js';

const HELP = `spend-guard ${VERSION}: a spending guard for AI agents that pay x402 paywalls

Usage:
  spend-guard mcp          serve the guard to an MCP client over stdio
  spend-guard --version

The agent gets pay_and_fetch, spending_status and spending_policy. Payments the policy flags
wait for you on the dashboard (http://127.0.0.1:4400) with Approve and Deny buttons.

Environment:
  SPEND_GUARD_POLICY            policy JSON file (default: no known services, so every payment asks you)
  SPEND_GUARD_RAILS             mock (default, pays nothing), near, arc, or a comma list
  SPEND_GUARD_MOCK_NETWORK      network the mock rail pretends to pay on (default near-testnet)
  SPEND_GUARD_LEDGER            decisions file, read back on start; servers on one file share one budget
                                (default ~/.spend-guard/ledger.jsonl; off keeps it in memory)
  SPEND_GUARD_DASHBOARD_PORT    dashboard port on 127.0.0.1 (default 4400; 0 picks a free one; off: no
                                dashboard, and payments that need your approval are declined)
  SPEND_GUARD_APPROVAL_TIMEOUT  seconds a payment waits for your answer before it is declined (default 55:
                                many MCP clients give up on a tool call after 60s, and a call the client
                                gives up on is withdrawn, so raise both together)
  NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY, ARC_PRIVATE_KEY   rail keys; testnet keys only

For example, in Claude Code:
  claude mcp add spend-guard --env SPEND_GUARD_POLICY=/abs/path/policy.json -- node /abs/path/spend-guard/bin/spend-guard.js mcp
`;

const EXPLORERS = {
  'arc-testnet': (tx) => `https://testnet.arcscan.app/tx/${tx}`,
  'near-testnet': (tx) => `https://testnet.nearblocks.io/txns/${tx}`,
};

async function main([cmd, ...rest]) {
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '-v' || cmd === '--version' || cmd === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (cmd !== 'mcp') {
    process.stderr.write(`spend-guard: unknown command "${cmd}"\n\n${HELP}`);
    return 2;
  }
  if (rest.length) {
    process.stderr.write(`spend-guard: mcp takes no arguments (got "${rest[0]}"); it is set up through the environment\n`);
    return 2;
  }
  // stdout carries the protocol: anything else printed there would corrupt it.
  console.log = console.error;
  await mcp(process.env);
  return 0;
}

async function mcp(env) {
  const timeout = Number(env.SPEND_GUARD_APPROVAL_TIMEOUT ?? 55);
  if (!(timeout > 0)) throw new Error('SPEND_GUARD_APPROVAL_TIMEOUT must be a number of seconds above 0');
  const port = env.SPEND_GUARD_DASHBOARD_PORT ?? '4400';
  const approvals = port === 'off' ? null : new Approvals({ timeoutMs: timeout * 1000 });
  const guard = await guardFromEnv(env, { approve: approvals?.ask });

  let dashboard;
  let dashboardUrl;
  if (approvals) {
    const account = [...guard.rails.values()].map((r) => (r.accountId ?? r.address ? `${r.accountId ?? r.address} · ${r.network}` : `${r.network} · mock`)).join(' + ');
    dashboard = createDashboard(guard, { approvals, account, explorer: (tx, network) => EXPLORERS[network]?.(tx) ?? null });
    dashboardUrl = `http://127.0.0.1:${await listen(dashboard, Number(port))}`;
    console.error(`spend-guard: approve payments on ${dashboardUrl}`);
  }

  // When the client goes away, anything still waiting is declined, so the process can exit.
  const stop = () => {
    approvals?.close();
    dashboard?.closeAllConnections();
    dashboard?.close();
  };
  process.stdin.once('end', stop);
  await serveMcp({ run: toolRunner({ guard, approvals, dashboardUrl }), dashboardUrl });
  stop();
}

/** Listen on 127.0.0.1; when the port is taken (say a second client runs the server), on a free one. */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE' || port === 0) return reject(err);
      console.error(`spend-guard: port ${port} is taken, so the dashboard takes a free one`);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`spend-guard: ${err?.message ?? err}\n`);
    process.exitCode = 2;
  },
);
