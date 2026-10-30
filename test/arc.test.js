/**
 * The Arc rail and its paywall check against fake clients shaped like viem's: the receipt and its
 * USDC Transfer log are real encodings, the network is not touched.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ARC_USDC, ArcRail, checkArcPayment } from '../src/rails/arc.js';

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

describe('Arc rail', () => {
  test('a USDC transfer returns the tx hash and sender as proof', async () => {
    const rail = new ArcRail({ privateKey: KEY });
    let sent;
    rail.walletClient.writeContract = async (args) => ((sent = args), HASH);
    rail.publicClient.waitForTransactionReceipt = async () => ({ status: 'success' });
    const receipt = await rail.pay(intent);
    assert.equal(sent.address, ARC_USDC);
    assert.equal(sent.functionName, 'transfer');
    assert.deepEqual(sent.args, [PAYEE, 10_000n]);
    assert.deepEqual(receipt, { network: 'arc-testnet', txid: HASH, proof: { txid: HASH, sender: SENDER } });
  });

  test('a reverted transfer throws', async () => {
    const rail = new ArcRail({ privateKey: KEY });
    rail.walletClient.writeContract = async () => HASH;
    rail.publicClient.waitForTransactionReceipt = async () => ({ status: 'reverted' });
    await assert.rejects(rail.pay(intent), /reverted/);
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
});
