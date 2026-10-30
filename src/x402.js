/**
 * HTTP 402 paywalls that speak x402, protocol version 2 or 1. The server answers 402 with the ways
 * it accepts payment (`accepts`): v2 puts them in the PAYMENT-REQUIRED header, v1 in the JSON
 * body. The client pays one of them and repeats the request with the payment in
 * PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1); the server's PAYMENT-RESPONSE (v1: X-PAYMENT-RESPONSE)
 * names the settling transaction.
 *
 * Here every payment goes through the guard first, so a paywall can't charge the agent more than
 * the policy allows or redirect the money to a new address. For signed schemes such as EIP-3009
 * the guard decides before anything is signed: the signature is the payment.
 */
import { getAddress } from 'viem';
import { ASSETS } from './money.js';

/**
 * @typedef {object} Requirement  One entry of a 402 offer's `accepts`, as the server sent it.
 * @property {string} scheme
 * @property {string} network  v1: a name ("base-sepolia"); v2: CAIP-2 ("eip155:84532").
 * @property {string} [amount]  v2, atomic units as a string.
 * @property {string} [maxAmountRequired]  v1, atomic units as a string.
 * @property {string} payTo
 * @property {string} asset  A token contract, or (in the demo's v1 paywalls) an ASSETS key.
 * @property {number} [maxTimeoutSeconds]
 * @property {Record<string, any>} [extra]
 * @property {string} [description]  v1; v2 describes the resource once, at the top level.
 */

/**
 * @typedef {object} PaymentRequired  A 402 offer, from either protocol version.
 * @property {1|2} x402Version
 * @property {Requirement[]} accepts
 * @property {{url: string, description?: string, mimeType?: string}} [resource]  v2
 * @property {Record<string, unknown>} [extensions]  v2; echoed back with the payment.
 * @property {string} [error]
 */

/**
 * @typedef {object} Offer  The requirement the guard is asked to pay, read the same way for v1 and
 *   v2. It travels on the intent as `intent.x402`, for rails that sign the scheme's payload.
 * @property {1|2} x402Version
 * @property {string} scheme
 * @property {string} network  CAIP-2 when known, so a rail can check the chain it would sign for.
 * @property {string} asset  As offered (a contract address for EVM tokens).
 * @property {bigint} amount
 * @property {string} payTo
 * @property {number} [maxTimeoutSeconds]
 * @property {Record<string, any>} [extra]
 */

/** CAIP-2 ids by the network names that policies and rails use. */
export const CAIP2 = {
  'arc-testnet': 'eip155:5042002',
  'arc': 'eip155:5042',
  'base-sepolia': 'eip155:84532',
  'base': 'eip155:8453',
};
const NAMES = Object.fromEntries(Object.entries(CAIP2).map(([name, id]) => [id, name]));

/**
 * Tokens the guard can price, by CAIP-2 network and lowercase contract (the official client's
 * default USDC table). An offer in any other token is not paid: its value is unknown.
 */
export const TOKENS = {
  'eip155:5042002': { '0x3600000000000000000000000000000000000000': 'usdc' },
  'eip155:5042': { '0x3600000000000000000000000000000000000000': 'usdc' },
  'eip155:84532': { '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 'usdc' },
  'eip155:8453': { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'usdc' },
};

/** "eip155:5042002" → "arc-testnet"; names and unknown ids pass through. */
export function networkName(network) {
  return NAMES[network] ?? network;
}

/** "arc-testnet" → "eip155:5042002"; CAIP-2 ids and non-EVM names pass through. */
export function caip2(network) {
  return CAIP2[network] ?? network;
}

/**
 * The ASSETS key an offer's asset stands for, or null when the guard can't price it.
 *
 * @param {string} network
 * @param {string} asset
 */
export function assetKey(network, asset) {
  if (typeof asset !== 'string') return null;
  const id = asset.toLowerCase();
  if (Object.hasOwn(ASSETS, id)) return id;
  return TOKENS[caip2(network)]?.[id] ?? null;
}

/**
 * fetch() that pays 402 paywalls through `guard`. Other responses pass through untouched, and so
 * does a 402 to a request that already carries a payment: paying again would pay twice. One
 * retry only: a second 402 is returned as it is, never answered with a second signature. After a
 * paid retry, the server's settlement is recorded on the paid entry (`guard.settled`):
 * `receipt.settlement`, and `receipt.txid` when the rail did not have one already.
 *
 * @param {Pick<import('./guard.js').Guard, 'networks'|'rails'|'pay'|'settled'>} guard
 * @param {string} url
 * @param {RequestInit} [init]  Its `signal` also reaches the guard: a payment not made by the time
 *   it aborts is not made.
 * @param {{fetch?: typeof globalThis.fetch}} [options]
 */
export async function payingFetch(guard, url, init = {}, { fetch = globalThis.fetch } = {}) {
  const first = await fetch(url, init);
  const headers = new Headers(init.headers);
  if (first.status !== 402 || headers.has('payment-signature') || headers.has('x-payment')) return first;

  const required = await readPaymentRequired(first, url);
  const choice = pickOffer(required, guard);
  if (!choice) throw new Error(cannotPay(url, required, guard.networks));
  const { requirement: chosen, network, terms } = choice;
  const offer = toOffer(required, chosen, url);

  const receipt = await guard.pay({
    // The URL actually fetched, never the server's own `resource`: host and path are what the
    // payee allowlist and the price history are keyed on.
    resource: url,
    host: new URL(url).host,
    network,
    // A rail that decides for itself (GatewayRail) prices the offer; otherwise the offer says it.
    asset: terms?.asset ?? assetKey(chosen.network, chosen.asset),
    amount: terms?.amount ?? offer.amount,
    payTo: terms?.payTo ?? offer.payTo,
    description: required.x402Version === 2 ? required.resource?.description : chosen.description,
    x402: offer,
    offer: chosen,
  }, { signal: init.signal });

  if (required.x402Version === 2) {
    // `accepted` is the server's requirement verbatim: v2 servers match it field by field, and
    // Circle Gateway refuses to settle without `resource`.
    const payment = { x402Version: 2, resource: required.resource ?? { url }, accepted: chosen, payload: receipt.proof, ...(required.extensions && { extensions: required.extensions }) };
    headers.set('PAYMENT-SIGNATURE', encodePayment(payment));
  } else {
    headers.set('X-PAYMENT', encodePayment({ x402Version: 1, scheme: chosen.scheme, network: chosen.network, payload: receipt.proof }));
  }
  const res = await fetch(url, { ...init, headers });

  const header = res.headers.get('payment-response') ?? res.headers.get('x-payment-response');
  let settlement;
  try {
    settlement = header && decodePayment(header);
  } catch {
    // A garbled receipt header must not cost the agent the response it paid for.
  }
  if (settlement && typeof settlement === 'object') guard.settled(receipt, settlement);
  return res;
}

/**
 * The first entry of `accepts`, in the server's order, that the guard can pay, and the network of
 * the rail that would pay it. A rail with `terms` (GatewayRail) decides for itself which x402 v2
 * offers it takes, and is asked first, so an offer meant for it never reaches a rail that would
 * sign it some other way. Other rails take what pickRequirement allows on their network.
 *
 * @param {PaymentRequired} required
 * @param {Pick<import('./guard.js').Guard, 'networks'|'rails'>} guard
 * @returns {{requirement: Requirement, network: string, terms: {asset: string, amount: bigint, payTo: string} | null} | null}
 */
export function pickOffer({ accepts, x402Version }, guard) {
  const deciding = guard.networks.filter((n) => guard.rails.get(n).terms);
  const plain = guard.networks.filter((n) => !guard.rails.get(n).terms);
  for (const r of accepts) {
    for (const network of x402Version === 2 ? deciding : []) {
      const terms = guard.rails.get(network).terms(r);
      if (terms) return { requirement: r, network, terms };
    }
    if (pickRequirement([r], plain, x402Version)) return { requirement: r, network: networkName(r.network), terms: null };
  }
  return null;
}

/**
 * The offer in a 402 response: the v2 PAYMENT-REQUIRED header when there is one, otherwise a v1
 * JSON body. Consumes the body.
 *
 * @param {Response} res
 * @param {string} [url]  For error messages.
 * @returns {Promise<PaymentRequired>}
 */
export async function readPaymentRequired(res, url = res.url) {
  const header = res.headers.get('payment-required');
  const text = await res.text();
  let offer;
  try {
    offer = header ? decodePayment(header) : JSON.parse(text);
  } catch {
    throw new Error(`${url} answered 402 with an unreadable ${header ? 'PAYMENT-REQUIRED header' : 'body'}`);
  }
  // Older v1 servers leave the version out of the body.
  if (!header && Array.isArray(offer?.accepts)) offer.x402Version ??= 1;
  if ((offer?.x402Version !== 1 && offer?.x402Version !== 2) || !Array.isArray(offer.accepts)) {
    throw new Error(`${url} answered 402 without an x402 offer`);
  }
  return offer;
}

/**
 * The first option the guard can pay: on one of its networks, in a token it can price, in the
 * 'exact' scheme, settled by EIP-3009 authorization (or, for the demo paywalls, a plain transfer:
 * see takesTransfer) rather than Permit2, delegation or escrow. The server's order is its
 * preference; the guard's policy, not the price, decides afterwards whether that option is acceptable.
 *
 * @param {Requirement[]} accepts
 * @param {string[]} networks  Network names, as in the policy.
 * @param {1|2} [x402Version]  The offer's version.
 */
export function pickRequirement(accepts, networks, x402Version = 2) {
  return accepts.find((r) => networks.includes(networkName(r.network)) && payable(r, x402Version)) ?? null;
}

/**
 * Whether an offer is paid by a plain transfer, the transaction being the proof. Only the demo
 * paywalls' x402 v1 offers are: they name an asset ('usdc') where a token contract would be, and
 * no EIP-712 domain. A paywall that names the contract settles the 'exact' scheme's signed
 * authorization and nothing else, in v1 as in v2: a transfer would move the money and still get a 402.
 *
 * @param {{x402Version?: number, asset?: string, extra?: Record<string, any>}} offer  An Offer, or
 *   a Requirement with its version.
 */
export function takesTransfer({ x402Version, asset, extra }) {
  return x402Version === 1 && Object.hasOwn(ASSETS, String(asset).toLowerCase()) && !(extra?.name || extra?.version);
}

/** @param {Requirement} r  @param {1|2} x402Version */
function payable(r, x402Version) {
  if (r.scheme !== 'exact' || assetKey(r.network, r.asset) === null) return false;
  const { assetTransferMethod = 'eip3009', paymentFlow = 'authorization', verifyingContract } = r.extra ?? {};
  // A domain that names another contract (Circle Gateway's wallet, say) belongs to that contract's
  // scheme, not the token's own EIP-3009: only a rail that knows the scheme may sign for it.
  if (verifyingContract && String(verifyingContract).toLowerCase() !== String(r.asset).toLowerCase()) return false;
  return assetTransferMethod === 'eip3009' && paymentFlow === 'authorization' && !lacksDomain(r, x402Version);
}

/**
 * An 'exact' EVM offer without the token's EIP-712 domain can't be signed, and unless it takes a
 * transfer, paying it any other way would lose the money.
 *
 * @param {Requirement} r
 * @param {1|2} x402Version
 */
function lacksDomain(r, x402Version) {
  return r.scheme === 'exact' && caip2(r.network).startsWith('eip155:') && !(r.extra?.name && r.extra?.version) && !takesTransfer({ ...r, x402Version });
}

/**
 * @param {PaymentRequired} required
 * @param {Requirement} r
 * @param {string} url
 * @returns {Offer}
 */
function toOffer(required, r, url) {
  const amount = required.x402Version === 2 ? r.amount : r.maxAmountRequired;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) throw new Error(`${url} asks for a malformed amount: ${amount}`);
  const network = caip2(r.network);
  return {
    x402Version: required.x402Version,
    scheme: r.scheme,
    network,
    asset: r.asset,
    amount: BigInt(amount),
    // EVM addresses in checksum form, so the payee allowlist compares like with like.
    payTo: network.startsWith('eip155:') ? getAddress(r.payTo) : r.payTo,
    maxTimeoutSeconds: r.maxTimeoutSeconds,
    extra: r.extra,
  };
}

/**
 * Why nothing in the offer can be paid, for the error message.
 *
 * @param {string} url
 * @param {PaymentRequired} required
 * @param {string[]} networks
 */
function cannotPay(url, { accepts, x402Version }, networks) {
  const can = networks.join(', ') || 'nothing';
  const onOurs = accepts.filter((r) => networks.includes(networkName(r.network)));
  if (!onOurs.length) {
    const offered = [...new Set(accepts.map((r) => networkName(r.network)))].join(', ') || 'nothing';
    return `${url} asks for payment on ${offered}; this guard can pay on ${can}`;
  }
  const what = onOurs.map((r) => `${r.scheme} ${r.asset}${r.extra?.assetTransferMethod ? ` via ${r.extra.assetTransferMethod}` : ''}${lacksDomain(r, x402Version) ? ' without its EIP-712 domain' : ''} on ${networkName(r.network)}`);
  return `${url} asks for ${what.join(', ')}; this guard pays the exact scheme in known tokens only`;
}

export function encodePayment(payment) {
  return Buffer.from(JSON.stringify(payment)).toString('base64');
}

export function decodePayment(header) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}
