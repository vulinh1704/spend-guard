import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createDashboard } from '../demo/dashboard.js';
import { Guard } from '../src/guard.js';
import { MockRail } from '../src/rails/mock.js';

const intent = (payTo) => ({ resource: 'https://api.example/weather', host: 'api.example', network: 'near-testnet', asset: 'usdc', amount: 10_000n, payTo });

describe('dashboard', () => {
  let server;
  let base;
  const guard = new Guard({ policy: { networks: ['near-testnet'], services: { 'api.example': { payTo: ['pay.testnet'] } } }, rails: [new MockRail('near-testnet')] });

  before(async () => {
    server = createDashboard(guard, { account: 'agent.testnet', explorer: (tx) => `https://explorer.example/tx/${tx}` });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('serves the page with the policy filled in and the account escaped', async () => {
    const html = await (await fetch(base)).text();
    assert.match(html, /<title>Spend Guard<\/title>/);
    assert.match(html, /agent\.testnet/);
    assert.match(html, /At most \$1\.00 per payment/);
  });

  test('a page opened late gets the history, then live entries', async () => {
    await guard.pay(intent('pay.testnet'));
    const controller = new AbortController();
    const res = await fetch(`${base}/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);

    const first = JSON.parse((await read()).replace(/^data: /, ''));
    assert.equal(first.status, 'paid');
    assert.equal(first.usd, '$0.01');
    assert.match(first.txUrl, /^https:\/\/explorer\.example\/tx\//);

    await guard.pay(intent('drain.testnet')).catch(() => {});
    const second = JSON.parse((await read()).replace(/^data: /, ''));
    assert.equal(second.status, 'denied');
    assert.match(second.reasons[0], /not one of its known addresses/);
    controller.abort();
  });
});
