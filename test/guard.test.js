import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Guard, GuardRefused } from '../src/guard.js';
import { MockRail } from '../src/rails/mock.js';

const policy = {
  networks: ['near-testnet'],
  dailyUsd: 1,
  perPaymentUsd: 1,
  askAboveUsd: 0.5,
  services: { 'api.example': { payTo: ['pay.example.testnet'] } },
};

function intent(usd) {
  return {
    resource: 'https://api.example/data',
    host: 'api.example',
    network: 'near-testnet',
    asset: 'usdc',
    amount: BigInt(Math.round(usd * 1e6)),
    payTo: 'pay.example.testnet',
  };
}

describe('guard', () => {
  test('an allowed payment goes through the rail and is recorded', async () => {
    const rail = new MockRail('near-testnet');
    const guard = new Guard({ policy, rails: [rail] });
    const receipt = await guard.pay(intent(0.1));
    assert.equal(receipt.network, 'near-testnet');
    assert.equal(rail.paid.length, 1);
    assert.deepEqual(guard.ledger.entries.map((e) => e.status), ['paid']);
  });

  test('a denied payment never reaches the rail', async () => {
    const rail = new MockRail('near-testnet');
    const guard = new Guard({ policy, rails: [rail] });
    await assert.rejects(guard.pay({ ...intent(0.1), payTo: 'drain.testnet' }), (err) => err instanceof GuardRefused && err.status === 'denied');
    assert.equal(rail.paid.length, 0);
    assert.deepEqual(guard.ledger.entries.map((e) => e.status), ['denied']);
  });

  test('a flagged payment asks the human and respects the answer', async () => {
    const asked = [];
    const rail = new MockRail('near-testnet');
    let answer = false;
    const guard = new Guard({ policy, rails: [rail], approve: async (i, v) => (asked.push(v.reasons[0].code), answer) });
    await assert.rejects(guard.pay(intent(0.6)), (err) => err.status === 'declined');
    answer = true;
    await guard.pay(intent(0.4));
    assert.deepEqual(asked, ['large-payment']);
    assert.equal(rail.paid.length, 1);
  });

  test('without an approver, flagged payments are declined', async () => {
    const guard = new Guard({ policy, rails: [new MockRail('near-testnet')] });
    await assert.rejects(guard.pay(intent(0.6)), (err) => err.status === 'declined');
  });

  test('parallel payments cannot both slip under the daily budget', async () => {
    const rail = new MockRail('near-testnet');
    const guard = new Guard({ policy, rails: [rail] });
    const results = await Promise.allSettled([guard.pay(intent(0.45)), guard.pay(intent(0.45)), guard.pay(intent(0.45))]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'rejected']);
    assert.equal(rail.paid.length, 2);
  });

  test('a failing rail is recorded as failed and the error surfaces', async () => {
    const rail = { network: 'near-testnet', pay: async () => { throw new Error('rpc timeout'); } };
    const guard = new Guard({ policy, rails: [rail] });
    await assert.rejects(guard.pay(intent(0.1)), /rpc timeout/);
    assert.deepEqual(guard.ledger.entries.map((e) => [e.status, e.error]), [['failed', 'rpc timeout']]);
    // A failed payment does not count against the budget.
    assert.equal(guard.ledger.spentToday(Date.now()), 0n);
  });

  test('every decision is emitted for the dashboard', async () => {
    const guard = new Guard({ policy, rails: [new MockRail('near-testnet')] });
    const seen = [];
    guard.on('entry', (e) => seen.push(e.status));
    await guard.pay(intent(0.1));
    await guard.pay({ ...intent(0.1), network: 'bch' }).catch(() => {});
    assert.deepEqual(seen, ['paid', 'denied']);
  });
});
