/**
 * The NEAR rail against a fake provider: the shapes are the RPC's (a FinalExecutionOutcome),
 * the network is not touched. The testnet run is demo/agent.js with NEAR_* variables set.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { baseEncode, createTransaction, KeyPair } from 'near-api-js';
import { PaymentUnconfirmed } from '../src/guard.js';
import { checkNearPayment, NearRail } from '../src/rails/near.js';

// A throwaway key: the rail signs with it, nothing is sent.
const KEY = KeyPair.fromRandom('ed25519').toString();
const TX = 'HyQ4Cr1dyexkQb3iWHk4NA2Y4cxWGVBptVMGmnTTVjLs';

function outcome({ receiver = 'pay.testnet', deposit = '1000', success = true } = {}) {
  return {
    status: success ? { SuccessValue: '' } : { Failure: { ActionError: { index: 0 } } },
    transaction: { hash: TX, signer_id: 'agent.testnet', receiver_id: receiver, actions: [{ Transfer: { deposit } }] },
  };
}

function fakeProvider(result) {
  return { viewTransactionStatus: async () => (result instanceof Error ? Promise.reject(result) : result) };
}

const intent = { resource: 'https://api.example/x', host: 'api.example', network: 'near-testnet', asset: 'near', amount: 1000n, payTo: 'pay.testnet' };

/**
 * A NEAR rail whose account signs with the rail's signer as near-api-js does, then answers with
 * `then(sent)` instead of sending: `sent` has the receiver, the actions and the signed id.
 */
function fakeNearRail(then) {
  const rail = new NearRail({ accountId: 'agent.testnet', privateKey: KEY });
  rail.account.signAndSendTransaction = async ({ receiverId, actions, signer, throwOnFailure }) => {
    const tx = createTransaction('agent.testnet', await signer.getPublicKey(), receiverId, 1n, actions, new Uint8Array(32));
    const { txHash } = await signer.signTransaction(tx);
    return then({ receiverId, actions, throwOnFailure, txid: baseEncode(txHash) });
  };
  return rail;
}

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
});

describe('checkNearPayment', () => {
  const proof = { txid: TX, sender: 'agent.testnet' };
  const expected = { payTo: 'pay.testnet', amount: 1000n };

  test('accepts a successful transfer of enough to the right account', async () => {
    assert.equal(await checkNearPayment(fakeProvider(outcome()), proof, expected), null);
  });

  test('rejects the wrong receiver, too little, a failure, or an unknown tx', async () => {
    assert.match(await checkNearPayment(fakeProvider(outcome({ receiver: 'other.testnet' })), proof, expected), /paid other\.testnet/);
    assert.match(await checkNearPayment(fakeProvider(outcome({ deposit: '999' })), proof, expected), /paid 999 yoctoNEAR/);
    assert.match(await checkNearPayment(fakeProvider(outcome({ success: false })), proof, expected), /did not succeed/);
    assert.match(await checkNearPayment(fakeProvider(new Error('UNKNOWN_TRANSACTION')), proof, expected), /not found/);
  });
});
