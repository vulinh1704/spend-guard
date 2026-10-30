import { Account, JsonRpcProvider } from 'near-api-js';

export const NEAR_RPC = {
  'near-testnet': 'https://test.rpc.fastnear.com',
  'near': 'https://free.rpc.fastnear.com',
};

/**
 * Pays in native NEAR from the agent's own account. The account should hold only what the agent
 * may spend: the guard limits what it pays, a small balance limits what a bug could lose.
 */
export class NearRail {
  /**
   * @param {object} options
   * @param {string} options.accountId
   * @param {string} options.privateKey  "ed25519:..."; read from the environment, never committed.
   * @param {string} [options.network]  "near-testnet" (default) or "near".
   * @param {import('near-api-js').JsonRpcProvider} [options.provider]
   */
  constructor({ accountId, privateKey, network = 'near-testnet', provider }) {
    this.network = network;
    this.accountId = accountId;
    this.provider = provider ?? new JsonRpcProvider({ url: NEAR_RPC[network] });
    this.account = new Account(accountId, this.provider, privateKey);
  }

  /** @param {import('../policy.js').Intent} intent */
  async pay(intent) {
    if (intent.asset !== 'near') throw new Error(`NearRail pays in NEAR; ${intent.resource} asked for ${intent.asset}`);
    const outcome = await this.account.transfer({ receiverId: intent.payTo, amount: intent.amount });
    const failure = outcome.status?.Failure;
    if (failure) throw new Error(`NEAR transfer failed: ${JSON.stringify(failure)}`);
    const txid = outcome.transaction.hash;
    return { network: this.network, txid, proof: { txid, sender: this.accountId } };
  }
}

/**
 * The paywall's side: was `txid` a successful transfer from `sender` to `payTo` of at least
 * `amount` yoctoNEAR? Reads the transaction from the chain, so a forged proof gets nowhere.
 *
 * @param {import('near-api-js').JsonRpcProvider} provider
 * @param {{txid: string, sender: string}} proof
 * @param {{payTo: string, amount: bigint}} expected
 * @returns {Promise<string|null>}  null when the payment checks out, otherwise why not.
 */
export async function checkNearPayment(provider, proof, expected) {
  let outcome;
  try {
    outcome = await provider.viewTransactionStatus({ txHash: proof.txid, accountId: proof.sender, waitUntil: 'EXECUTED_OPTIMISTIC' });
  } catch (err) {
    return `transaction ${proof.txid} not found: ${err.message}`;
  }
  if (!('SuccessValue' in (outcome.status ?? {}))) return `transaction ${proof.txid} did not succeed`;
  const tx = outcome.transaction;
  if (tx.receiver_id !== expected.payTo) return `transaction ${proof.txid} paid ${tx.receiver_id}, not ${expected.payTo}`;
  const deposit = tx.actions.reduce((sum, a) => sum + BigInt(a.Transfer?.deposit ?? 0), 0n);
  if (deposit < expected.amount) return `transaction ${proof.txid} paid ${deposit} yoctoNEAR, not ${expected.amount}`;
  return null;
}
