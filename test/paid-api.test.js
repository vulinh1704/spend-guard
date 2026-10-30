/**
 * The demo paywall's replay check: one on-chain payment buys one call. The chain check is faked
 * with a delay, the way an RPC round trip takes time.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPaidApi } from '../demo/paid-api.js';
import { encodePayment } from '../src/x402.js';

const proof = (txid) => encodePayment({ x402Version: 1, scheme: 'exact', network: 'near-testnet', payload: { txid, sender: 'agent.testnet' } });

/** Starts a paywall whose chain check answers with `answers` in turn, and returns `get(txid)`. */
async function paywall(t, answers = [null]) {
  let n = 0;
  const verify = async () => (await new Promise((resolve) => setTimeout(resolve, 20)), answers[Math.min(n++, answers.length - 1)]);
  const server = createPaidApi({ verify });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/weather`;
  return async (txid = 'tx-1') => {
    const res = await fetch(url, { headers: { 'X-PAYMENT': proof(txid) } });
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

  test('an EVM transaction hash is one payment however it is spelled', async (t) => {
    // Arc's RPC returns the same receipt for every one of these spellings.
    const hash = '0xf5f21167bc08705aba8a1c4c79278552ef83a7373634f3fcdc167fa0220c4952';
    const get = await paywall(t);
    assert.equal((await get(hash)).status, 200);
    for (const respelled of [`0x${hash.slice(2).toUpperCase()}`, `0X${hash.slice(2)}`, hash.slice(2), hash.replace('f', 'F')]) {
      const again = await get(respelled);
      assert.equal(again.status, 402, respelled);
      assert.equal(again.body.error, 'payment already used');
    }
  });
});
