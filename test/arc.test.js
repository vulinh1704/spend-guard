/**
 * The Arc rail and its paywall check against fake clients shaped like viem's: the receipt and its
 * USDC Transfer log are real encodings, the network is not touched.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PaymentUnconfirmed } from '../src/guard.js';
import { ARC_USDC, ArcRail, arcTestnet, checkArcPayment } from '../src/rails/arc.js';

const KEY = generatePrivateKey();
const SENDER = privateKeyToAccount(KEY).address;
const PAYEE = privateKeyToAccount(generatePrivateKey()).address;
const OTHER = privateKeyToAccount(generatePrivateKey()).address;
const HASH = `0x${'ab'.repeat(32)}`;

function transferLog({ from = SENDER, to = PAYEE, value = 10_000n, token = ARC_USDC } = {}) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockHash: `0x${'00'.repeat(32)}`, blockNumber: 1n, logIndex: 0, transactionHash: HASH, transactionIndex: 0, removed: false,
  };
}

const clientWith = (receipt) => ({ getTransactionReceipt: async () => (receipt instanceof Error ? Promise.reject(receipt) : receipt) });
const intent = { resource: 'https://api.example/x', host: 'api.example', network: 'arc-testnet', asset: 'usdc', amount: 10_000n, payTo: PAYEE };

/**
 * An Arc rail that signs for real but whose RPC is faked: `sent` collects the raw transactions it
 * broadcasts, `send` and `receipt` say how the chain answers.
 */
function fakeArcRail({ receipt = { status: 'success' }, send } = {}) {
  const rail = new ArcRail({ privateKey: KEY });
  const sent = [];
  rail.walletClient.prepareTransactionRequest = async (args) => ({ ...args, chainId: arcTestnet.id, nonce: 0, gas: 60_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, type: 'eip1559' });
  rail.walletClient.sendRawTransaction = async ({ serializedTransaction }) => {
    sent.push(serializedTransaction);
    return send ? send() : keccak256(serializedTransaction);
  };
  rail.publicClient.waitForTransactionReceipt = async () => (receipt instanceof Error ? Promise.reject(receipt) : receipt);
  return { rail, sent };
}

describe('Arc rail', () => {
  test('a USDC transfer is signed, sent, and returns its hash and sender as proof', async () => {
    const { rail, sent } = fakeArcRail();
    const receipt = await rail.pay(intent);
    const tx = parseTransaction(sent[0]);
    assert.equal(tx.to, ARC_USDC);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: tx.data }), { functionName: 'transfer', args: [PAYEE, 10_000n] });
    const hash = keccak256(sent[0]);
    assert.deepEqual(receipt, { network: 'arc-testnet', txid: hash, proof: { txid: hash, sender: SENDER } });
  });

  test('a reverted transfer throws', async () => {
    const { rail } = fakeArcRail({ receipt: { status: 'reverted' } });
    await assert.rejects(rail.pay(intent), (err) => !(err instanceof PaymentUnconfirmed) && /reverted/.test(err.message));
  });

  test('a transfer sent but not confirmed in time is unconfirmed, with its transaction id', async () => {
    const { rail, sent } = fakeArcRail({ receipt: new Error('Timed out while waiting for transaction') });
    await assert.rejects(rail.pay(intent), (err) => err instanceof PaymentUnconfirmed && err.txid === keccak256(sent[0]) && /was sent but not confirmed: Timed out/.test(err.message));
  });

  test('a send that breaks off may still have reached the chain, so it is unconfirmed too', async () => {
    const { rail, sent } = fakeArcRail({ send: () => Promise.reject(new Error('fetch failed')) });
    await assert.rejects(rail.pay(intent), (err) => err instanceof PaymentUnconfirmed && err.txid === keccak256(sent[0]));
  });

  test('a transfer that fails before it is sent fails outright', async () => {
    const { rail, sent } = fakeArcRail();
    rail.walletClient.prepareTransactionRequest = () => Promise.reject(new Error('insufficient funds for gas'));
    await assert.rejects(rail.pay(intent), (err) => !(err instanceof PaymentUnconfirmed) && /insufficient funds/.test(err.message));
    assert.equal(sent.length, 0);
  });

  test('only USDC is paid on this rail', async () => {
    await assert.rejects(new ArcRail({ privateKey: KEY }).pay({ ...intent, asset: 'near' }), /pays in USDC/);
  });
});

describe('checkArcPayment', () => {
  const proof = { txid: HASH, sender: SENDER };
  const expected = { payTo: PAYEE, amount: 10_000n };

  test('accepts a successful USDC transfer of enough to the payee', async () => {
    assert.equal(await checkArcPayment(clientWith({ status: 'success', logs: [transferLog()] }), proof, expected), null);
  });

  test('rejects the wrong payee, another token, too little, a revert or an unknown tx', async () => {
    assert.match(await checkArcPayment(clientWith({ status: 'success', logs: [transferLog({ to: OTHER })] }), proof, expected), /no USDC transfer/);
    assert.match(await checkArcPayment(clientWith({ status: 'success', logs: [transferLog({ token: OTHER })] }), proof, expected), /no USDC transfer/);
    assert.match(await checkArcPayment(clientWith({ status: 'success', logs: [transferLog({ value: 9_999n })] }), proof, expected), /paid 9999/);
    assert.match(await checkArcPayment(clientWith({ status: 'reverted', logs: [] }), proof, expected), /did not succeed/);
    assert.match(await checkArcPayment(clientWith(new Error('not found')), proof, expected), /not found/);
  });

  test('takes the hash only as 0x and 64 hex digits, so a paywall keying on it sees one spelling per payment', async () => {
    const chain = { getTransactionReceipt: async () => assert.fail('the chain was asked') };
    for (const txid of [`0X${HASH.slice(2)}`, HASH.slice(2), `${HASH}00`, HASH.slice(0, -2), ` ${HASH}`, 42, undefined]) {
      assert.match(await checkArcPayment(chain, { ...proof, txid }, expected), /is not a transaction hash/, String(txid));
    }
    // Any letter case is the same hash: the paywall lowercases it before its replay check.
    assert.equal(await checkArcPayment(clientWith({ status: 'success', logs: [transferLog()] }), { ...proof, txid: HASH.toUpperCase().replace('0X', '0x') }, expected), null);
  });
});
