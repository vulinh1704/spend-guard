/**
 * The NEAR Intents Agent API rail against a fake API (the shapes are Tidepool's /v1), and the
 * paywall's check against EXPERIMENTAL_tx_status results shaped like the verifier's. Offline: no
 * network, no keys. The testnet runs are demo/agent.js --intents and
 * scripts/intents-leaked-grant.js, recorded in docs/near-testnet-run.md.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { KeyPair } from 'near-api-js';
import { createPaidApi, PAYEES } from '../demo/paid-api.js';
import { Guard, GuardRefused, PaymentPending } from '../src/guard.js';
import { guardFromEnv } from '../src/mcp.js';
import { checkIntentsPayment, IntentsAgentRail, intentsPaymentProblem, nep413Hash, TIDEPOOL_RELAYER, TIDEPOOL_USDC, TIDEPOOL_VERIFIER } from '../src/rails/intents.js';
import { payingFetch } from '../src/x402.js';

const AGENT = 'agent_test';
const WALLET = 'a'.repeat(64);
const TX = 'HyQ4Cr1dyexkQb3iWHk4NA2Y4cxWGVBptVMGmnTTVjLs';
const GRANT = `ngt_${'x'.repeat(43)}`;

/**
 * A fake Agent API: answers transfer with 202 and status with `statuses` in turn, records each
 * request. `refuse` makes the transfer answer 403 with that code.
 */
function fakeApi({ statuses = [{ status: 'SUCCESS', details: { tx_hash: TX } }], refuse, failStatus = 0 } = {}) {
  const calls = [];
  let n = 0;
  let failures = failStatus;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method, path: pathname, query: Object.fromEntries(searchParams), headers: init.headers, body: init.body && JSON.parse(init.body) });
    if (pathname === `/v1/agents/${AGENT}/transfer`) {
      if (refuse) return json(403, { errors: [{ status: '403', code: refuse, layer: 'policy', detail: `refused: ${refuse}` }] });
      return json(202, { correlation_id: 'corr_1', status: 'PROCESSING' });
    }
    if (pathname === '/v1/status') {
      if (failures-- > 0) return json(503, { errors: [{ status: '503', code: 'unavailable' }] });
      return json(200, { correlation_id: 'corr_1', ...statuses[Math.min(n++, statuses.length - 1)] });
    }
    if (pathname === `/v1/agents/${AGENT}/balances`) return json(200, { balances: [{ asset_id: TIDEPOOL_USDC, balance_raw: '99990000' }] });
    return json(404, { errors: [{ status: '404', code: 'not_found' }] });
  };
  return { fetch, calls };
}

const rail = (fetch, options = {}) => new IntentsAgentRail({ apiKey: 'naa_test', agentId: AGENT, grantToken: GRANT, agentAccount: WALLET, fetch, ...options });
const intent = { resource: 'http://api.example/weather', host: 'api.example', network: 'near-intents-testnet', asset: 'usdc', amount: 10_000n, payTo: 'weather.paywall.testnet' };

describe('NEAR Intents Agent API rail', () => {
  test('pays with a transfer through the API, with the grant and an idempotency key, and returns the tx hash as proof', async () => {
    const { fetch, calls } = fakeApi();
    const receipt = await rail(fetch).pay(intent);
    const transfer = calls.find((c) => c.path.endsWith('/transfer'));
    assert.equal(transfer.method, 'POST');
    assert.deepEqual(transfer.body, { asset: TIDEPOOL_USDC, amount: '10000', recipient: 'weather.paywall.testnet' });
    assert.equal(transfer.headers.authorization, 'Bearer naa_test');
    assert.equal(transfer.headers['x-grant-token'], GRANT);
    assert.match(transfer.headers['idempotency-key'], /^spend-guard-[0-9a-f-]{36}$/);
    assert.equal(calls.find((c) => c.path === '/v1/status').query.correlation_id, 'corr_1');
    assert.deepEqual(receipt, { network: 'near-intents-testnet', txid: TX, proof: { txid: TX, sender: WALLET, asset: TIDEPOOL_USDC, correlation_id: 'corr_1' } });
  });

  test('a refusal by the owner\'s policy throws with the API\'s code, and nothing is polled', async () => {
    const { fetch, calls } = fakeApi({ refuse: 'policy_destination_denied' });
    await assert.rejects(rail(fetch).pay(intent), /the NEAR Intents Agent API refused: policy_destination_denied: refused: policy_destination_denied/);
    assert.ok(!calls.some((c) => c.path === '/v1/status'));
  });

  test('waits through PROCESSING, and backs off when a status poll fails', async () => {
    const { fetch, calls } = fakeApi({ statuses: [{ status: 'PROCESSING' }, { status: 'SUCCESS', details: { tx_hash: TX } }], failStatus: 2 });
    const receipt = await rail(fetch).pay(intent);
    assert.equal(receipt.txid, TX);
    assert.equal(calls.filter((c) => c.path === '/v1/status').length, 4);
  });

  test('a failed transfer throws; one still unsettled when the wait ends is pending, not failed', async () => {
    const failed = fakeApi({ statuses: [{ status: 'FAILED', failure_code: 'insufficient_balance' }] });
    await assert.rejects(rail(failed.fetch).pay(intent), /did not make the transfer: FAILED insufficient_balance/);
    const slow = fakeApi({ statuses: [{ status: 'PROCESSING' }] });
    const err = await rail(slow.fetch, { waitMs: 50 }).pay(intent).catch((e) => e);
    assert.ok(err instanceof PaymentPending, String(err));
    assert.deepEqual(err.receipt, { correlationId: 'corr_1' });
  });

  test('only USDC is paid on this rail, and the rail needs its credentials', async () => {
    await assert.rejects(rail(fakeApi().fetch).pay({ ...intent, asset: 'near' }), /pays in USDC/);
    assert.throws(() => new IntentsAgentRail({ apiKey: 'naa_test', agentId: AGENT, agentAccount: WALLET }), /needs grantToken/);
  });

  test('balance reads the agent wallet\'s USDC from the API', async () => {
    assert.equal(await rail(fakeApi().fetch).balance(), 99_990_000n);
  });

  test('nep413Hash is the NEP-413 borsh layout, and a 32-byte nonce is required', () => {
    const payload = { message: '{"a":1}', nonce: Buffer.alloc(32, 7).toString('base64'), recipient: 'verifier.testnet' };
    const u32 = (n) => Buffer.from(Uint32Array.of(n).buffer);
    const borsh = Buffer.concat([u32(2 ** 31 + 413), u32(7), Buffer.from('{"a":1}'), Buffer.alloc(32, 7), u32(16), Buffer.from('verifier.testnet'), Buffer.from([0])]);
    assert.deepEqual(nep413Hash(payload), createHash('sha256').update(borsh).digest());
    const key = KeyPair.fromRandom('ed25519');
    assert.ok(key.verify(nep413Hash(payload), key.sign(nep413Hash(payload)).signature));
    assert.throws(() => nep413Hash({ ...payload, nonce: Buffer.alloc(31).toString('base64') }), /32 bytes/);
  });
});

/** An EXPERIMENTAL_tx_status result for an execute_intents call with the given verifier logs. */
function verifierTx(logs, { receiver = TIDEPOOL_VERIFIER, executor = TIDEPOOL_VERIFIER, status = { SuccessValue: '' } } = {}) {
  return {
    transaction: { hash: TX, signer_id: TIDEPOOL_RELAYER, receiver_id: receiver },
    receipts_outcome: [{ id: 'r1', outcome: { executor_id: executor, status, logs } }],
  };
}
const mtTransfer = (data) => `EVENT_JSON:${JSON.stringify({ standard: 'nep245', version: '1.0.0', event: 'mt_transfer', data })}`;
const paid = (to = 'weather.paywall.testnet', amount = '10000', token = TIDEPOOL_USDC, from = WALLET) => mtTransfer([{ old_owner_id: from, new_owner_id: to, token_ids: [token], amounts: [amount] }]);
const proof = { txid: TX, sender: WALLET };
const expected = { payTo: 'weather.paywall.testnet', amount: 10_000n };

describe('checkIntentsPayment', () => {
  test('accepts the verifier\'s mt_transfer of enough USDC from the agent to the payee', () => {
    assert.equal(intentsPaymentProblem(verifierTx([paid()]), proof, expected), null);
    assert.equal(intentsPaymentProblem(verifierTx([paid('weather.paywall.testnet', '4000'), paid('weather.paywall.testnet', '6000')]), proof, expected), null);
  });

  test('refuses another payee, too little, another token or another sender', () => {
    assert.match(intentsPaymentProblem(verifierTx([paid('rnaps.paywall.testnet')]), proof, expected), /to rnaps\.paywall\.testnet, not weather\.paywall\.testnet/);
    assert.match(intentsPaymentProblem(verifierTx([paid(undefined, '9999')]), proof, expected), /moved 9999 of .*, not 10000/);
    assert.match(intentsPaymentProblem(verifierTx([paid(undefined, '10000', 'nep141:usdt.tidepool-sandbox.testnet')]), proof, expected), /moved no/);
    assert.match(intentsPaymentProblem(verifierTx([paid(undefined, '10000', TIDEPOOL_USDC, 'b'.repeat(64))]), proof, expected), /moved no/);
  });

  test('ignores logs from a failed receipt, from another contract, or that are not events', () => {
    assert.match(intentsPaymentProblem(verifierTx([paid()], { status: { Failure: {} } }), proof, expected), /moved no/);
    assert.match(intentsPaymentProblem(verifierTx([paid()], { executor: 'fake-verifier.testnet' }), proof, expected), /moved no/);
    assert.match(intentsPaymentProblem(verifierTx(['mt_transfer weather 10000', 'EVENT_JSON:{not json']), proof, expected), /moved no/);
    assert.match(intentsPaymentProblem(verifierTx([paid()], { receiver: 'other.testnet' }), proof, expected), /was not sent to the verifier/);
  });

  test('asks RPC for the transaction by its relayer, and reports one it can\'t find', async () => {
    let asked;
    const provider = { viewTransactionStatusWithReceipts: async (q) => ((asked = q), verifierTx([paid()])) };
    assert.equal(await checkIntentsPayment(provider, proof, expected), null);
    assert.deepEqual(asked, { txHash: TX, accountId: TIDEPOOL_RELAYER, waitUntil: 'EXECUTED_OPTIMISTIC' });
    const missing = { viewTransactionStatusWithReceipts: async () => { throw new Error('UNKNOWN_TRANSACTION'); } };
    assert.match(await checkIntentsPayment(missing, proof, expected), /not found: UNKNOWN_TRANSACTION/);
    assert.equal(await checkIntentsPayment(provider, { txid: TX }, expected), 'the proof needs txid and sender');
  });
});

describe('the Agent API rail behind the guard', () => {
  test('the guard pays an honest endpoint through the API, and refuses the injected payee before the API is called', async (t) => {
    const { fetch, calls } = fakeApi();
    const r = rail(fetch);
    const server = createPaidApi({ network: 'near-intents-testnet', asset: 'usdc', verify: async (p, e) => intentsPaymentProblem(verifierTx([paid(e.payTo, String(e.amount))]), p, e) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const guard = new Guard({ policy: { networks: ['near-intents-testnet'], dailyUsd: 1, perPaymentUsd: 0.5, askAboveUsd: 0.25, spikeRatio: 5, services: { [new URL(base).host]: { payTo: [PAYEES.weather, PAYEES.news, PAYEES.quotes, PAYEES.maps] } } }, rails: [r] });

    const res = await payingFetch(guard, `${base}/weather`);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(calls.filter((c) => c.path.endsWith('/transfer')).length, 1);
    const err = await payingFetch(guard, `${base}/licence`).catch((e) => e);
    assert.ok(err instanceof GuardRefused);
    assert.equal(err.reasons[0].code, 'payee-swap');
    assert.equal(calls.filter((c) => c.path.endsWith('/transfer')).length, 1, 'the API was never asked to pay rnaps.');
  });

  test('guardFromEnv: intents builds the rail from the agent\'s variables only', async () => {
    const env = { SPEND_GUARD_LEDGER: 'off', SPEND_GUARD_RAILS: 'intents', INTENTS_API_KEY: 'naa_test', INTENTS_AGENT_ID: AGENT, INTENTS_GRANT_TOKEN: GRANT, INTENTS_AGENT_ACCOUNT: WALLET };
    const guard = await guardFromEnv(env);
    assert.deepEqual(guard.networks, ['near-intents-testnet']);
    assert.ok(guard.rails.get('near-intents-testnet') instanceof IntentsAgentRail);
    await assert.rejects(guardFromEnv({ ...env, INTENTS_GRANT_TOKEN: '' }), /INTENTS_GRANT_TOKEN is not set/);
    // It pays on its own network, so it sits next to the NEAR rails.
    const both = await guardFromEnv({ ...env, SPEND_GUARD_RAILS: 'near-guard,intents', NEAR_GUARD_ID: 'guard.owner.testnet', NEAR_GUARD_AGENT_KEY: KeyPair.fromRandom('ed25519').toString() });
    assert.deepEqual(both.networks, ['near-testnet', 'near-intents-testnet']);
  });
});
