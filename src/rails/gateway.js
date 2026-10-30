/**
 * Circle Gateway nanopayments on Arc testnet. The agent deposits USDC into Circle's Gateway Wallet
 * once; after that each x402 call is paid with an off-chain EIP-3009 authorization that Gateway
 * settles in batches. No gas and no transaction per call, so a $0.01 call costs $0.01.
 *
 * An authorization is a bearer cheque valid for at least 7 days: whoever holds it can settle it
 * until it expires. So the guard decides before anything is signed, a signature counts as money
 * spent, and nothing here signs twice for one request.
 */
import { BatchEvmScheme, CHAIN_CONFIGS, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS, GatewayClient } from '@circle-fin/x402-batching/client';
import { formatUnits, getAddress, isAddressEqual, pad, verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ARC = CHAIN_CONFIGS.arcTestnet;

/** Gateway's testnet API. The SDK's seller helpers default to mainnet, which does not list Arc testnet. */
export const GATEWAY_TESTNET_API = 'https://gateway-api-testnet.circle.com';
/** Arc testnet as x402 v2 names it (CAIP-2). */
export const GATEWAY_NETWORK = `eip155:${ARC.chain.id}`;
export const GATEWAY_WALLET = ARC.gatewayWallet;
export const GATEWAY_USDC = ARC.tokens.USDC.address;
/** `extra.name` of an x402 offer that Gateway settles, and the name of its EIP-712 domain. */
const BATCHED = 'GatewayWalletBatched';
/** Gateway refuses to settle an authorization that expires sooner than this. */
const MIN_VALIDITY_SECONDS = 7 * 24 * 60 * 60;
/**
 * Transfer statuses from the payee's settle on, when Gateway has taken the amount off the balance.
 * Not 'failed': nothing says the payee can't settle that authorization again.
 */
const SETTLED = new Set(['received', 'batched', 'confirmed', 'completed']);

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/**
 * Pays from the agent's Gateway balance. Amount and payee come from the intent the guard approved;
 * the paywall's offer only supplies the Gateway details, and those are pinned to Circle's contracts.
 */
export class GatewayRail {
  /**
   * @param {object} options
   * @param {`0x${string}`} options.privateKey  Read from the environment, never committed.
   * @param {string} [options.network]  The name policies use for this rail.
   * @param {Pick<GatewayClient, 'getBalances' | 'deposit' | 'searchTransfers'>} [options.client]  Injected in tests.
   * @param {() => number} [options.now]  Clock that expires held authorizations; injected in tests.
   */
  constructor({ privateKey, network = 'arc-testnet-gateway', client, now = Date.now }) {
    this.network = network;
    this.account = privateKeyToAccount(privateKey);
    this.client = client ?? new GatewayClient({ chain: 'arcTestnet', privateKey });
    this.scheme = new BatchEvmScheme(this.account);
    this.now = now;
    /**
     * Authorizations signed here that Gateway has not settled yet, by nonce. Gateway lowers the
     * balance only when the payee settles, so until then these are held back from it. Kept in
     * memory: it starts empty after a restart.
     * @type {Map<string, {amount: bigint, validBefore: bigint}>}
     */
    this.unsettled = new Map();
  }

  get address() {
    return this.account.address;
  }

  /**
   * x402 v2: what paying `offer` (one entry of a 402's `accepts`) would cost, or null when this
   * rail can't pay it. Only Gateway offers for USDC on Arc testnet qualify.
   *
   * @param {object} offer
   * @returns {{asset: string, amount: bigint, payTo: string} | null}
   */
  terms(offer) {
    if (offer?.scheme !== 'exact' || offer.network !== GATEWAY_NETWORK || offer.extra?.name !== BATCHED) return null;
    if (!['1', '2'].includes(offer.extra.version) || !sameAddress(offer.asset, GATEWAY_USDC)) return null;
    // The paywall names the contract the signature is for; any other contract could be one that
    // pays it out on its own terms.
    if (!sameAddress(offer.extra.verifyingContract, GATEWAY_WALLET)) return null;
    try {
      const amount = BigInt(offer.amount);
      return amount > 0n ? { asset: 'usdc', amount, payTo: getAddress(offer.payTo) } : null;
    } catch {
      return null;
    }
  }

  /** @param {import('../policy.js').Intent} intent */
  async pay(intent) {
    if (intent.asset !== 'usdc') throw new Error(`GatewayRail pays in USDC; ${intent.resource} asked for ${intent.asset}`);
    const terms = this.terms(intent.offer);
    if (!terms) throw new Error(`${intent.resource} did not offer a Circle Gateway payment in USDC on Arc testnet`);
    if (terms.amount !== intent.amount || !sameAddress(terms.payTo, intent.payTo)) {
      throw new Error(`the offer from ${intent.resource} differs from the payment the guard approved`);
    }
    // An authorization the balance can't cover fails at settle but stays valid for a week, so a
    // later deposit would let the payee collect it: don't sign one. Holds are looked up before the
    // balance, so a payment settled in between is counted twice rather than not at all.
    const held = await this.#held();
    const { gateway } = await this.client.getBalances();
    if (gateway.available - held < intent.amount) {
      const signed = held ? `, ${formatUnits(held, 6)} of it signed for payments not settled yet,` : '';
      throw new Error(`Gateway balance ${gateway.formattedAvailable} USDC${signed} is too low; deposit more first`);
    }

    const { payload } = await this.scheme.createPaymentPayload(2, {
      ...intent.offer,
      payTo: getAddress(intent.payTo),
      amount: intent.amount.toString(),
      // The shortest validity Gateway accepts, however long the paywall asked for.
      maxTimeoutSeconds: GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
    });
    // The guard pays one at a time, so nothing else was signed between the check and this hold.
    const { nonce, validBefore } = payload.authorization;
    this.unsettled.set(nonce, { amount: intent.amount, validBefore: BigInt(validBefore) });
    return { network: this.network, txid: nonce, proof: payload };
  }

  /** USDC (atomic units) signed here that a payee can still settle and hasn't yet. */
  async #held() {
    const now = BigInt(Math.floor(this.now() / 1000));
    let held = 0n;
    await Promise.all([...this.unsettled].map(async ([nonce, { amount, validBefore }]) => {
      // Expired, nobody can settle it any more; settled, it is already off the balance.
      if (validBefore <= now || SETTLED.has((await this.status(nonce))?.status)) this.unsettled.delete(nonce);
      else held += amount;
    }));
    return held;
  }

  /** Wallet and Gateway balances of the agent, in USDC. */
  balances() {
    return this.client.getBalances();
  }

  /**
   * Moves USDC from the agent's wallet into its Gateway balance (approve + deposit, two Arc
   * transactions). It limits what payees can collect at one time; the guard's budgets are what
   * limit spending.
   *
   * @param {string} usdc  e.g. "1" or "0.5"
   */
  deposit(usdc) {
    return this.client.deposit(usdc);
  }

  /**
   * Where a payment stands at Gateway, by the nonce in its receipt: null until the payee settles
   * it, then received → batched → completed, with the batch's Arc transaction in `txHash`.
   *
   * @param {string} nonce
   */
  async status(nonce) {
    const { transfers = [] } = await this.client.searchTransfers({ from: this.address, nonce });
    return transfers[0] ?? null;
  }
}

/**
 * The `accepts` entry a paywall offers for a Gateway payment.
 *
 * @param {{payTo: string, amount: bigint | string, version?: '1' | '2'}} options  `amount` in USDC atomic units.
 */
export function gatewayOffer({ payTo, amount, version = '1' }) {
  return {
    scheme: 'exact',
    network: GATEWAY_NETWORK,
    asset: GATEWAY_USDC,
    amount: String(amount),
    payTo,
    maxTimeoutSeconds: GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
    extra: { name: BATCHED, version, verifyingContract: GATEWAY_WALLET },
  };
}

/**
 * The paywall's quick offline check before asking Circle: signed by the payer, for this payee and
 * amount, and valid long enough for Gateway. Settling checks all of it again, plus balance and nonce.
 *
 * @param {{authorization?: object, signature?: `0x${string}`}} payload  `payload` of a PAYMENT-SIGNATURE.
 * @param {ReturnType<typeof gatewayOffer>} offer  What the paywall asked for.
 * @param {{now?: () => number}} [options]
 * @returns {Promise<string|null>}  null when it checks out, otherwise why not.
 */
export async function checkGatewayAuthorization(payload, offer, { now = Date.now } = {}) {
  const a = payload?.authorization;
  if (!a || !payload.signature) return 'not a Gateway authorization';
  try {
    if (!sameAddress(a.to, offer.payTo)) return `authorization pays ${a.to}, not ${offer.payTo}`;
    if (BigInt(a.value) !== BigInt(offer.amount)) return `authorization is for ${a.value}, not ${offer.amount}`;
    const t = BigInt(Math.floor(now() / 1000));
    if (BigInt(a.validAfter) > t) return 'authorization is not valid yet';
    if (BigInt(a.validBefore) < t + BigInt(MIN_VALIDITY_SECONDS)) return 'authorization expires before Gateway would settle it';
    const valid = await verifyTypedData({ address: a.from, signature: payload.signature, ...typedData(offer, a) });
    return valid ? null : 'signature is not from the payer';
  } catch (err) {
    return `malformed authorization: ${err.shortMessage ?? err.message}`;
  }
}

/**
 * The paywall's side: asks Circle Gateway to settle. Settling checks signature, balance and nonce,
 * locks the payer's funds and credits `payTo`; only then may the resource be served (/verify alone
 * passes an unfunded payer). Gateway answers with a transfer id; the Arc transaction comes later,
 * when the batch lands.
 *
 * @param {object} paymentPayload  The decoded PAYMENT-SIGNATURE, which must carry `resource` and `accepted`.
 * @param {object} paymentRequirements  The offer the paywall made.
 * @param {{apiUrl?: string, fetch?: typeof globalThis.fetch}} [options]
 * @returns {Promise<{success: boolean, errorReason?: string, transaction?: string, payer?: string, network?: string}>}
 */
export async function settleGatewayPayment(paymentPayload, paymentRequirements, { apiUrl = GATEWAY_TESTNET_API, fetch = globalThis.fetch } = {}) {
  let res;
  try {
    res = await fetch(`${apiUrl}/v1/x402/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    });
  } catch (err) {
    return { success: false, errorReason: `Gateway unreachable: ${err.message}` };
  }
  const body = await res.json().catch(() => ({}));
  if (body.success === true) return body;
  // A malformed request comes back as HTTP 400 with only a `message`.
  return { ...body, success: false, errorReason: body.errorReason ?? body.message ?? `Gateway answered HTTP ${res.status}` };
}

/** Public page of one payment at Gateway (status, then the batch's Arc tx hash), by its nonce. */
export function gatewayTransferUrl(nonce, apiUrl = GATEWAY_TESTNET_API) {
  return `${apiUrl}/v1/x402/transfers?network=${GATEWAY_NETWORK}&nonce=${nonce}`;
}

/** The EIP-712 message Gateway checks: EIP-3009 fields under the Gateway Wallet's domain, not USDC's. */
function typedData(offer, a) {
  const version = offer.extra.version;
  return {
    domain: {
      name: BATCHED,
      version,
      chainId: Number(offer.network.split(':')[1]),
      verifyingContract: getAddress(offer.extra.verifyingContract),
      // Version 2 binds the token too, so one signature can't be settled in another asset.
      ...(version === '2' && { salt: pad(getAddress(offer.asset)) }),
    },
    types: AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(a.from),
      to: getAddress(a.to),
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
  };
}

/** isAddressEqual that says no to a malformed address instead of throwing. */
function sameAddress(a, b) {
  try {
    return isAddressEqual(a, b);
  } catch {
    return false;
  }
}
