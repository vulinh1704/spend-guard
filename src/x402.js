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
 * x402 v2 paywalls send their offer in a PAYMENT-REQUIRED header and want PAYMENT-SIGNATURE
 * back; v1 paywalls send it as the body and want X-PAYMENT.
 *
 * @param {import('./guard.js').Guard} guard
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{fetch?: typeof globalThis.fetch}} [options]
 */
export async function payingFetch(guard, url, init = {}, { fetch = globalThis.fetch } = {}) {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;

  const required = first.headers.get('payment-required');
  if (required) return payV2(guard, url, init, decodePayment(required), fetch);

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
  });

  const payment = { x402Version: body.x402Version ?? 1, scheme: requirement.scheme, network: requirement.network, payload: receipt.proof };
  return fetch(url, { ...init, headers: { ...init.headers, 'X-PAYMENT': encodePayment(payment) } });
}

/** x402 v2: pay the first offer a rail can take, then retry once with the signed payload. */
async function payV2(guard, url, init, required, fetch) {
  const accepts = required.accepts ?? [];
  const choice = pickOffer(accepts, guard);
  if (!choice) {
    const offered = accepts.map((o) => o.network).join(', ') || 'nothing';
    throw new Error(`${url} asks for payment on ${offered}; this guard can pay on ${guard.networks.join(', ') || 'nothing'}`);
  }

  const { offer, rail, terms } = choice;
  const receipt = await guard.pay({
    resource: url,
    host: new URL(url).host,
    network: rail.network,
    ...terms,
    description: required.resource?.description,
    offer,
  });

  // The paywall settles with `resource` and the offer echoed back as `accepted`. One retry only:
  // a second 402 is returned as it is, never answered with a second signature.
  const payment = {
    x402Version: required.x402Version ?? 2,
    resource: required.resource ?? { url },
    accepted: offer,
    payload: receipt.proof,
    ...(required.extensions && { extensions: required.extensions }),
  };
  return fetch(url, { ...init, headers: { ...init.headers, 'PAYMENT-SIGNATURE': encodePayment(payment) } });
}

/**
 * x402 v2: the first offer, in the server's order, that a rail the guard may use can pay. A rail
 * with `terms` decides for itself (GatewayRail takes Circle Gateway offers); other rails take
 * offers on their own network.
 *
 * @param {object[]} accepts
 * @param {import('./guard.js').Guard} guard
 * @returns {{offer: object, rail: import('./guard.js').Rail, terms: {asset: string, amount: bigint, payTo: string}} | null}
 */
export function pickOffer(accepts, guard) {
  for (const offer of accepts) {
    for (const network of guard.networks) {
      const rail = guard.rails.get(network);
      const terms = rail.terms
        ? rail.terms(offer)
        : offer.network === network ? { asset: offer.asset, amount: BigInt(offer.amount), payTo: offer.payTo } : null;
      if (terms) return { offer, rail, terms };
    }
  }
  return null;
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
