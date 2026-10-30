/**
 * Circle Gateway nanopayments, offline: the rail signs for real with a throwaway key, the
 * GatewayClient is a fake holding a balance, and the demo seller's call to Circle is a stub.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { formatUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createGatewaySeller } from '../demo/gateway-seller.js';
import { Guard, GuardRefused } from '../src/guard.js';
import { checkGatewayAuthorization, GATEWAY_WALLET, gatewayOffer, GatewayRail, settleGatewayPayment } from '../src/rails/gateway.js';
import { MockRail } from '../src/rails/mock.js';
import { decodePayment, encodePayment, payingFetch } from '../src/x402.js';

const KEY = generatePrivateKey();
const AGENT = privateKeyToAccount(KEY).address;
const address = () => privateKeyToAccount(generatePrivateKey()).address;
const PAYEES = { weather: address(), news: address(), quotes: address(), maps: address(), thief: address() };
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const WEEK = 7 * 24 * 60 * 60;

/** Stands in for GatewayClient: a Gateway balance and a transfer search, no network. */
function fakeClient(available = 1_000_000n) {
  return {
    searches: [],
    getBalances: async () => ({ wallet: { balance: 0n, formatted: '0' }, gateway: { available, formattedAvailable: formatUnits(available, 6) } }),
    searchTransfers: async function (query) {
      this.searches.push(query);
      return { transfers: [{ id: 'f1b9…', status: 'completed', nonce: query.nonce, txHash: `0x${'cd'.repeat(32)}` }] };
    },
  };
}

/** A rail that counts what it signs, so a test can prove a refusal signed nothing. */
function railWith(client = fakeClient()) {
  const rail = new GatewayRail({ privateKey: KEY, client });
  const sign = rail.scheme.createPaymentPayload.bind(rail.scheme);
  rail.signed = [];
  rail.scheme.createPaymentPayload = async (version, requirement) => (rail.signed.push(requirement), sign(version, requirement));
  return rail;
}

function intentFor(offer, overrides = {}) {
  return { resource: 'http://api.example/weather', host: 'api.example', network: 'arc-testnet-gateway', asset: 'usdc', amount: BigInt(offer.amount), payTo: offer.payTo, offer, ...overrides };
}

describe('Gateway rail', () => {
  const offer = gatewayOffer({ payTo: PAYEES.weather, amount: 10_000n });

  test('signs an authorization for the approved payee and amount, valid for the week Gateway needs', async () => {
    const rail = railWith();
    const receipt = await rail.pay(intentFor(offer));
    const { authorization: a } = receipt.proof;
    assert.equal(receipt.network, 'arc-testnet-gateway');
    assert.equal(receipt.txid, a.nonce);
    assert.deepEqual([a.from, a.to, a.value], [AGENT, PAYEES.weather, '10000']);
    assert.ok(Number(a.validBefore) - Date.now() / 1000 >= WEEK);
    assert.equal(await checkGatewayAuthorization(receipt.proof, offer), null);
  });

  test('signs version 2 offers under the domain that binds the token', async () => {
    const v2 = gatewayOffer({ payTo: PAYEES.weather, amount: 10_000n, version: '2' });
    const { proof } = await railWith().pay(intentFor(v2));
    assert.equal(await checkGatewayAuthorization(proof, v2), null);
    assert.match(await checkGatewayAuthorization(proof, offer), /not from the payer/, 'a v2 signature does not pass as v1');
  });

  test('takes only Gateway offers for USDC on Arc testnet, for Circle\'s Gateway Wallet', () => {
    const rail = railWith();
    assert.deepEqual(rail.terms(offer), { asset: 'usdc', amount: 10_000n, payTo: PAYEES.weather });
    assert.deepEqual(rail.terms({ ...offer, payTo: PAYEES.weather.toLowerCase() }).payTo, PAYEES.weather, 'payee is checksummed for the allowlist');
    const refused = {
      'a look-alike contract': { ...offer, extra: { ...offer.extra, verifyingContract: address() } },
      'Arc mainnet': { ...offer, network: 'eip155:5042' },
      'EURC': { ...offer, asset: EURC },
      'a plain USDC offer': { ...offer, extra: { name: 'USDC', version: '2' } },
      'an unknown domain version': { ...offer, extra: { ...offer.extra, version: '3' } },
      'another scheme': { ...offer, scheme: 'upto' },
      'a zero amount': { ...offer, amount: '0' },
      'a malformed payee': { ...offer, payTo: '0x1234' },
      'nothing': undefined,
    };
    for (const [what, o] of Object.entries(refused)) assert.equal(rail.terms(o), null, what);
  });

  test('signs nothing when the offer is not what the guard approved', async () => {
    const rail = railWith();
    await assert.rejects(rail.pay(intentFor(offer, { amount: 9_999n })), /differs from the payment the guard approved/);
    await assert.rejects(rail.pay(intentFor(offer, { payTo: PAYEES.thief })), /differs/);
    await assert.rejects(rail.pay(intentFor(offer, { offer: { ...offer, network: 'eip155:5042' } })), /did not offer a Circle Gateway payment/);
    await assert.rejects(rail.pay(intentFor(offer, { asset: 'near' })), /pays in USDC/);
    assert.equal(rail.signed.length, 0);
  });

  test('signs nothing the Gateway balance cannot cover', async () => {
    const rail = railWith(fakeClient(9_999n));
    await assert.rejects(rail.pay(intentFor(offer)), /Gateway balance 0.009999 USDC is too low/);
    assert.equal(rail.signed.length, 0);
  });

  test('looks a payment up at Gateway by the nonce in its receipt', async () => {
    const client = fakeClient();
    const rail = railWith(client);
    const { txid } = await rail.pay(intentFor(offer));
    const transfer = await rail.status(txid);
    assert.equal(transfer.status, 'completed');
    assert.deepEqual(client.searches, [{ from: AGENT, nonce: txid }]);
  });
});

describe('x402 v2 paywalls paid through Circle Gateway', () => {
  let server;
  let base;
  let host;
  let settles;
  let settleResult;

  before(async () => {
    server = createGatewaySeller({
      payees: PAYEES,
      settle: async (payment, requirement) => (settles.push({ payment, requirement }), settleResult(payment)),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `127.0.0.1:${server.address().port}`;
    base = `http://${host}`;
  });
  after(() => server.close());

  // Each test gets a fresh seller state for settles, but the seller's call counts carry over, so
  // tests that count on /quotes or /maps turning bad run first on those endpoints.
  function guardFor(rail, policy = {}) {
    settles = [];
    settleResult = (payment) => ({ success: true, transaction: crypto.randomUUID(), payer: payment.payload.authorization.from, network: 'eip155:5042002' });
    return new Guard({
      policy: {
        networks: ['arc-testnet-gateway'],
        dailyUsd: 2,
        perPaymentUsd: 1,
        askAboveUsd: 1,
        spikeRatio: 5,
        services: { [host]: { payTo: [PAYEES.weather, PAYEES.news, PAYEES.quotes, PAYEES.maps] } },
        ...policy,
      },
      rails: [rail],
    });
  }

  test('the guard allows, the rail signs, the seller settles with Circle, the data comes back', async () => {
    const rail = railWith();
    const guard = guardFor(rail);
    const res = await payingFetch(guard, `${base}/weather`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).city, 'Hanoi');

    const response = decodePayment(res.headers.get('payment-response'));
    assert.equal(response.success, true);
    assert.equal(response.payer, AGENT);

    // Gateway refuses to settle without `resource` and the offer echoed back as `accepted`.
    const [{ payment, requirement }] = settles;
    assert.equal(payment.x402Version, 2);
    assert.equal(payment.resource.url, `${base}/weather`);
    assert.deepEqual(payment.accepted, requirement);
    assert.equal(requirement.extra.verifyingContract, GATEWAY_WALLET);

    const [entry] = guard.ledger.entries;
    assert.equal(entry.status, 'paid');
    assert.equal(entry.receipt.txid, payment.payload.authorization.nonce);
  });

  test('a 40x price spike on /quotes is refused before anything is signed', async () => {
    const rail = railWith();
    const guard = guardFor(rail);
    for (let i = 0; i < 3; i++) assert.equal((await payingFetch(guard, `${base}/quotes`)).status, 200);
    await assert.rejects(payingFetch(guard, `${base}/quotes`), (err) => err instanceof GuardRefused && err.reasons[0].code === 'price-spike');
    assert.equal(rail.signed.length, 3);
    assert.equal(settles.length, 3);
  });

  test('/maps switching to a look-alike payee is refused before anything is signed', async () => {
    const rail = railWith();
    const guard = guardFor(rail);
    for (let i = 0; i < 2; i++) assert.equal((await payingFetch(guard, `${base}/maps`)).status, 200);
    await assert.rejects(payingFetch(guard, `${base}/maps`), (err) => err.reasons[0].code === 'payee-swap');
    assert.ok(!rail.signed.some((r) => r.payTo === PAYEES.thief), 'no authorization for the new address exists');
  });

  test('a payment the human declines is never signed', async () => {
    const rail = railWith();
    const guard = guardFor(rail, { askAboveUsd: 0.005 });
    await assert.rejects(payingFetch(guard, `${base}/news`), (err) => err.status === 'declined');
    assert.equal(rail.signed.length, 0);
    assert.equal(settles.length, 0);
  });

  test('a failed settle is a 402 with Circle\'s reason, and the signature still counts as spent', async () => {
    const rail = railWith();
    const guard = guardFor(rail);
    settleResult = () => ({ success: false, errorReason: 'insufficient_balance' });
    const res = await payingFetch(guard, `${base}/weather`);
    assert.equal(res.status, 402);
    assert.equal((await res.json()).reason, 'insufficient_balance');
    assert.equal(decodePayment(res.headers.get('payment-response')).success, false);
    // The authorization is out there for a week, so the budget keeps counting it.
    assert.deepEqual(guard.ledger.entries.map((e) => e.status), ['paid']);
  });

  test('a paywall that answers 402 again after being paid gets no second signature', async () => {
    const rail = railWith();
    const guard = new Guard({ policy: { networks: ['arc-testnet-gateway'], services: { 'api.example': { payTo: [PAYEES.weather] } } }, rails: [rail] });
    const required = encodePayment({ x402Version: 2, resource: { url: 'http://api.example/weather' }, accepts: [gatewayOffer({ payTo: PAYEES.weather, amount: 10_000n })] });
    const requests = [];
    const fetch = async (url, init) => (requests.push(init), new Response('{}', { status: 402, headers: { 'payment-required': required } }));
    const res = await payingFetch(guard, 'http://api.example/weather', {}, { fetch });
    assert.equal(res.status, 402);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].headers['PAYMENT-SIGNATURE']);
    assert.equal(rail.signed.length, 1);
    assert.deepEqual(guard.ledger.entries.map((e) => e.status), ['paid']);
  });

  test('a replayed or forged payment is refused without asking Circle', async () => {
    const rail = railWith();
    guardFor(rail);
    const offer = gatewayOffer({ payTo: PAYEES.weather, amount: 10_000n });
    const { proof } = await rail.pay(intentFor(offer));
    const send = (payload) => fetch(`${base}/weather`, { headers: { 'payment-signature': encodePayment({ x402Version: 2, resource: { url: `${base}/weather` }, accepted: offer, payload }) } });

    assert.equal((await send(proof)).status, 200);
    const replay = await send(proof);
    assert.equal(replay.status, 402);
    assert.equal((await replay.json()).error, 'payment already used');

    const forged = { ...proof, authorization: { ...proof.authorization, nonce: `0x${'11'.repeat(32)}`, from: address() } };
    assert.match((await (await send(forged)).json()).reason, /not from the payer/);
    assert.equal(settles.length, 1);
  });

  test('a guard without a Gateway rail cannot pay a Gateway paywall', async () => {
    const guard = new Guard({ policy: { networks: ['near-testnet'] }, rails: [new MockRail('near-testnet')] });
    await assert.rejects(payingFetch(guard, `${base}/news`), /asks for payment on eip155:5042002; this guard can pay on near-testnet/);
  });
});

describe('Gateway settle and checks', () => {
  const offer = gatewayOffer({ payTo: PAYEES.news, amount: 20_000n });

  test('settleGatewayPayment posts to Gateway and turns every failure into a reason', async () => {
    const calls = [];
    const answer = (status, body) => async (url, init) => (calls.push({ url, body: JSON.parse(init.body) }), new Response(JSON.stringify(body), { status }));
    const ok = await settleGatewayPayment({ x402Version: 2 }, offer, { fetch: answer(200, { success: true, transaction: 'b7c1…', network: 'eip155:5042002' }) });
    assert.deepEqual(ok, { success: true, transaction: 'b7c1…', network: 'eip155:5042002' });
    assert.equal(calls[0].url, 'https://gateway-api-testnet.circle.com/v1/x402/settle');
    assert.deepEqual(calls[0].body, { paymentPayload: { x402Version: 2 }, paymentRequirements: offer });

    const refused = await settleGatewayPayment({}, offer, { fetch: answer(200, { success: false, errorReason: 'nonce_already_used' }) });
    assert.equal(refused.errorReason, 'nonce_already_used');
    const malformed = await settleGatewayPayment({}, offer, { fetch: answer(400, { success: false, message: 'Invalid request: paymentPayload.resource: Required' }) });
    assert.deepEqual([malformed.success, malformed.errorReason], [false, 'Invalid request: paymentPayload.resource: Required']);
    const down = await settleGatewayPayment({}, offer, { fetch: async () => { throw new Error('ECONNRESET'); } });
    assert.deepEqual(down, { success: false, errorReason: 'Gateway unreachable: ECONNRESET' });
  });

  test('checkGatewayAuthorization catches the wrong payee, amount, validity or signer', async () => {
    const { proof } = await railWith().pay(intentFor(offer));
    const a = proof.authorization;
    const t = Math.floor(Date.now() / 1000);
    assert.match(await checkGatewayAuthorization(proof, { ...offer, payTo: PAYEES.thief }), /pays .* not/);
    assert.match(await checkGatewayAuthorization(proof, { ...offer, amount: '20001' }), /is for 20000, not 20001/);
    assert.match(await checkGatewayAuthorization({ ...proof, authorization: { ...a, validBefore: String(t + 3600) } }, offer), /expires before/);
    assert.match(await checkGatewayAuthorization({ ...proof, authorization: { ...a, validAfter: String(t + 3600) } }, offer), /not valid yet/);
    assert.match(await checkGatewayAuthorization({ ...proof, authorization: { ...a, from: address() } }, offer), /not from the payer/);
    assert.match(await checkGatewayAuthorization({ ...proof, authorization: { ...a, value: 'lots' } }, { ...offer, amount: 'lots' }), /malformed/);
    assert.equal(await checkGatewayAuthorization({}, offer), 'not a Gateway authorization');
  });
});
