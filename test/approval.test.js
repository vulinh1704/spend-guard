import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Approvals } from '../src/approval.js';
import { Guard, GuardRefused } from '../src/guard.js';
import { MockRail } from '../src/rails/mock.js';

const intent = (usd) => ({ resource: 'https://api.example/report', host: 'api.example', network: 'near-testnet', asset: 'usdc', amount: BigInt(Math.round(usd * 1e6)), payTo: 'pay.example.testnet' });
const verdict = { decision: 'ask', reasons: [{ code: 'large-payment', message: 'too much' }], usd: 300_000n };
const policy = { networks: ['near-testnet'], dailyUsd: 1, perPaymentUsd: 1, askAboveUsd: 0.25, services: { 'api.example': { payTo: ['pay.example.testnet'] } } };

/** The next ask the queue publishes. */
const nextAsk = (approvals) => new Promise((resolve) => approvals.once('asked', resolve));

describe('approvals', () => {
  test('an ask waits until a human approves it', async () => {
    const approvals = new Approvals();
    const asked = nextAsk(approvals);
    const answer = approvals.ask(intent(0.3), verdict);
    const ask = await asked;
    assert.deepEqual(approvals.pending.map((a) => a.id), [ask.id]);
    assert.equal(ask.expiresAt - ask.at, 120_000);
    assert.equal(approvals.decide(ask.id, true), true);
    assert.equal(await answer, true);
    assert.deepEqual(approvals.pending, []);
  });

  test('deny resolves false and says a human answered', async () => {
    const approvals = new Approvals();
    const settled = [];
    approvals.on('settled', (s) => settled.push([s.approved, s.by]));
    const asked = nextAsk(approvals);
    const answer = approvals.ask(intent(0.3), verdict);
    approvals.decide((await asked).id, false);
    assert.equal(await answer, false);
    assert.deepEqual(settled, [[false, 'human']]);
  });

  test('only a real true approves', async () => {
    const approvals = new Approvals();
    const asked = nextAsk(approvals);
    const answer = approvals.ask(intent(0.3), verdict);
    approvals.decide((await asked).id, 'yes');
    assert.equal(await answer, false);
  });

  test('with no answer in time the payment is declined', async () => {
    const approvals = new Approvals({ timeoutMs: 20 });
    const settled = [];
    approvals.on('settled', (s) => settled.push(s.by));
    assert.equal(await approvals.ask(intent(0.3), verdict), false);
    assert.deepEqual(settled, ['timeout']);
    assert.deepEqual(approvals.pending, []);
  });

  test('an id that was never asked, or was already answered, changes nothing', async () => {
    const approvals = new Approvals();
    assert.equal(approvals.decide('not-an-ask', true), false);
    const asked = nextAsk(approvals);
    const answer = approvals.ask(intent(0.3), verdict);
    const { id } = await asked;
    assert.equal(approvals.decide(id, false), true);
    assert.equal(approvals.decide(id, true), false, 'a second answer cannot flip the first');
    assert.equal(await answer, false);
  });

  test('a late answer after the timeout is refused', async () => {
    const approvals = new Approvals({ timeoutMs: 10 });
    const asked = nextAsk(approvals);
    const answer = approvals.ask(intent(0.3), verdict);
    const { id } = await asked;
    assert.equal(await answer, false);
    assert.equal(approvals.decide(id, true), false);
  });

  test('ids are random, so a page cannot guess one it was not shown', async () => {
    const approvals = new Approvals();
    const ids = [];
    approvals.on('asked', (a) => ids.push(a.id));
    approvals.ask(intent(0.3), verdict);
    approvals.ask(intent(0.3), verdict);
    assert.notEqual(ids[0], ids[1]);
    assert.match(ids[0], /^[0-9a-f-]{36}$/);
    approvals.close();
  });

  test('close declines everything still waiting', async () => {
    const approvals = new Approvals();
    const answers = [approvals.ask(intent(0.3), verdict), approvals.ask(intent(0.4), verdict)];
    approvals.close();
    assert.deepEqual(await Promise.all(answers), [false, false]);
    assert.deepEqual(approvals.pending, []);
  });

  test('as the guard\'s approver: approved pays, denied is recorded as declined', async () => {
    const approvals = new Approvals();
    const rail = new MockRail('near-testnet');
    const guard = new Guard({ policy, rails: [rail], approve: approvals.ask });

    approvals.once('asked', (ask) => approvals.decide(ask.id, true));
    await guard.pay(intent(0.3));
    approvals.once('asked', (ask) => approvals.decide(ask.id, false));
    await assert.rejects(guard.pay(intent(0.3)), (err) => err instanceof GuardRefused && err.status === 'declined');

    assert.equal(rail.paid.length, 1);
    assert.deepEqual(guard.ledger.entries.map((e) => e.status), ['paid', 'declined']);
  });
});
