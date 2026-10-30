/**
 * `spend-guard mcp`. The tool handlers run against the demo paywall with a mock rail, the
 * protocol is checked on in-memory streams, then the real server is driven end to end with the
 * official MCP TypeScript SDK client (a dev dependency only), approval on the dashboard included.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPaidApi, PAYEES } from '../demo/paid-api.js';
import { Approvals } from '../src/approval.js';
import { Guard, PaymentUnconfirmed } from '../src/guard.js';
import { guardFromEnv, loadLedger, PROTOCOL_VERSIONS, serveMcp, TOOLS, toolRunner } from '../src/mcp.js';
import { MockRail } from '../src/rails/mock.js';

const BIN = fileURLToPath(new URL('../bin/spend-guard.js', import.meta.url));
const KNOWN = [PAYEES.weather, PAYEES.news, PAYEES.quotes, PAYEES.maps];

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A fresh demo paywall (its endpoints count calls, so each test gets its own). */
async function paywall(t) {
  const server = createPaidApi();
  const base = await listen(server);
  t.after(() => server.close());
  return { base, host: new URL(base).host };
}

/** A paywall that asks $0.01 of every request, then answers the paid one with `paid(req, res)`. */
async function oddPaywall(t, paid) {
  const server = http.createServer((req, res) => {
    if (req.headers['x-payment']) return paid(req, res);
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'near-testnet', maxAmountRequired: '10000', payTo: PAYEES.weather, asset: 'usdc' }] }));
  });
  const base = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base, host: new URL(base).host };
}

function setUp(host, { approvals, dashboardUrl } = {}) {
  const rail = new MockRail('near-testnet');
  const guard = new Guard({
    policy: { networks: ['near-testnet'], dailyUsd: 1, perPaymentUsd: 0.5, askAboveUsd: 0.25, spikeRatio: 5, services: { [host]: { payTo: KNOWN } } },
    rails: [rail],
    approve: approvals?.ask,
  });
  return { rail, guard, run: toolRunner({ guard, approvals, dashboardUrl }) };
}

const textOf = (result) => result.content.map((c) => c.text).join('\n');

describe('mcp tools', () => {
  test('pay_and_fetch pays the paywall and returns the data', async (t) => {
    const { base, host } = await paywall(t);
    const { run, rail } = setUp(host);
    const result = await run('pay_and_fetch', { url: `${base}/weather` });
    assert.equal(result.isError, false);
    assert.match(textOf(result), /^HTTP 200 OK\nPaid \$0\.01 to weather\.paywall\.testnet on near-testnet, transaction [0-9a-f]{32}\./);
    assert.match(textOf(result), /content-type: application\/json\n\n\{"city":"Hanoi"/);
    assert.equal(rail.paid.length, 1);
  });

  test('a response without a paywall passes through unpaid', async (t) => {
    const { base, host } = await paywall(t);
    const { run, rail } = setUp(host);
    const text = textOf(await run('pay_and_fetch', { url: `${base}/nothing-here` }));
    assert.match(text, /^HTTP 404 Not Found\nNo payment was needed\./);
    assert.equal(rail.paid.length, 0);
  });

  test('a payee swap is refused, nothing is paid, and the agent is told not to work around it', async (t) => {
    const { base, host } = await paywall(t);
    const { run, rail } = setUp(host);
    for (let i = 0; i < 2; i++) await run('pay_and_fetch', { url: `${base}/maps` });
    const result = await run('pay_and_fetch', { url: `${base}/maps` });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Spend Guard refused this payment, so nothing was paid/);
    assert.match(textOf(result), /rnaps\.paywall\.testnet, which is not one of its known addresses/);
    assert.match(textOf(result), /Do not try to pay another way/);
    assert.ok(!rail.paid.some((p) => p.payTo === PAYEES.thief));
  });

  test('a payment above the approval amount waits for the human, and says so as progress', async (t) => {
    const { base, host } = await paywall(t);
    const approvals = new Approvals();
    const { run, rail } = setUp(host, { approvals, dashboardUrl: 'http://127.0.0.1:4400' });
    approvals.once('asked', (ask) => setImmediate(() => approvals.decide(ask.id, true)));
    const progress = [];
    const result = await run('pay_and_fetch', { url: `${base}/report` }, { progress: (m) => progress.push(m) });
    assert.match(progress[0], /^Waiting for the user to approve \$0\.30 to news\.paywall\.testnet at http:\/\/127\.0\.0\.1:4400$/);
    assert.match(textOf(result), /Paid \$0\.30 to news\.paywall\.testnet .*\(approved by the user\)\./);
    assert.equal(rail.paid.length, 1);
  });

  test('a payment the human denies is not asked for again', async (t) => {
    const { base, host } = await paywall(t);
    const approvals = new Approvals();
    const { run, rail } = setUp(host, { approvals });
    approvals.once('asked', (ask) => setImmediate(() => approvals.decide(ask.id, false)));
    const result = await run('pay_and_fetch', { url: `${base}/report` });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^The user declined this payment, so nothing was paid:\n- \$0\.30 is above the \$0\.25/);
    assert.equal(rail.paid.length, 0);
  });

  test('with no answer in time the payment is declined, and the agent learns where the user approves', async (t) => {
    const { base, host } = await paywall(t);
    const { run, rail } = setUp(host, { approvals: new Approvals({ timeoutMs: 20 }), dashboardUrl: 'http://127.0.0.1:4400' });
    const text = textOf(await run('pay_and_fetch', { url: `${base}/report` }));
    assert.match(text, /needs the user's approval and got no answer in time/);
    assert.match(text, /approve it at http:\/\/127\.0\.0\.1:4400 if you try again/);
    assert.equal(rail.paid.length, 0);
  });

  test('without a dashboard, payments that need approval are declined', async (t) => {
    const { base, host } = await paywall(t);
    const { run } = setUp(host);
    assert.match(textOf(await run('pay_and_fetch', { url: `${base}/report` })), /no one can be asked/);
  });

  test('when the paid request fails, the agent learns the payment went out and is told not to pay again', async (t) => {
    const { base, host } = await oddPaywall(t, (req) => req.socket.destroy());
    const { run, rail } = setUp(host);
    const result = await run('pay_and_fetch', { url: `${base}/data` });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Paid \$0\.01 to weather\.paywall\.testnet on near-testnet, transaction [0-9a-f]{32}, but the paid request failed: fetch failed/);
    assert.match(textOf(result), /Do not pay again/);
    assert.equal(rail.paid.length, 1);
  });

  test('a paid response that breaks off midway is reported with the payment, not as a crash', async (t) => {
    const { base, host } = await oddPaywall(t, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"city":');
      setTimeout(() => res.socket.destroy(), 20);
    });
    const { run } = setUp(host);
    const result = await run('pay_and_fetch', { url: `${base}/data` });
    assert.match(textOf(result), /^Paid \$0\.01 to weather\.paywall\.testnet on near-testnet, transaction [0-9a-f]{32}, but the paid request failed/);
  });

  test('a payment sent but not confirmed: the agent is told it may have gone out, and not to pay again', async (t) => {
    const { base, host } = await paywall(t);
    const { guard } = setUp(host);
    guard.rails.set('near-testnet', { network: 'near-testnet', pay: async () => { throw new PaymentUnconfirmed('abc', new Error('RPC timeout')); } });
    const result = await toolRunner({ guard })('pay_and_fetch', { url: `${base}/weather` });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'The payment of $0.01 to weather.paywall.testnet on near-testnet is unconfirmed: transaction abc was sent but not confirmed: RPC timeout. It may still go through, so do not pay again: tell the user, who can check the transaction.');
    assert.match(textOf(await toolRunner({ guard })('spending_status')), /^Spent today \(UTC\): \$0\.01 .*\nToday: 0 paid, 1 unconfirmed, 0 stopped\./);
  });

  test('a payment that failed before it went out says nothing was paid', async (t) => {
    const { base, host } = await paywall(t);
    const { guard } = setUp(host);
    guard.rails.set('near-testnet', { network: 'near-testnet', pay: async () => { throw new Error('access key does not exist'); } });
    const result = await toolRunner({ guard })('pay_and_fetch', { url: `${base}/weather` });
    assert.equal(textOf(result), 'The payment failed, so nothing was paid: access key does not exist');
  });

  test('a paywall that stalls once paid cannot hold the call', { timeout: 3000 }, async (t) => {
    const { base, host } = await oddPaywall(t, () => {});
    const { guard } = setUp(host);
    const run = toolRunner({ guard, responseTimeoutMs: 100 });
    const result = await run('pay_and_fetch', { url: `${base}/data` });
    assert.match(textOf(result), /^Paid \$0\.01 .*, but the paid request failed: no response within 0\.1s\. Do not pay again/);
  });

  test('the agent cannot reach the dashboard through pay_and_fetch, under any spelling of localhost', async (t) => {
    const { host } = await paywall(t);
    const { run } = setUp(host, { approvals: new Approvals(), dashboardUrl: 'http://127.0.0.1:4400' });
    for (const url of ['http://127.0.0.1:4400/approvals/x', 'http://localhost:4400/', 'http://[::1]:4400/events', 'http://2130706433:4400/', 'http://0x7f.1:4400/', 'http://127.1:4400/', 'http://0.0.0.0:4400/', 'http://[::ffff:127.0.0.1]:4400/']) {
      const result = await run('pay_and_fetch', { url, method: 'POST', body: '{"approve":true}' });
      assert.equal(result.isError, true, url);
      assert.match(textOf(result), /that is the Spend Guard dashboard/, url);
    }
  });

  test('payment, cookie and origin headers from the agent are dropped; others are sent', async (t) => {
    const echo = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
    const base = await listen(echo);
    t.after(() => echo.close());
    const { run } = setUp('elsewhere');
    const result = await run('pay_and_fetch', {
      url: `${base}/`,
      headers: { accept: 'application/json', 'x-api-key': 'k', 'X-Payment': 'forged', 'payment-signature': 'forged', cookie: 'a=b', origin: 'http://127.0.0.1:4400', 'sec-fetch-site': 'same-origin', host: '127.0.0.1:4400' },
    });
    const sent = JSON.parse(textOf(result).split('\n\n').slice(1).join('\n\n'));
    assert.equal(sent.accept, 'application/json');
    assert.equal(sent['x-api-key'], 'k');
    for (const name of ['x-payment', 'payment-signature', 'cookie', 'origin', 'sec-fetch-site']) assert.equal(sent[name], undefined, name);
    assert.equal(sent.host, new URL(base).host);
  });

  test('redirects are reported, not followed', async (t) => {
    const server = http.createServer((req, res) => res.writeHead(302, { location: '/elsewhere' }).end());
    const base = await listen(server);
    t.after(() => server.close());
    const { run } = setUp('elsewhere');
    assert.match(textOf(await run('pay_and_fetch', { url: `${base}/go` })), new RegExp(`^HTTP 302 Found\\nNo payment was needed\\.\\nRedirects to ${base}/elsewhere; not followed`));
  });

  test('bad arguments are tool errors the agent can read', async () => {
    const { run } = setUp('elsewhere');
    const cases = [
      [{}, /url is required/],
      [{ url: 'not a url' }, /is not a URL/],
      [{ url: 'file:///etc/passwd' }, /only http and https/],
      [{ url: 'http://x.test/', method: 'TRACE' }, /method must be one of/],
      [{ url: 'http://x.test/', body: 'b' }, /a GET request has no body/],
      [{ url: 'http://x.test/', headers: ['a'] }, /headers must be an object/],
    ];
    for (const [args, message] of cases) {
      const result = await run('pay_and_fetch', args);
      assert.equal(result.isError, true);
      assert.match(textOf(result), message);
    }
    assert.match(textOf(await run('spending_status', { limit: 0 })), /limit must be a whole number from 1 to 50/);
    assert.match(textOf(await run('make_payment', {})), /unknown tool "make_payment"/);
  });

  test('spending_status shows the budget, what waits for approval and the latest payments', async (t) => {
    const { base, host } = await paywall(t);
    const approvals = new Approvals();
    const { run } = setUp(host, { approvals, dashboardUrl: 'http://127.0.0.1:4400' });
    await run('pay_and_fetch', { url: `${base}/weather` });
    await run('pay_and_fetch', { url: `${base}/news` });
    for (let i = 0; i < 2; i++) await run('pay_and_fetch', { url: `${base}/maps` });
    await run('pay_and_fetch', { url: `${base}/maps` });

    const asked = new Promise((resolve) => approvals.once('asked', resolve));
    const waiting = run('pay_and_fetch', { url: `${base}/report` });
    await asked;
    const text = textOf(await run('spending_status', {}));
    assert.match(text, /^Spent today \(UTC\): \$0\.06 of the \$1\.00 daily budget; \$0\.94 left\.\nToday: 4 paid, 1 stopped\./);
    assert.match(text, /Waiting for the user's approval at http:\/\/127\.0\.0\.1:4400:\n- \$0\.30 for http:\/\/[^ ]+\/report to news\.paywall\.testnet; declined in 1[12]\ds without an answer/);
    assert.match(text, /Latest payments, newest first:\n- \S+ denied \$0\.015 http:\/\/[^ ]+\/maps to rnaps\.paywall\.testnet: .*not one of its known addresses\n- \S+ paid \$0\.015 /);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/, 'approval ids are not shown to the agent');
    assert.equal(textOf(await run('spending_status', { limit: 1 })).split('\n').filter((l) => l.startsWith('- 20')).length, 1);
    approvals.close();
    await waiting;
  });

  test('spending_policy shows the rules and the known payees', async () => {
    const { run } = setUp('api.example:443');
    const text = textOf(await run('spending_policy', {}));
    assert.match(text, /^Pays on: near-testnet\.\nDaily budget \$1\.00; at most \$0\.50 per payment; the user approves payments above \$0\.25\./);
    assert.match(text, /over 5x an endpoint's usual price is refused\. Services not listed below are paid only with the user's approval\./);
    assert.match(text, /- api\.example:443: weather\.paywall\.testnet, news\.paywall\.testnet, quotes\.paywall\.testnet, maps\.paywall\.testnet/);
  });

  test('every tool has a name, a description and an object input schema; only pay_and_fetch can spend', () => {
    assert.deepEqual(TOOLS.map((t) => t.name), ['pay_and_fetch', 'spending_status', 'spending_policy']);
    for (const t of TOOLS) {
      assert.ok(t.description.length > 80, t.name);
      assert.equal(t.inputSchema.type, 'object');
      assert.ok((t.inputSchema.required ?? []).every((k) => k in t.inputSchema.properties), t.name);
      assert.equal(t.annotations.readOnlyHint, t.name !== 'pay_and_fetch', t.name);
    }
  });
});

describe('mcp configuration', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'spend-guard-'));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const intent = (usd) => ({ resource: 'https://api.example/data', host: 'api.example', network: 'near-testnet', asset: 'usdc', amount: BigInt(Math.round(usd * 1e6)), payTo: 'pay.testnet' });
  const policy = { networks: ['near-testnet'], dailyUsd: 1, perPaymentUsd: 0.5, askAboveUsd: 1, services: { 'api.example': { payTo: ['pay.testnet'] } } };

  test('the ledger is read back on start, so a restart does not reset the daily budget', async () => {
    const file = path.join(dir, 'nested', 'ledger.jsonl');
    const first = new Guard({ policy, rails: [new MockRail('near-testnet')], ledger: loadLedger(file) });
    await first.pay(intent(0.4));
    await first.pay(intent(0.4));

    const restarted = new Guard({ policy, rails: [new MockRail('near-testnet')], ledger: loadLedger(file) });
    assert.equal(restarted.ledger.spentToday(Date.now()), 800_000n);
    await assert.rejects(restarted.pay(intent(0.4)), (err) => err.reasons[0].code === 'daily-budget');
  });

  test('a ledger line that does not parse stops the server instead of under-counting', async () => {
    const file = path.join(dir, 'broken.jsonl');
    await writeFile(file, '{"at":1,"status":"paid","usd":"1","intent":{"amount":"1"},"reasons":[]}\nnot json\n');
    assert.throws(() => loadLedger(file), /line 2 of the ledger .* is not a valid entry/);
  });

  test('guardFromEnv: mock by default, networks from the rails, policy from a file', async () => {
    const plain = await guardFromEnv({ SPEND_GUARD_LEDGER: 'off' });
    assert.deepEqual(plain.networks, ['near-testnet']);
    assert.ok(plain.rails.get('near-testnet') instanceof MockRail);
    assert.deepEqual(plain.policy.services, {}, 'no known services: every payment asks');

    const file = path.join(dir, 'policy.json');
    await writeFile(file, JSON.stringify({ dailyUsd: 3, services: { 'api.example': { payTo: ['pay.testnet'] } } }));
    const custom = await guardFromEnv({ SPEND_GUARD_LEDGER: 'off', SPEND_GUARD_POLICY: file, SPEND_GUARD_MOCK_NETWORK: 'arc-testnet' });
    assert.equal(custom.policy.dailyUsd, 3);
    assert.deepEqual(custom.networks, ['arc-testnet']);

    await assert.rejects(guardFromEnv({ SPEND_GUARD_LEDGER: 'off', SPEND_GUARD_RAILS: 'mock,bank' }), /unknown rail "bank"/);
    await assert.rejects(guardFromEnv({ SPEND_GUARD_LEDGER: 'off', SPEND_GUARD_RAILS: 'arc' }), /ARC_PRIVATE_KEY is not set/);
    await assert.rejects(guardFromEnv({ SPEND_GUARD_LEDGER: 'off', SPEND_GUARD_POLICY: path.join(dir, 'missing.json') }), /cannot read the policy/);
  });
});

/** A server on in-memory streams: send() a message, next() the next one it writes. */
function harness(run, dashboardUrl) {
  const input = new PassThrough();
  const output = new PassThrough();
  const queue = [];
  const waiters = [];
  let buf = '';
  output.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    }
  });
  const done = serveMcp({ input, output, run, dashboardUrl });
  return {
    send: (m) => input.write(`${typeof m === 'string' ? m : JSON.stringify({ jsonrpc: '2.0', ...m })}\n`),
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    unread: () => queue,
    end: async () => {
      input.end();
      await done;
    },
  };
}

describe('mcp protocol', () => {
  test('initialize, list, call with progress, and errors', async () => {
    const h = harness(async (name, args, { progress }) => {
      progress('Waiting for the user');
      return { content: [{ type: 'text', text: `${name} ${JSON.stringify(args)}` }] };
    }, 'http://127.0.0.1:4400');

    h.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const init = await h.next();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'spend-guard');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.match(init.result.instructions, /never pay another way/);
    assert.match(init.result.instructions, /dashboard at http:\/\/127\.0\.0\.1:4400/);

    h.send({ id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal((await h.next()).result.protocolVersion, PROTOCOL_VERSIONS[0]);

    h.send({ method: 'notifications/initialized' });
    h.send({ id: 3, method: 'tools/list' });
    assert.deepEqual((await h.next()).result.tools.map((t) => t.name), TOOLS.map((t) => t.name));

    h.send({ id: 4, method: 'tools/call', params: { name: 'pay_and_fetch', arguments: { url: 'http://x.test/' }, _meta: { progressToken: 'p' } } });
    assert.deepEqual(await h.next(), { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 1, message: 'Waiting for the user' } });
    assert.deepEqual((await h.next()).result.content[0].text, 'pay_and_fetch {"url":"http://x.test/"}');

    h.send({ id: 5, method: 'tools/call', params: { name: 'approve_payment', arguments: {} } });
    assert.equal((await h.next()).error.code, -32602);
    h.send({ id: 6, method: 'resources/list' });
    assert.equal((await h.next()).error.code, -32601);
    h.send({ id: 7, method: 'ping' });
    assert.deepEqual((await h.next()).result, {});
    h.send('{not json');
    assert.equal((await h.next()).error.code, -32700);
    await h.end();
  });

  test('a cancelled call is stopped and gets no answer', async () => {
    let signal;
    const h = harness(async (name, args, context) => {
      signal = context.signal;
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
      return { content: [{ type: 'text', text: 'too late' }] };
    });
    h.send({ id: 1, method: 'tools/call', params: { name: 'pay_and_fetch', arguments: { url: 'http://x.test/' } } });
    h.send({ method: 'notifications/cancelled', params: { requestId: 1, reason: 'Request timed out' } });
    h.send({ id: 2, method: 'ping' });
    assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 2, result: {} });
    assert.equal(signal.aborted, true);
    assert.match(signal.reason.message, /cancelled by the client: Request timed out/);
    await h.end();
    assert.deepEqual(h.unread(), [], 'no result for the cancelled call');
  });

  test('when the client goes away, calls still running are stopped', { timeout: 2000 }, async () => {
    let stopped = false;
    const h = harness(async (name, args, { signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
      stopped = true;
      return { content: [{ type: 'text', text: 'too late' }] };
    });
    h.send({ id: 1, method: 'tools/call', params: { name: 'pay_and_fetch', arguments: { url: 'http://x.test/' } } });
    await h.end();
    assert.equal(stopped, true);
  });

  test('a crashing tool is a tool error, not a dead server', async () => {
    const h = harness(async () => {
      throw new Error('rpc down');
    });
    h.send({ id: 1, method: 'tools/call', params: { name: 'spending_status', arguments: {} } });
    const res = await h.next();
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /spend-guard crashed: rpc down/);
    h.send({ id: 2, method: 'initialize', params: {} });
    assert.match((await h.next()).result.instructions, /runs without a dashboard/);
    await h.end();
  });
});

describe('spend-guard mcp, end to end with the official SDK client', () => {
  let dir;
  let server;
  let base;
  let client;
  let transport;
  let dashboardUrl;

  before(async () => {
    server = createPaidApi();
    base = await listen(server);
    dir = await mkdtemp(path.join(os.tmpdir(), 'spend-guard-mcp-'));
    const policy = path.join(dir, 'policy.json');
    await writeFile(policy, JSON.stringify({ networks: ['near-testnet'], dailyUsd: 1, perPaymentUsd: 0.5, askAboveUsd: 0.25, services: { [new URL(base).host]: { payTo: KNOWN } } }));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp'],
      env: { SPEND_GUARD_POLICY: policy, SPEND_GUARD_LEDGER: path.join(dir, 'ledger.jsonl'), SPEND_GUARD_DASHBOARD_PORT: '0', SPEND_GUARD_APPROVAL_TIMEOUT: '30' },
      stderr: 'pipe',
    });
    let stderr = '';
    const announced = new Promise((resolve) => {
      transport.stderr.on('data', (d) => {
        stderr += d;
        const url = stderr.match(/approve payments on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (url) resolve(url);
      });
    });
    client = new Client({ name: 'spend-guard-test', version: '1.0.0' });
    await client.connect(transport);
    dashboardUrl = await announced;
  });

  after(async () => {
    await client?.close();
    server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('lists the tools and tells the agent where the user approves', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['pay_and_fetch', 'spending_status', 'spending_policy']);
    assert.match(client.getInstructions(), new RegExp(`dashboard at ${dashboardUrl}`));
  });

  test('pays a paywall', async () => {
    const result = await client.callTool({ name: 'pay_and_fetch', arguments: { url: `${base}/weather` } });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /Paid \$0\.01 to weather\.paywall\.testnet/);
  });

  /** The dashboard's event stream, as the page reads it. */
  async function dashboardEvents() {
    const reader = (await fetch(`${dashboardUrl}/events`)).body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
      /** Reads until `re` matches what arrived; returns the match and reads on from after it. */
      async until(re) {
        let m;
        while (!(m = buffer.match(re))) buffer += decoder.decode((await reader.read()).value, { stream: true });
        buffer = buffer.slice(m.index + m[0].length);
        return m;
      },
      close: () => reader.cancel(),
    };
  }

  /** What the page posts when the user presses Approve or Deny. */
  const answer = (id, approve) => fetch(`${dashboardUrl}/approvals/${id}`, { method: 'POST', headers: { origin: dashboardUrl, 'content-type': 'application/json' }, body: JSON.stringify({ approve }) });
  const spentToday = async () => (await client.callTool({ name: 'spending_status', arguments: {} })).content[0].text.match(/^Spent today \(UTC\): (\$[\d.]+)/)[1];

  test('a flagged payment goes out only after the user approves it on the dashboard', async () => {
    const progress = [];
    const calling = client.callTool({ name: 'pay_and_fetch', arguments: { url: `${base}/report` } }, undefined, { onprogress: (p) => progress.push(p.message) });

    // The user's side: the page's event stream shows the ask, and the page posts the answer.
    const events = await dashboardEvents();
    const ask = JSON.parse((await events.until(/event: ask\ndata: (.*)\n\n/))[1]);
    assert.equal(ask.usd, '$0.30');
    assert.equal((await answer(ask.id, true)).status, 200);
    await events.close();

    const result = await calling;
    assert.match(result.content[0].text, /Paid \$0\.30 to news\.paywall\.testnet .*\(approved by the user\)/);
    assert.match(progress[0], /^Waiting for the user to approve \$0\.30/);
    assert.equal(await spentToday(), '$0.31');
  });

  test('a call the client gives up on is withdrawn: an approval after that pays nothing, and other payments go on meanwhile', async () => {
    const spent = await spentToday();
    const events = await dashboardEvents();
    // A client that does not wait as long as the user may take (the SDK's default is 60s).
    const calling = assert.rejects(client.callTool({ name: 'pay_and_fetch', arguments: { url: `${base}/report` } }, undefined, { onprogress: () => {}, timeout: 1500 }), /Request timed out/);
    const ask = JSON.parse((await events.until(/event: ask\ndata: (.*)\n\n/))[1]);

    const weather = await client.callTool({ name: 'pay_and_fetch', arguments: { url: `${base}/weather` } }, undefined, { timeout: 1000 });
    assert.match(weather.content[0].text, /Paid \$0\.01 to weather\.paywall\.testnet/, 'an allowed payment does not wait behind the ask');

    await calling;
    const settled = JSON.parse((await events.until(/event: settled\ndata: (.*)\n\n/))[1]);
    assert.deepEqual(settled, { id: ask.id, approved: false, by: 'cancelled' });
    assert.equal((await answer(ask.id, true)).status, 404, 'the page can no longer approve it');
    await events.close();

    const status = (await client.callTool({ name: 'spending_status', arguments: { limit: 1 } })).content[0].text;
    assert.match(status, /- \S+ declined \$0\.30 http:\/\/[^ ]+\/report to news\.paywall\.testnet: .*the agent stopped waiting, so nothing was paid/);
    assert.equal(await spentToday(), `$${(Number(spent.slice(1)) + 0.01).toFixed(2)}`);
  });
});
