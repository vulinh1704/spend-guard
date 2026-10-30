import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatUsd } from '../src/money.js';
import { evaluate } from '../src/policy.js';

const policy = {
  networks: ['near-testnet'],
  dailyUsd: 1,
  perPaymentUsd: 0.5,
  askAboveUsd: 0.1,
  spikeRatio: 5,
  unknownService: 'ask',
  services: { 'api.example': { payTo: ['pay.example.testnet'], maxUsd: 0.3 } },
};

/** USDC has 6 decimals, so `usd * 1e6` atomic units. */
function intent(overrides = {}) {
  return {
    resource: 'https://api.example/weather',
    host: 'api.example',
    network: 'near-testnet',
    asset: 'usdc',
    amount: 10_000n,
    payTo: 'pay.example.testnet',
    ...overrides,
  };
}

const fresh = { spentTodayUsd: 0n, recentPricesUsd: [] };
const codes = (verdict) => verdict.reasons.map((r) => r.code);

describe('policy', () => {
  test('a small payment to a known payee on an allowed network goes through', () => {
    const verdict = evaluate(intent(), policy, fresh);
    assert.equal(verdict.decision, 'allow');
    assert.equal(verdict.usd, 10_000n);
  });

  test('a network outside the policy is denied', () => {
    assert.deepEqual(codes(evaluate(intent({ network: 'bch' }), policy, fresh)), ['network']);
  });

  test('the same host asking to be paid at a new address is a payee swap', () => {
    const verdict = evaluate(intent({ payTo: 'drain.testnet' }), policy, fresh);
    assert.equal(verdict.decision, 'deny');
    assert.deepEqual(codes(verdict), ['payee-swap']);
  });

  test('an EVM payee matches in any letter case; any other address must match exactly', () => {
    const payee = '0xBbc0B612C19beA521D2eA1Ad7dfEe91D23753244';
    const evm = { ...policy, networks: ['arc-testnet'], services: { 'api.example': { payTo: [payee.toLowerCase()] } } };
    const pay = (payTo) => evaluate(intent({ network: 'arc-testnet', payTo }), evm, fresh);
    assert.equal(pay(payee).decision, 'allow', 'the x402 client checksums what the policy lists in lowercase');
    assert.deepEqual(codes(pay(`${payee.slice(0, -1)}5`)), ['payee-swap']);
    assert.deepEqual(codes(evaluate(intent({ payTo: 'PAY.example.testnet' }), policy, fresh)), ['payee-swap']);
  });

  test('a service cap is enforced', () => {
    assert.deepEqual(codes(evaluate(intent({ amount: 400_000n }), policy, fresh)), ['service-cap', 'large-payment']);
  });

  test('the per-payment limit and the daily budget are enforced', () => {
    const big = intent({ host: 'other.example', resource: 'https://other.example/x', amount: 600_000n });
    // Hard denials come first; the rules that would only have asked follow.
    assert.deepEqual(codes(evaluate(big, policy, fresh)), ['per-payment', 'unknown-service', 'large-payment']);
    assert.deepEqual(codes(evaluate(intent(), policy, { spentTodayUsd: 995_000n, recentPricesUsd: [] })), ['daily-budget']);
  });

  test('exactly hitting the daily budget is allowed', () => {
    assert.equal(evaluate(intent(), policy, { spentTodayUsd: 990_000n, recentPricesUsd: [] }).decision, 'allow');
  });

  test('a price far above the endpoint usual is a spike', () => {
    const verdict = evaluate(intent({ amount: 50_000n }), policy, { spentTodayUsd: 0n, recentPricesUsd: [10_000n, 10_000n, 12_000n] });
    assert.deepEqual(codes(verdict), ['price-spike']);
    assert.match(verdict.reasons[0].message, /5x the usual \$0\.01 for api\.example\/weather/);
  });

  test('an unknown service and a large payment wait for a human', () => {
    const unknown = evaluate(intent({ host: 'new.example', resource: 'https://new.example/a' }), policy, fresh);
    assert.equal(unknown.decision, 'ask');
    assert.deepEqual(codes(unknown), ['unknown-service']);
    const large = evaluate(intent({ amount: 200_000n }), policy, fresh);
    assert.equal(large.decision, 'ask');
    assert.deepEqual(codes(large), ['large-payment']);
  });

  test('a denial lists every rule that fired, not just the first', () => {
    const verdict = evaluate(intent({ network: 'bch', payTo: 'drain.testnet', amount: 2_000_000n }), policy, fresh);
    assert.equal(verdict.decision, 'deny');
    assert.deepEqual(codes(verdict), ['network', 'payee-swap', 'service-cap', 'per-payment', 'daily-budget', 'large-payment']);
  });

  test('prices in other assets are converted before comparing', () => {
    // 0.004 NEAR at $2.5 = $0.01
    const verdict = evaluate(intent({ asset: 'near', amount: 4n * 10n ** 21n }), policy, fresh);
    assert.equal(verdict.decision, 'allow');
    assert.equal(formatUsd(verdict.usd), '$0.01');
  });
});
