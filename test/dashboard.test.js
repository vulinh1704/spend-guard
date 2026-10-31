import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createDashboard } from '../demo/dashboard.js';
import { Approvals } from '../src/approval.js';
import { Guard, GuardRefused, PaymentUnconfirmed } from '../src/guard.js';
import { evaluate } from '../src/policy.js';
import { MockRail } from '../src/rails/mock.js';

const intent = (payTo, usd = 0.01, path = '/weather') => ({ resource: `https://api.example${path}`, host: 'api.example', network: 'near-testnet', asset: 'usdc', amount: BigInt(Math.round(usd * 1e6)), payTo });
const policy = { networks: ['near-testnet'], services: { 'api.example': { payTo: ['pay.testnet'] } } };

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Server-sent events from `url`, one {event, data} at a time. */
async function events(url) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next() {
      while (!buffer.includes('\n\n')) {
        const { done, value } = await reader.read();
        if (done) throw new Error('the event stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
      const i = buffer.indexOf('\n\n');
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const event = block.match(/^event: (.*)$/m)?.[1] ?? 'message';
      return { event, data: JSON.parse(block.match(/^data: (.*)$/m)[1]) };
    },
    close: () => controller.abort(),
  };
}

/** A raw request, so the test controls Host, Origin and the other headers a browser would set (null leaves one out). */
function request(base, { method = 'POST', path, headers = {}, body }) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const sent = Object.fromEntries(Object.entries({ host: `127.0.0.1:${port}`, ...headers }).filter(([, v]) => v !== null));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: sent }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** What the dashboard page itself sends when a button is clicked. */
const fromPage = (base, id, approve, headers = {}) => request(base, {
  path: `/approvals/${id}`,
  headers: { origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ approve }),
});

describe('dashboard', () => {
  let server;
  let base;
  const guard = new Guard({ policy, rails: [new MockRail('near-testnet')] });

  before(async () => {
    server = createDashboard(guard, { account: 'agent.testnet', explorer: (tx) => `https://explorer.example/tx/${tx}` });
    base = await listen(server);
  });
  after(() => server.close());

  test('serves the page with the policy filled in and the account escaped', async () => {
    const html = await (await fetch(base)).text();
    assert.match(html, /<title>Spend Guard<\/title>/);
    assert.match(html, /agent\.testnet/);
    assert.match(html, /At most \$1\.00 per payment/);
    assert.match(html, /<section class="approvals" id="approvals" aria-labelledby="approvals-title" hidden>/, 'the approval area starts hidden');
  });

  test('the rules line says a price at the spike ratio is refused, as the policy does', async () => {
    const spiky = new Guard({ policy: { ...policy, spikeRatio: 3 }, rails: [new MockRail('near-testnet')] });
    const page = createDashboard(spiky);
    const html = await (await fetch(await listen(page))).text();
    page.close();
    assert.match(html, /prices 3x the usual or more are refused/);
    const atRatio = evaluate(intent('pay.testnet', 0.03), spiky.policy, { spentTodayUsd: 0n, recentPricesUsd: [10_000n] });
    assert.deepEqual(atRatio.reasons.map((r) => r.code), ['price-spike']);
  });

  test('a page opened late gets the history, then live entries', async () => {
    await guard.pay(intent('pay.testnet'));
    const stream = await events(`${base}/events`);

    const first = (await stream.next()).data;
    assert.equal(first.status, 'paid');
    assert.equal(first.usd, '$0.01');
    assert.match(first.txUrl, /^https:\/\/explorer\.example\/tx\//);

    await guard.pay(intent('drain.testnet')).catch(() => {});
    const second = (await stream.next()).data;
    assert.equal(second.status, 'denied');
    assert.match(second.reasons[0], /not one of its known addresses/);
    stream.close();
  });

  test('answers on localhost names only, so a DNS-rebinding page cannot read it', async () => {
    const res = await request(base, { method: 'GET', path: '/events', headers: { host: `evil.example:${new URL(base).port}` } });
    assert.equal(res.status, 403);
  });

  test('without approvals it takes no answers', async () => {
    assert.equal((await fromPage(base, 'x', true)).status, 404);
  });

  test('an unconfirmed payment shows its transaction and counts as spent; a failed one shows its error', async (t) => {
    const rail = { network: 'near-testnet', pay: async (i) => { throw i.amount > 10_000n ? new PaymentUnconfirmed('abc', new Error('RPC timeout')) : new Error('access key does not exist'); } };
    const other = new Guard({ policy, rails: [rail] });
    const server = createDashboard(other, { explorer: (tx) => `https://explorer.example/tx/${tx}` });
    const url = await listen(server);
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    await assert.rejects(other.pay(intent('pay.testnet', 0.02)), PaymentUnconfirmed);
    await assert.rejects(other.pay(intent('pay.testnet', 0.01)), /access key/);

    const stream = await events(`${url}/events`);
    const unconfirmed = (await stream.next()).data;
    assert.deepEqual([unconfirmed.status, unconfirmed.tx, unconfirmed.txUrl, unconfirmed.spent], ['unconfirmed', 'abc', 'https://explorer.example/tx/abc', '$0.02']);
    assert.equal((await stream.next()).data.error, 'access key does not exist');
    stream.close();
    assert.match(await (await fetch(url)).text(), /unconfirmed: 'Unconfirmed'/);
  });
});

describe('dashboard settlements', () => {
  test('a signed payment gets its transaction link once the paywall reports the settlement', { timeout: 5000 }, async (t) => {
    const rail = { network: 'near-testnet', pay: async () => ({ network: 'near-testnet', txid: undefined, proof: { signature: '0x' } }) };
    const other = new Guard({ policy, rails: [rail] });
    const server = createDashboard(other, { explorer: (tx) => `https://explorer.example/tx/${tx}` });
    const url = await listen(server);
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const stream = await events(`${url}/events`);
    const ok = await other.pay(intent('pay.testnet'));
    const failed = await other.pay(intent('pay.testnet', 0.02));
    const [first, second] = [(await stream.next()).data, (await stream.next()).data];
    assert.deepEqual([first.status, first.tx, first.txUrl], ['paid', null, null], 'nothing on chain yet');

    other.settled(ok, { success: true, transaction: 'abc', network: 'near-testnet' });
    other.settled(failed, { success: false, errorReason: 'invalid_exact_evm_transaction_simulation_failed', transaction: '' });
    const settled = await stream.next();
    assert.deepEqual([settled.event, settled.data.id, settled.data.txUrl, settled.data.unsettled], ['receipt', first.id, 'https://explorer.example/tx/abc', null]);
    const refused = await stream.next();
    assert.deepEqual([refused.event, refused.data.id, refused.data.tx, refused.data.unsettled], ['receipt', second.id, null, 'invalid_exact_evm_transaction_simulation_failed']);
    stream.close();
    assert.match(await (await fetch(url)).text(), /addEventListener\('receipt'/);
  });
});

describe('dashboard approvals', () => {
  let server;
  let base;
  const approvals = new Approvals();
  const rail = new MockRail('near-testnet');
  const guard = new Guard({ policy, rails: [rail], approve: approvals.ask });

  before(async () => {
    server = createDashboard(guard, { approvals });
    base = await listen(server);
  });
  after(() => {
    approvals.close();
    server.closeAllConnections();
    server.close();
  });

  test('a flagged payment waits on the page and goes out once approved there', async () => {
    const stream = await events(`${base}/events`);
    const paying = guard.pay(intent('pay.testnet', 0.3, '/report'));

    const ask = await stream.next();
    assert.equal(ask.event, 'ask');
    assert.equal(ask.data.usd, '$0.30');
    assert.equal(ask.data.endpoint, '/report');
    assert.match(ask.data.reasons[0], /needs your approval/);
    assert.ok(ask.data.expiresIn > 0 && ask.data.expiresIn <= 120_000);
    assert.equal(rail.paid.length, 0, 'nothing is paid before the answer');

    assert.deepEqual(await fromPage(base, ask.data.id, true), { status: 200, body: { ok: true } });
    assert.deepEqual(await stream.next(), { event: 'settled', data: { id: ask.data.id, approved: true, by: 'human' } });
    const entry = await stream.next();
    assert.equal(entry.data.status, 'paid');
    assert.equal(entry.data.answer, 'approved');
    await paying;
    assert.equal(rail.paid.length, 1);
    stream.close();
  });

  test('a page opened late is shown the payments still waiting', async () => {
    const asked = new Promise((resolve) => approvals.once('asked', resolve));
    const paying = guard.pay(intent('pay.testnet', 0.3, '/report'));
    const { id } = await asked;

    const stream = await events(`${base}/events`);
    let next = await stream.next();
    while (next.event !== 'ask') next = await stream.next();
    assert.equal(next.data.id, id);
    stream.close();

    approvals.decide(id, false);
    await assert.rejects(paying, GuardRefused);
  });

  test('only the page itself can answer, and only a payment that is waiting', async () => {
    const asked = new Promise((resolve) => approvals.once('asked', resolve));
    const declined = assert.rejects(guard.pay(intent('pay.testnet', 0.3, '/report')), (err) => err instanceof GuardRefused && err.status === 'declined');
    const { id } = await asked;
    const port = new URL(base).port;

    // Another site in the same browser, or a non-browser client without the page's Origin.
    assert.equal((await fromPage(base, id, true, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fromPage(base, id, true, { origin: null, 'sec-fetch-site': null })).status, 403);
    assert.equal((await fromPage(base, id, true, { 'sec-fetch-site': 'cross-site' })).status, 403);
    // DNS rebinding: the page and its Origin agree, but the host is not a localhost name.
    assert.equal((await fromPage(base, id, true, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).status, 403);
    // A form post cannot send JSON, and JSON cross-site needs a preflight this server never grants.
    assert.equal((await fromPage(base, id, true, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await fromPage(base, id, 'yes')).status, 400);
    assert.equal((await fromPage(base, 'never-asked', true)).status, 404);
    assert.equal(approvals.pending.length, 1, 'none of those answered it');

    assert.equal((await fromPage(base, id, false)).status, 200);
    assert.equal((await fromPage(base, id, true)).status, 404, 'an answered payment cannot be approved after all');
    await declined;
    assert.equal(rail.paid.length, 1, 'only the payment approved in the first test went out');
  });

  test('the feed says how each flagged payment was answered', async () => {
    const stream = await events(`${base}/events`);
    const seen = [];
    for (let i = 0; i < guard.ledger.entries.length; i++) seen.push((await stream.next()).data.answer);
    assert.deepEqual(seen, ['approved', 'denied', 'denied']);
    stream.close();
  });

  test('an ask the agent stops waiting for leaves the page, and the feed says why it was not paid', async () => {
    const stream = await events(`${base}/events`);
    for (let i = 0; i < guard.ledger.entries.length; i++) await stream.next();
    const agent = new AbortController();
    const declined = assert.rejects(guard.pay(intent('pay.testnet', 0.3, '/report'), { signal: agent.signal }), (err) => err.status === 'declined');

    const ask = await stream.next();
    assert.equal(ask.event, 'ask');
    agent.abort();
    assert.deepEqual(await stream.next(), { event: 'settled', data: { id: ask.data.id, approved: false, by: 'cancelled' } });
    const entry = (await stream.next()).data;
    assert.equal(entry.status, 'declined');
    assert.equal(entry.answer, null, 'not "no answer in time": the reason says what happened');
    assert.equal(entry.reasons.at(-1), 'the agent stopped waiting, so nothing was paid');
    assert.equal((await fromPage(base, ask.data.id, true)).status, 404);
    await declined;
    stream.close();
  });
});
