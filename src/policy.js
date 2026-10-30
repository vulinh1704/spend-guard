import { assetOf, formatUsd, toMicroUsd, usdToMicro } from './money.js';

/**
 * @typedef {object} Service
 * @property {string[]} payTo  Addresses this service may be paid at. A different address is a payee swap.
 * @property {number} [maxUsd]  The most one call to this service may cost.
 */

/**
 * @typedef {object} Policy
 * @property {string[]} networks  Rails the agent may pay on, e.g. "near-testnet", "bch", "concordium-testnet".
 * @property {number} dailyUsd  Total the agent may spend per UTC day.
 * @property {number} perPaymentUsd  No single payment may cost more than this.
 * @property {number} askAboveUsd  Payments above this wait for a human yes.
 * @property {number} spikeRatio  A price this many times the service's usual price is refused.
 * @property {'ask'|'deny'} unknownService  What to do when the host is not in `services`.
 * @property {Record<string, Service>} services  Known services by host name.
 */

/**
 * @typedef {object} Intent  One payment the agent wants to make.
 * @property {string} resource  The URL being paid for.
 * @property {string} host
 * @property {string} network
 * @property {string} asset
 * @property {bigint} amount  Atomic units of `asset`.
 * @property {string} payTo
 * @property {string} [description]
 * @property {object} [offer]  x402 v2: the `accepts` entry being paid. Policy ignores it; the rail signs against it.
 */

/**
 * @typedef {object} Reason
 * @property {string} code
 * @property {string} message
 */

/**
 * @typedef {object} Verdict
 * @property {'allow'|'ask'|'deny'} decision
 * @property {Reason[]} reasons  Every rule that fired, so a refusal explains itself in full.
 * @property {bigint} usd  The payment in micro-dollars.
 */

/** @type {Policy} */
export const DEFAULT_POLICY = {
  networks: [],
  dailyUsd: 5,
  perPaymentUsd: 1,
  askAboveUsd: 0.25,
  spikeRatio: 5,
  unknownService: 'ask',
  services: {},
};

/**
 * Decides one payment. Pure: the caller passes what was already spent today and the endpoint's
 * recent prices, so the same inputs always give the same verdict (and tests need no clock).
 *
 * @param {Intent} intent
 * @param {Policy} policy
 * @param {{spentTodayUsd: bigint, recentPricesUsd: bigint[]}} history
 * @returns {Verdict}
 */
export function evaluate(intent, policy, history) {
  const usd = toMicroUsd(intent.amount, assetOf(intent.asset));
  /** @type {Reason[]} */
  const deny = [];
  /** @type {Reason[]} */
  const ask = [];

  if (!policy.networks.includes(intent.network)) {
    deny.push({ code: 'network', message: `${intent.network} is not one of the allowed networks (${policy.networks.join(', ') || 'none'})` });
  }

  const service = policy.services[intent.host];
  if (!service) {
    (policy.unknownService === 'deny' ? deny : ask).push({ code: 'unknown-service', message: `${intent.host} is not a known service` });
  } else {
    if (!service.payTo.some((known) => samePayee(known, intent.payTo))) {
      // The classic paywall attack: same host, same price, but the money goes somewhere new.
      deny.push({ code: 'payee-swap', message: `${intent.host} asked to be paid at ${intent.payTo}, which is not one of its known addresses` });
    }
    if (service.maxUsd !== undefined && usd > usdToMicro(service.maxUsd)) {
      deny.push({ code: 'service-cap', message: `${formatUsd(usd)} is over the ${formatUsd(usdToMicro(service.maxUsd))} cap for ${intent.host}` });
    }
  }

  if (usd > usdToMicro(policy.perPaymentUsd)) {
    deny.push({ code: 'per-payment', message: `${formatUsd(usd)} is over the ${formatUsd(usdToMicro(policy.perPaymentUsd))} limit for one payment` });
  }

  const daily = usdToMicro(policy.dailyUsd);
  if (history.spentTodayUsd + usd > daily) {
    deny.push({ code: 'daily-budget', message: `paying ${formatUsd(usd)} would take today's spend to ${formatUsd(history.spentTodayUsd + usd)}, over the ${formatUsd(daily)} budget` });
  }

  const usual = median(history.recentPricesUsd);
  if (usual !== null && usual > 0n && usd * 100n >= usual * BigInt(Math.round(policy.spikeRatio * 100))) {
    deny.push({ code: 'price-spike', message: `${formatUsd(usd)} is ${ratio(usd, usual)}x the usual ${formatUsd(usual)} for ${priceKey(intent)}` });
  }

  if (usd > usdToMicro(policy.askAboveUsd)) {
    ask.push({ code: 'large-payment', message: `${formatUsd(usd)} is above the ${formatUsd(usdToMicro(policy.askAboveUsd))} that needs your approval` });
  }

  if (deny.length) return { decision: 'deny', reasons: [...deny, ...ask], usd };
  if (ask.length) return { decision: 'ask', reasons: ask, usd };
  return { decision: 'allow', reasons: [], usd };
}

/**
 * Prices are compared per endpoint (host + path, no query), since one API usually charges
 * differently for different endpoints but the same for every call to one endpoint.
 *
 * @param {Intent} intent
 */
export function priceKey(intent) {
  const url = new URL(intent.resource);
  return url.host + url.pathname;
}

/** @param {bigint[]} values */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

/** One decimal place, e.g. "12.5". */
function ratio(a, b) {
  return (Number((a * 10n) / b) / 10).toString();
}

/**
 * EVM addresses are the same in any letter case (the x402 client checksums them, a policy may be
 * written in lowercase); every other kind of address must match exactly.
 */
function samePayee(a, b) {
  const evm = /^0x[0-9a-fA-F]{40}$/;
  return a === b || (evm.test(a) && evm.test(b) && a.toLowerCase() === b.toLowerCase());
}
