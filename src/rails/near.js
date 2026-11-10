import { Account, actions, baseEncode, JsonRpcProvider } from 'near-api-js';
import { PaymentUnconfirmed } from '../guard.js';

export const NEAR_RPC = {
  'near-testnet': 'https://test.rpc.fastnear.com',
  'near': 'https://free.rpc.fastnear.com',
};

/**
 * Archival RPC: a regular node forgets a transaction after a few days, so checking an old run
 * (scripts/near-verify.js) needs one of these.
 */
export const NEAR_ARCHIVAL_RPC = {
  'near-testnet': ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'],
  'near': ['https://archival-rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.near.org'],
};

/** Gas for one call to the guard contract's pay(): the call, the transfer and the callback. */
export const GUARD_PAY_GAS = 30_000_000_000_000n;

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
    const outcome = await signAndSend(this.account, intent.payTo, [actions.transfer(intent.amount)]);
    const failure = outcome.status?.Failure;
    if (failure) throw new Error(`NEAR transfer failed: ${JSON.stringify(failure)}`);
    const txid = outcome.transaction.hash;
    return { network: this.network, txid, proof: { txid, sender: this.accountId } };
  }

  /** The agent account's balance in yoctoNEAR, for the demo's before and after. */
  async balance() {
    const { amount } = await this.provider.viewAccount({ accountId: this.accountId });
    return BigInt(amount);
  }
}

/**
 * Pays through Spend Guard's contract on NEAR (contracts/near-guard). The NEAR sits in the guard
 * contract's account, and this rail signs with a function-call key on that account that may only
 * call pay(). The contract checks the payee against its allowlist and the amount against its
 * per-payment and daily caps, so those limits hold even for someone who steals this key: a
 * function-call key can't attach a deposit, sign a transfer or call the owner's methods.
 *
 * The off-chain guard still decides first (price spikes, unknown services, a person's Approve);
 * the contract is the hard limit underneath it.
 */
export class NearGuardRail {
  /**
   * @param {object} options
   * @param {string} options.guardId  The guard contract's account, e.g. "guard.owner.testnet".
   * @param {string} options.privateKey  The agent's function-call key on that account.
   * @param {string} [options.network]  "near-testnet" (default) or "near".
   * @param {import('near-api-js').JsonRpcProvider} [options.provider]
   * @param {bigint} [options.gas]
   */
  constructor({ guardId, privateKey, network = 'near-testnet', provider, gas = GUARD_PAY_GAS }) {
    this.network = network;
    this.guardId = guardId;
    this.gas = gas;
    this.provider = provider ?? new JsonRpcProvider({ url: NEAR_RPC[network] });
    this.account = new Account(guardId, this.provider, privateKey);
  }

  /** @param {import('../policy.js').Intent} intent */
  async pay(intent) {
    if (intent.asset !== 'near') throw new Error(`NearGuardRail pays in NEAR; ${intent.resource} asked for ${intent.asset}`);
    const args = { receiver: intent.payTo, amount: intent.amount.toString() };
    const outcome = await signAndSend(this.account, this.guardId, [actions.functionCall('pay', args, this.gas, 0n)]);
    const failure = outcome.status?.Failure;
    // The contract refused before any NEAR moved: off the allowlist, over a cap, paused.
    if (failure) throw new Error(`the guard contract refused: ${contractError(failure)}`);
    // pay() ends in on_pay_done, which returns false when the transfer itself failed (a payee
    // account that does not exist, say); the contract then got the NEAR back.
    if (decodeValue(outcome.status?.SuccessValue) !== true) {
      throw new Error(`the guard contract approved the payment but the transfer to ${intent.payTo} failed`);
    }
    const txid = outcome.transaction.hash;
    return { network: this.network, txid, proof: { txid, sender: this.guardId } };
  }

  /** The contract's policy as it stands on chain (a view call: no key, no gas). */
  getPolicy() {
    return this.provider.callFunction({ contractId: this.guardId, method: 'get_policy', args: {} });
  }

  /** The guard account's balance in yoctoNEAR, for the demo's before and after. */
  async balance() {
    const { amount } = await this.provider.viewAccount({ accountId: this.guardId });
    return BigInt(amount);
  }
}

/**
 * Signs and sends `acts` to `receiverId`, keeping the signed transaction's id: once signed it may
 * be sent, so an error from then on (an RPC timeout, say) does not mean nothing was paid, only
 * that it is not confirmed.
 */
async function signAndSend(account, receiverId, acts) {
  const { signer } = account;
  let signed = null;
  const keepId = {
    getPublicKey: () => signer.getPublicKey(),
    signTransaction: async (tx) => {
      const result = await signer.signTransaction(tx);
      signed = baseEncode(result.txHash);
      return result;
    },
  };
  try {
    // A failure on chain comes back in the outcome, and is read by the caller as a failure.
    return await account.signAndSendTransaction({ receiverId, actions: acts, signer: keepId, throwOnFailure: false });
  } catch (err) {
    if (signed) throw new PaymentUnconfirmed(signed, err);
    throw err;
  }
}

/** "9.919230" for 9.91923 NEAR given in yoctoNEAR, rounded to `digits` decimals. */
export function formatNear(yocto, digits = 6) {
  const negative = yocto < 0n;
  const abs = negative ? -yocto : yocto;
  const scale = 10n ** BigInt(24 - digits);
  const rounded = (abs + scale / 2n) / scale;
  const unit = 10n ** BigInt(digits);
  return `${negative ? '-' : ''}${rounded / unit}.${(rounded % unit).toString().padStart(digits, '0')}`;
}

/** The panic message in a failed function call, or the failure as JSON. */
export function contractError(failure) {
  const kind = failure?.ActionError?.kind;
  const exec = kind?.FunctionCallError?.ExecutionError;
  if (typeof exec === 'string') return exec.replace(/^Smart contract panicked: /, '');
  return JSON.stringify(kind ?? failure);
}

function decodeValue(base64) {
  if (typeof base64 !== 'string' || base64 === '') return undefined;
  try {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The paywall's side: did transaction `txid` (signed by `sender`) pay `payTo` at least `amount`
 * yoctoNEAR? Reads the transaction and all its receipts from the chain (EXPERIMENTAL_tx_status),
 * so a forged proof gets nowhere.
 *
 * It counts the Transfer receipts to `payTo` that succeeded, which covers both a plain transfer
 * from the agent (NearRail) and a transfer the guard contract made inside pay() (NearGuardRail).
 * The transaction's own status is not enough for the second: pay() succeeds even when its
 * transfer fails, and returns false.
 *
 * @param {Pick<import('near-api-js').JsonRpcProvider, 'viewTransactionStatusWithReceipts'>} provider
 * @param {{txid: string, sender: string}} proof
 * @param {{payTo: string, amount: bigint}} expected
 * @returns {Promise<string|null>}  null when the payment checks out, otherwise why not.
 */
export async function checkNearPayment(provider, proof, expected) {
  let outcome;
  try {
    outcome = await provider.viewTransactionStatusWithReceipts({ txHash: proof.txid, accountId: proof.sender, waitUntil: 'EXECUTED_OPTIMISTIC' });
  } catch (err) {
    return `transaction ${proof.txid} not found: ${err.message}`;
  }
  return nearPaymentProblem(outcome, proof, expected);
}

/**
 * The check in checkNearPayment, on an EXPERIMENTAL_tx_status result already fetched.
 *
 * @param {object} outcome
 * @param {{txid: string, sender: string}} proof
 * @param {{payTo: string, amount: bigint}} expected
 * @returns {string|null}
 */
export function nearPaymentProblem(outcome, proof, expected) {
  const signer = outcome?.transaction?.signer_id;
  if (signer !== proof.sender) return `transaction ${proof.txid} was signed by ${signer}, not ${proof.sender}`;
  const succeeded = new Set(
    (outcome.receipts_outcome ?? [])
      .filter((o) => o.outcome?.status && !('Failure' in o.outcome.status))
      .map((o) => o.id),
  );
  let paid = 0n;
  const others = new Set();
  for (const r of outcome.receipts ?? []) {
    // 'system' receipts are gas refunds, not payments.
    if (r.predecessor_id === 'system') continue;
    const deposit = (r.receipt?.Action?.actions ?? []).reduce((sum, a) => sum + BigInt(a.Transfer?.deposit ?? 0), 0n);
    if (deposit === 0n || !succeeded.has(r.receipt_id)) continue;
    if (r.receiver_id === expected.payTo) paid += deposit;
    else others.add(r.receiver_id);
  }
  if (paid === 0n) {
    if (others.size) return `transaction ${proof.txid} paid ${[...others].join(', ')}, not ${expected.payTo}`;
    if ('Failure' in (outcome.status ?? {}) || !(outcome.receipts ?? []).length) return `transaction ${proof.txid} did not succeed`;
    return `transaction ${proof.txid} paid nothing to ${expected.payTo}`;
  }
  if (paid < expected.amount) return `transaction ${proof.txid} paid ${paid} yoctoNEAR, not ${expected.amount}`;
  return null;
}
