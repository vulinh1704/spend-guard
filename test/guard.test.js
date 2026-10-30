import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { Guard, GuardRefused, PaymentPending, PaymentUnconfirmed } from '../src/guard.js';
import { MockRail } from '../src/rails/mock.js';

const policy = {
  networks: ['near-testnet'],
  dailyUsd: 1,
  perPaymentUsd: 1,
  askAboveUsd: 0.5,
  services: { 'api.example': { payTo: ['pay.example.testnet'] } },
};

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

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

  test('a payment sent but not confirmed is recorded as unconfirmed and counts against the budget', async () => {
    const rail = { network: 'near-testnet', pay: async () => { throw new PaymentUnconfirmed('abc', new Error('RPC timeout')); } };
    const guard = new Guard({ policy, rails: [rail] });
    await assert.rejects(guard.pay(intent(0.45)), PaymentUnconfirmed);
    const [entry] = guard.ledger.entries;
    assert.deepEqual([entry.status, entry.receipt.txid, entry.error], ['unconfirmed', 'abc', 'transaction abc was sent but not confirmed: RPC timeout']);
    assert.equal(guard.ledger.spentToday(Date.now()), 450_000n, 'it may still go through');
    await assert.rejects(guard.pay(intent(0.45)), PaymentUnconfirmed);
    await assert.rejects(guard.pay(intent(0.45)), (err) => err.status === 'denied' && err.reasons[0].code === 'daily-budget');
  });

  test('a payment waiting for the human does not hold up payments the policy allows', { timeout: 2000 }, async () => {
    const rail = new MockRail('near-testnet');
    const human = deferred();
    const guard = new Guard({ policy, rails: [rail], approve: () => human.promise });
    const asking = guard.pay(intent(0.6));
    await guard.pay(intent(0.2));
    assert.equal(rail.paid.length, 1, 'paid while the other one waits');
    human.resolve(true);
    await asking;
    assert.equal(rail.paid.length, 2);
  });

  test('an approved payment is checked again against what was spent while the human decided', { timeout: 2000 }, async () => {
    const rail = new MockRail('near-testnet');
    const human = deferred();
    const guard = new Guard({ policy, rails: [rail], approve: () => human.promise });
    const asking = guard.pay(intent(0.6));
    await guard.pay(intent(0.45));
    human.resolve(true);
    await assert.rejects(asking, (err) => err.status === 'denied' && err.reasons[0].code === 'daily-budget');
    assert.equal(rail.paid.length, 1);
  });

  test('a payment whose caller stopped waiting is not paid, even when approved afterwards', async () => {
    const rail = new MockRail('near-testnet');
    const human = deferred();
    const guard = new Guard({ policy, rails: [rail], approve: () => human.promise });
    const caller = new AbortController();
    const paying = guard.pay(intent(0.6), { signal: caller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    caller.abort(new Error('client timed out'));
    human.resolve(true);
    await assert.rejects(paying, (err) => err instanceof GuardRefused && err.status === 'declined');
    assert.equal(rail.paid.length, 0);
    assert.deepEqual(guard.ledger.entries.map((e) => [e.status, e.reasons.at(-1).code]), [['declined', 'cancelled']]);
  });

  test('a payment still in line when its caller stops waiting is dropped', async () => {
    const slow = deferred();
    const paid = [];
    const rail = { network: 'near-testnet', pay: async (i) => (await slow.promise, paid.push(i), { network: 'near-testnet', txid: 't', proof: {} }) };
    const guard = new Guard({ policy, rails: [rail] });
    const first = guard.pay(intent(0.1));
    const caller = new AbortController();
    const second = guard.pay(intent(0.2), { signal: caller.signal });
    caller.abort(new Error('client timed out'));
    slow.resolve();
    await first;
    await assert.rejects(second, /client timed out/);
    assert.equal(paid.length, 1);
    assert.deepEqual(guard.ledger.entries.map((e) => e.status), ['paid']);
  });

  test('a payment the rail can\'t confirm is unconfirmed and counts against the budget, so a retry can\'t overspend', async () => {
    const receipt = { network: 'near-testnet', provider: { transactionId: 'tx-1' } };
    const rail = { network: 'near-testnet', pay: async () => { throw new PaymentPending('tx-1 may still complete', receipt); } };
    const guard = new Guard({ policy, rails: [rail] });
    await assert.rejects(guard.pay(intent(0.45)), PaymentPending);
    assert.deepEqual(guard.ledger.entries.map((e) => [e.status, e.error, e.receipt]), [['unconfirmed', 'tx-1 may still complete', receipt]]);
    assert.equal(guard.ledger.spentToday(Date.now()), 450_000n);
    assert.deepEqual(guard.ledger.recentPrices(intent(0.45)), [450_000n]);
    await assert.rejects(guard.pay(intent(0.45)), PaymentPending);
    await assert.rejects(guard.pay(intent(0.45)), (err) => err instanceof GuardRefused && err.reasons.some((r) => r.code === 'daily-budget'));
  });

  test('every decision is emitted for the dashboard', async () => {
    const guard = new Guard({ policy, rails: [new MockRail('near-testnet')] });
    const seen = [];
    guard.on('entry', (e) => seen.push(e.status));
    await guard.pay(intent(0.1));
    await guard.pay({ ...intent(0.1), network: 'bch' }).catch(() => {});
    assert.deepEqual(seen, ['paid', 'denied']);
  });

  test('a listener that throws cannot turn a payment that went out into a failure', async () => {
    const rail = new MockRail('near-testnet');
    const guard = new Guard({ policy, rails: [rail] });
    const seen = [];
    guard.on('entry', () => { throw new Error('listener broke'); });
    guard.on('entry', (e) => seen.push(e.status));
    const warned = once(process, 'warning');
    const receipt = await guard.pay(intent(0.1));
    assert.equal(receipt.network, 'near-testnet');
    assert.equal(rail.paid.length, 1);
    assert.deepEqual(guard.ledger.entries.map((e) => e.status), ['paid']);
    assert.deepEqual(seen, ['paid'], 'the other listeners still hear of it');
    assert.match((await warned)[0].message, /a listener of 'entry' threw: listener broke/);
    await assert.rejects(guard.pay({ ...intent(0.1), payTo: 'drain.testnet' }), GuardRefused);
  });
});
