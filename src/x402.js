/**
 * HTTP 402 paywalls in the x402 style: the server answers 402 with the ways it accepts payment
 * (`accepts`), the client pays one of them and repeats the request with proof in `X-PAYMENT`.
 * Here every payment goes through the guard, so a paywall can't charge the agent more than the
 * policy allows or redirect the money to a new address.
 */

/**
 * @typedef {object} Requirement  One entry of a 402 response's `accepts`.
 * @property {string} scheme
 * @property {string} network
 * @property {string} maxAmountRequired  Atomic units, as a string.
 * @property {string} payTo
 * @property {string} asset
 * @property {string} [description]
 */

/**
 * fetch() that pays 402 paywalls through `guard`. Other responses pass through untouched.
 *
 * @param {Pick<import('./guard.js').Guard, 'networks'|'pay'>} guard
 * @param {string} url
 * @param {RequestInit} [init]  Its `signal` also reaches the guard: a payment not made by the time
 *   it aborts is not made.
 * @param {{fetch?: typeof globalThis.fetch}} [options]
 */
export async function payingFetch(guard, url, init = {}, { fetch = globalThis.fetch } = {}) {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;

  const body = await first.json();
  const requirement = pickRequirement(body.accepts ?? [], guard.networks);
  if (!requirement) {
    const offered = (body.accepts ?? []).map((r) => r.network).join(', ') || 'nothing';
    throw new Error(`${url} asks for payment on ${offered}; this guard can pay on ${guard.networks.join(', ') || 'nothing'}`);
  }

  const receipt = await guard.pay({
    resource: url,
    host: new URL(url).host,
    network: requirement.network,
    asset: requirement.asset,
    amount: BigInt(requirement.maxAmountRequired),
    payTo: requirement.payTo,
    description: requirement.description,
  }, { signal: init.signal });

  const payment = { x402Version: body.x402Version ?? 1, scheme: requirement.scheme, network: requirement.network, payload: receipt.proof };
  return fetch(url, { ...init, headers: { ...init.headers, 'X-PAYMENT': encodePayment(payment) } });
}

/**
 * The first option on a network the guard can pay on. The server's order is its preference;
 * the guard's policy, not the price, decides afterwards whether that option is acceptable.
 *
 * @param {Requirement[]} accepts
 * @param {string[]} networks
 */
export function pickRequirement(accepts, networks) {
  return accepts.find((r) => networks.includes(r.network)) ?? null;
}

export function encodePayment(payment) {
  return Buffer.from(JSON.stringify(payment)).toString('base64');
}

export function decodePayment(header) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}
