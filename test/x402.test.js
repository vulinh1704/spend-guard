import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createPaidApi, PAYEES } from '../demo/paid-api.js';
import { Guard, GuardRefused } from '../src/guard.js';
import { MockRail } from '../src/rails/mock.js';
import { payingFetch, pickRequirement } from '../src/x402.js';

describe('x402 paywalls through the guard', () => {
  let server;
  let base;
  let host;

  before(async () => {
    server = createPaidApi();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `127.0.0.1:${server.address().port}`;
    base = `http://${host}`;
  });
  after(() => server.close());

  function guardFor(rail = new MockRail('near-testnet')) {
    return new Guard({
      policy: {
        networks: ['near-testnet'],
        dailyUsd: 2,
        perPaymentUsd: 1,
        askAboveUsd: 1,
        spikeRatio: 5,
        services: { [host]: { payTo: [PAYEES.weather, PAYEES.news, PAYEES.quotes, PAYEES.maps] } },
      },
      rails: [rail],
    });
  }

  test('pays the paywall and returns the data', async () => {
    const res = await payingFetch(guardFor(), `${base}/weather`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).city, 'Hanoi');
  });

  test('stops /quotes when its price jumps 40x', async () => {
    const guard = guardFor();
    for (let i = 0; i < 3; i++) assert.equal((await payingFetch(guard, `${base}/quotes`)).status, 200);
    await assert.rejects(payingFetch(guard, `${base}/quotes`), (err) => err instanceof GuardRefused && err.reasons[0].code === 'price-spike');
  });

  test('stops /maps when it starts asking to be paid at a new address', async () => {
    const rail = new MockRail('near-testnet');
    const guard = guardFor(rail);
    for (let i = 0; i < 2; i++) assert.equal((await payingFetch(guard, `${base}/maps`)).status, 200);
    await assert.rejects(payingFetch(guard, `${base}/maps`), (err) => err.reasons[0].code === 'payee-swap');
    assert.ok(!rail.paid.some((p) => p.payTo === PAYEES.thief), 'nothing was paid to the new address');
  });

  test('a paywall on a network the guard cannot pay on is an error, not a payment', async () => {
    const guard = new Guard({ policy: { networks: ['bch'] }, rails: [new MockRail('bch')] });
    await assert.rejects(payingFetch(guard, `${base}/news`), /asks for payment on near-testnet; this guard can pay on bch/);
  });

  test('pickRequirement takes the first option the guard can pay on', () => {
    const accepts = [{ network: 'base' }, { network: 'bch' }, { network: 'near-testnet' }];
    assert.equal(pickRequirement(accepts, ['near-testnet', 'bch']).network, 'bch');
    assert.equal(pickRequirement(accepts, ['concordium-testnet']), null);
  });
});
