/**
 * The NEAR rail against a fake provider: the shapes are the RPC's (a FinalExecutionOutcome),
 * the network is not touched. The testnet run is demo/agent.js with NEAR_* variables set.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { KeyPair } from 'near-api-js';
import { checkNearPayment, NearRail } from '../src/rails/near.js';

// A throwaway key: the rail needs one to build its Account, nothing is signed.
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

describe('NEAR rail', () => {
  test('a transfer returns the tx hash as proof', async () => {
    const rail = new NearRail({ accountId: 'agent.testnet', privateKey: KEY });
    let sent;
    rail.account.transfer = async (args) => ((sent = args), outcome());
    const receipt = await rail.pay(intent);
    assert.deepEqual(sent, { receiverId: 'pay.testnet', amount: 1000n });
    assert.deepEqual(receipt, { network: 'near-testnet', txid: TX, proof: { txid: TX, sender: 'agent.testnet' } });
  });

  test('a failed transfer throws instead of returning a receipt', async () => {
    const rail = new NearRail({ accountId: 'agent.testnet', privateKey: KEY });
    rail.account.transfer = async () => outcome({ success: false });
    await assert.rejects(rail.pay(intent), /NEAR transfer failed/);
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
