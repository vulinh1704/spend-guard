/**
 * The demo paywall's replay check: one on-chain payment buys one call. The chain check is faked
 * with a delay, the way an RPC round trip takes time.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPaidApi } from '../demo/paid-api.js';
import { encodePayment } from '../src/x402.js';

const PROOF = encodePayment({ x402Version: 1, scheme: 'exact', network: 'near-testnet', payload: { txid: 'tx-1', sender: 'agent.testnet' } });

/** Starts a paywall whose chain check answers with `answers` in turn, and returns `get`. */
async function paywall(t, answers = [null]) {
  let n = 0;
  const verify = async () => (await new Promise((resolve) => setTimeout(resolve, 20)), answers[Math.min(n++, answers.length - 1)]);
  const server = createPaidApi({ verify });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/weather`;
  return async () => {
    const res = await fetch(url, { headers: { 'X-PAYMENT': PROOF } });
    return { status: res.status, body: await res.json() };
  };
}

describe('demo paywall replay check', () => {
  test('a proof buys one call', async (t) => {
    const get = await paywall(t);
    assert.equal((await get()).status, 200);
    const again = await get();
    assert.equal(again.status, 402);
    assert.equal(again.body.error, 'payment already used');
  });

  test('the same proof sent twice at once buys one call', async (t) => {
    const get = await paywall(t);
    const statuses = (await Promise.all([get(), get()])).map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 402]);
  });

  test('a proof that failed the check can be sent again', async (t) => {
    const get = await paywall(t, ['transaction tx-1 not found', null]);
    assert.equal((await get()).status, 402);
    assert.equal((await get()).status, 200);
  });
});
