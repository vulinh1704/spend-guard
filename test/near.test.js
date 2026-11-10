/**
 * The NEAR rails against a fake provider: the shapes are the RPC's (a FinalExecutionOutcome, and
 * EXPERIMENTAL_tx_status with its receipts), the network is not touched. The testnet runs are
 * demo/agent.js with NEAR_* variables set, and scripts/near-verify.js checks a recorded one.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { baseEncode, createTransaction, KeyPair } from 'near-api-js';
import { PaymentUnconfirmed } from '../src/guard.js';
import { checkNearPayment, contractError, GUARD_PAY_GAS, NearGuardRail, nearPaymentProblem, NearRail } from '../src/rails/near.js';

// A throwaway key: the rail signs with it, nothing is sent.
const KEY = KeyPair.fromRandom('ed25519').toString();
const TX = 'HyQ4Cr1dyexkQb3iWHk4NA2Y4cxWGVBptVMGmnTTVjLs';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64');

/** What signAndSendTransaction returns for a plain transfer. */
function outcome({ receiver = 'pay.testnet', deposit = '1000', success = true } = {}) {
  return {
    status: success ? { SuccessValue: '' } : { Failure: { ActionError: { index: 0 } } },
    transaction: { hash: TX, signer_id: 'agent.testnet', receiver_id: receiver, actions: [{ Transfer: { deposit } }] },
  };
}

/** A receipt and its outcome, as EXPERIMENTAL_tx_status lists them. */
function receipt(id, from, to, actions, status = { SuccessValue: '' }) {
  return { receipt: { receipt_id: id, predecessor_id: from, receiver_id: to, receipt: { Action: { actions } } }, outcome: { id, outcome: { executor_id: to, status } } };
}

function txStatus(signer, receiver, txActions, parts, status = { SuccessValue: '' }) {
  return {
    status,
    transaction: { hash: TX, signer_id: signer, receiver_id: receiver, actions: txActions },
    receipts: parts.map((p) => p.receipt),
    receipts_outcome: parts.map((p) => p.outcome),
  };
}

/** EXPERIMENTAL_tx_status for a plain transfer from the agent (NearRail), with its gas refund. */
function transferStatus({ receiver = 'pay.testnet', deposit = '1000', success = true } = {}) {
  const status = success ? { SuccessValue: '' } : { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: receiver } } } } };
  return txStatus('agent.testnet', receiver, [{ Transfer: { deposit } }], [
    receipt('r1', 'agent.testnet', receiver, [{ Transfer: { deposit } }], status),
    receipt('r2', 'system', 'agent.testnet', [{ Transfer: { deposit: '200864306250000000000' } }]),
  ], status);
}

/** EXPERIMENTAL_tx_status for pay() on the guard contract (NearGuardRail): call, transfer, callback. */
function guardStatus({ receiver = 'pay.testnet', deposit = '1000', transferOk = true } = {}) {
  const transfer = transferOk ? { SuccessValue: '' } : { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: receiver } } } } };
  const parts = [
    receipt('c1', 'guard.testnet', 'guard.testnet', [{ FunctionCall: { method_name: 'pay', deposit: '0' } }], { SuccessReceiptId: 'c3' }),
    receipt('c2', 'guard.testnet', receiver, [{ Transfer: { deposit } }], transfer),
    receipt('c3', 'guard.testnet', 'guard.testnet', [{ FunctionCall: { method_name: 'on_pay_done', deposit: '0' } }], { SuccessValue: b64(transferOk) }),
  ];
  if (!transferOk) parts.push(receipt('c4', 'system', 'guard.testnet', [{ Transfer: { deposit } }]));
  return txStatus('guard.testnet', 'guard.testnet', [{ FunctionCall: { method_name: 'pay', deposit: '0' } }], parts, { SuccessValue: b64(transferOk) });
}

function fakeProvider(result) {
  return { viewTransactionStatusWithReceipts: async () => (result instanceof Error ? Promise.reject(result) : result) };
}

const intent = { resource: 'https://api.example/x', host: 'api.example', network: 'near-testnet', asset: 'near', amount: 1000n, payTo: 'pay.testnet' };

/**
 * A rail whose account signs with the rail's signer as near-api-js does, then answers with
 * `then(sent)` instead of sending: `sent` has the receiver, the actions and the signed id.
 */
function fake(rail, signerId, then) {
  rail.account.signAndSendTransaction = async ({ receiverId, actions, signer, throwOnFailure }) => {
    const tx = createTransaction(signerId, await signer.getPublicKey(), receiverId, 1n, actions, new Uint8Array(32));
    const { txHash } = await signer.signTransaction(tx);
    return then({ receiverId, actions, throwOnFailure, txid: baseEncode(txHash) });
  };
  return rail;
}
const fakeNearRail = (then) => fake(new NearRail({ accountId: 'agent.testnet', privateKey: KEY }), 'agent.testnet', then);
const fakeGuardRail = (then) => fake(new NearGuardRail({ guardId: 'guard.testnet', privateKey: KEY }), 'guard.testnet', then);

describe('NEAR rail', () => {
  test('a transfer returns the tx hash as proof', async () => {
    let sent;
    const rail = fakeNearRail((s) => ((sent = s), outcome()));
    const receipt = await rail.pay(intent);
    assert.equal(sent.receiverId, 'pay.testnet');
    assert.deepEqual(sent.actions.map((a) => a.transfer?.deposit), [1000n]);
    assert.equal(sent.throwOnFailure, false, 'a failed outcome is read here, not thrown as if it were unknown');
    assert.deepEqual(receipt, { network: 'near-testnet', txid: TX, proof: { txid: TX, sender: 'agent.testnet' } });
  });

  test('a failed transfer throws instead of returning a receipt', async () => {
    const rail = fakeNearRail(() => outcome({ success: false }));
    await assert.rejects(rail.pay(intent), (err) => !(err instanceof PaymentUnconfirmed) && /NEAR transfer failed/.test(err.message));
  });

  test('a transfer signed and then lost in the RPC is unconfirmed, with its transaction id', async () => {
    let txid;
    const rail = fakeNearRail((sent) => {
      txid = sent.txid;
      throw new Error('Transaction has been routed but not executed yet');
    });
    await assert.rejects(rail.pay(intent), (err) => err instanceof PaymentUnconfirmed && err.txid === txid && /was sent but not confirmed/.test(err.message));
  });

  test('a transfer that fails before it is signed fails outright', async () => {
    const rail = new NearRail({ accountId: 'agent.testnet', privateKey: KEY });
    rail.account.signAndSendTransaction = () => Promise.reject(new Error('access key does not exist'));
    await assert.rejects(rail.pay(intent), (err) => !(err instanceof PaymentUnconfirmed) && /access key/.test(err.message));
  });

  test('only NEAR is paid on this rail', async () => {
    const rail = new NearRail({ accountId: 'agent.testnet', privateKey: KEY });
    await assert.rejects(rail.pay({ ...intent, asset: 'usdc' }), /pays in NEAR/);
  });

  test('balance reads the account from the RPC', async () => {
    const rail = new NearRail({ accountId: 'agent.testnet', privateKey: KEY, provider: { viewAccount: async ({ accountId }) => ({ amount: accountId === 'agent.testnet' ? '9919000000000000000000000' : '0' }) } });
    assert.equal(await rail.balance(), 9_919_000_000_000_000_000_000_000n);
  });
});

describe('NEAR guard contract rail', () => {
  test('pays by calling pay() on the guard, with no deposit, and returns the tx hash as proof', async () => {
    let sent;
    const rail = fakeGuardRail((s) => ((sent = s), { status: { SuccessValue: b64(true) }, transaction: { hash: TX } }));
    const receipt = await rail.pay(intent);
    assert.equal(sent.receiverId, 'guard.testnet', 'the only receiver a function-call key on the guard may call');
    assert.equal(sent.actions.length, 1);
    const call = sent.actions[0].functionCall;
    assert.equal(call.methodName, 'pay');
    assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), { receiver: 'pay.testnet', amount: '1000' });
    assert.equal(call.deposit, 0n, 'a function-call key cannot attach a deposit');
    assert.equal(call.gas, GUARD_PAY_GAS);
    assert.equal(sent.throwOnFailure, false);
    assert.deepEqual(receipt, { network: 'near-testnet', txid: TX, proof: { txid: TX, sender: 'guard.testnet' } });
  });

  test('a refusal by the contract throws with its reason', async () => {
    const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: rnaps.paywall.testnet is not on the allowlist' } } } };
    const rail = fakeGuardRail(() => ({ status: { Failure: failure }, transaction: { hash: TX } }));
    await assert.rejects(rail.pay({ ...intent, payTo: 'rnaps.paywall.testnet' }), (err) => !(err instanceof PaymentUnconfirmed) && err.message === 'the guard contract refused: rnaps.paywall.testnet is not on the allowlist');
  });

  test('a transfer that failed inside pay() is not a payment', async () => {
    const rail = fakeGuardRail(() => ({ status: { SuccessValue: b64(false) }, transaction: { hash: TX } }));
    await assert.rejects(rail.pay(intent), /approved the payment but the transfer to pay\.testnet failed/);
  });

  test('a call signed and then lost in the RPC is unconfirmed', async () => {
    let txid;
    const rail = fakeGuardRail((sent) => {
      txid = sent.txid;
      throw new Error('timeout');
    });
    await assert.rejects(rail.pay(intent), (err) => err instanceof PaymentUnconfirmed && err.txid === txid);
  });

  test('only NEAR is paid on this rail', async () => {
    const rail = new NearGuardRail({ guardId: 'guard.testnet', privateKey: KEY });
    await assert.rejects(rail.pay({ ...intent, asset: 'usdc' }), /pays in NEAR/);
  });

  test('getPolicy is a view call on the guard', async () => {
    let asked;
    const provider = { callFunction: async (q) => ((asked = q), { daily_cap: '1' }) };
    const rail = new NearGuardRail({ guardId: 'guard.testnet', privateKey: KEY, provider });
    assert.deepEqual(await rail.getPolicy(), { daily_cap: '1' });
    assert.deepEqual(asked, { contractId: 'guard.testnet', method: 'get_policy', args: {} });
  });

  test('contractError reads the panic message, or shows the failure', () => {
    assert.equal(contractError({ ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: the guard is paused' } } } }), 'the guard is paused');
    assert.equal(contractError({ ActionError: { kind: { AccountDoesNotExist: { account_id: 'x' } } } }), '{"AccountDoesNotExist":{"account_id":"x"}}');
  });
});

describe('checkNearPayment', () => {
  const proof = { txid: TX, sender: 'agent.testnet' };
  const expected = { payTo: 'pay.testnet', amount: 1000n };

  test('accepts a successful transfer of enough to the right account', async () => {
    assert.equal(await checkNearPayment(fakeProvider(transferStatus()), proof, expected), null);
    assert.equal(await checkNearPayment(fakeProvider(transferStatus({ deposit: '1500' })), proof, expected), null);
  });

  test('rejects the wrong receiver, too little, a failure, or an unknown tx', async () => {
    assert.match(await checkNearPayment(fakeProvider(transferStatus({ receiver: 'other.testnet' })), proof, expected), /paid other\.testnet, not pay\.testnet/);
    assert.match(await checkNearPayment(fakeProvider(transferStatus({ deposit: '999' })), proof, expected), /paid 999 yoctoNEAR/);
    assert.match(await checkNearPayment(fakeProvider(transferStatus({ success: false })), proof, expected), /did not succeed/);
    assert.match(await checkNearPayment(fakeProvider(new Error('UNKNOWN_TRANSACTION')), proof, expected), /not found/);
  });

  test('asks the RPC for the receipts of the sender\'s transaction', async () => {
    let asked;
    const provider = { viewTransactionStatusWithReceipts: async (q) => ((asked = q), transferStatus()) };
    await checkNearPayment(provider, proof, expected);
    assert.deepEqual(asked, { txHash: TX, accountId: 'agent.testnet', waitUntil: 'EXECUTED_OPTIMISTIC' });
  });

  test('a gas refund is not a payment, even to the payee', () => {
    const refundOnly = txStatus('pay.testnet', 'x.testnet', [], [receipt('r', 'system', 'pay.testnet', [{ Transfer: { deposit: '5000' } }])]);
    assert.match(nearPaymentProblem(refundOnly, { txid: TX, sender: 'pay.testnet' }, expected), /paid nothing to pay\.testnet/);
  });

  test('a transaction signed by someone else is refused', () => {
    assert.match(nearPaymentProblem(transferStatus(), { txid: TX, sender: 'mallory.testnet' }, expected), /signed by agent\.testnet, not mallory\.testnet/);
  });
});

describe('checkNearPayment on a guard contract payment', () => {
  const proof = { txid: TX, sender: 'guard.testnet' };
  const expected = { payTo: 'pay.testnet', amount: 1000n };

  test('accepts the transfer the contract made inside pay()', () => {
    assert.equal(nearPaymentProblem(guardStatus(), proof, expected), null);
  });

  test('refuses when the transfer inside pay() failed, though the transaction succeeded', () => {
    assert.match(nearPaymentProblem(guardStatus({ transferOk: false }), proof, expected), /did not succeed|paid nothing/);
  });

  test('refuses a pay() to another account or for less', () => {
    assert.match(nearPaymentProblem(guardStatus({ receiver: 'other.testnet' }), proof, expected), /paid other\.testnet, not pay\.testnet/);
    assert.match(nearPaymentProblem(guardStatus({ deposit: '10' }), proof, expected), /paid 10 yoctoNEAR, not 1000/);
  });

  test('refuses a pay() the contract refused', () => {
    const refused = txStatus('guard.testnet', 'guard.testnet', [{ FunctionCall: { method_name: 'pay', deposit: '0' } }], [
      receipt('c1', 'guard.testnet', 'guard.testnet', [{ FunctionCall: { method_name: 'pay', deposit: '0' } }], { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: x' } } } } }),
    ], { Failure: { ActionError: { index: 0 } } });
    assert.match(nearPaymentProblem(refused, proof, expected), /did not succeed/);
  });
});
