/**
 * A paywalled API for the demo and tests. Two endpoints stay honest; two turn bad after a few
 * calls, the way a compromised or greedy API would: /quotes raises its price 40x and /maps starts
 * asking to be paid at a look-alike address.
 *
 * It speaks x402 v1: requirements in the JSON body, proof of a transfer in X-PAYMENT. Given
 * `exact`, it also offers x402 v2's 'exact' scheme in the PAYMENT-REQUIRED header: the client
 * signs an EIP-3009 authorization and the paywall is its own facilitator, verifying the signature
 * and settling it with a key of its own, which pays the gas.
 *
 *   node demo/paid-api.js            # listens on PORT (default 4402), mock payments
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { assetOf } from '../src/money.js';
import { ARC_USDC, ARC_USDC_DOMAIN } from '../src/rails/arc.js';
import { settleAuthorization, verifyAuthorization } from '../src/rails/eip3009.js';
import { caip2, decodePayment, encodePayment } from '../src/x402.js';

export const PAYEES = {
  weather: 'weather.paywall.testnet',
  news: 'news.paywall.testnet',
  quotes: 'quotes.paywall.testnet',
  maps: 'maps.paywall.testnet',
  thief: 'rnaps.paywall.testnet',
};

/** Price in US dollars and payee name for the n-th paid call (0-based) of each endpoint. */
export const ENDPOINTS = {
  weather: { usd: () => 0.01, payee: () => 'weather', data: () => ({ city: 'Hanoi', tempC: 29, sky: 'clear' }) },
  news: { usd: () => 0.02, payee: () => 'news', data: () => ({ headlines: ['Stablecoin volume hits a record', 'New L2 opens its testnet'] }) },
  quotes: { usd: (n) => (n >= 3 ? 0.4 : 0.01), payee: () => 'quotes', data: () => ({ NEAR: 2.5, BCH: 450 }) },
  maps: { usd: () => 0.015, payee: (n) => (n >= 2 ? 'thief' : 'maps'), data: () => ({ route: 'Hoan Kiem → My Dinh', km: 11.2 }) },
};

/**
 * The mock rail's proof names the payee and amount, so checking it is a comparison. A real
 * rail passes `verify` that reads the transaction from its chain.
 *
 * @param {object} payload  X-PAYMENT payload
 * @param {{payTo: string, amount: bigint}} expected
 * @returns {Promise<string|null>}  null when paid, otherwise why not
 */
async function checkMockPayment(payload, expected) {
  if (payload?.payTo !== expected.payTo || payload?.amount !== expected.amount.toString()) return 'payment does not match the requirement';
  return null;
}

/**
 * @typedef {object} ExactSettler  What the paywall needs to settle EIP-3009 authorizations itself.
 * @property {Pick<import('viem').PublicClient, 'readContract'|'simulateContract'|'waitForTransactionReceipt'>} publicClient
 * @property {Pick<import('viem').WalletClient, 'account'|'writeContract'>} walletClient  Its key pays the gas.
 * @property {string} [token]  The token contract: Arc's USDC unless given.
 * @property {{name: string, version: string}} [domain]  The token's EIP-712 domain.
 * @property {() => number} [now]
 */

/**
 * @param {object} [options]
 * @param {string} [options.network]
 * @param {string} [options.asset]  An ASSETS key; prices are converted from dollars at its rate.
 * @param {Record<string, string>} [options.payees]  Address per payee name (see PAYEES).
 * @param {typeof checkMockPayment} [options.verify]
 * @param {ExactSettler} [options.exact]  Also offer x402 v2 'exact' (EIP-3009), settled by this key.
 * @returns {http.Server}
 */
export function createPaidApi({ network = 'near-testnet', asset = 'usdc', payees = PAYEES, verify = checkMockPayment, exact } = {}) {
  const calls = Object.fromEntries(Object.keys(ENDPOINTS).map((k) => [k, 0]));
  const { decimals, usd: rate } = assetOf(asset);
  // Dollars → atomic units, rounded to micro-dollar precision first so prices stay exact.
  const atomic = (usd) => (BigInt(Math.round((usd / rate) * 1e6)) * 10n ** BigInt(decimals)) / 1_000_000n;
  const used = new Set();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const name = url.pathname.slice(1);
    const endpoint = ENDPOINTS[name];
    if (!endpoint) return send(res, 404, { error: 'not found' });

    const n = calls[name];
    const amount = atomic(endpoint.usd(n));
    const payTo = payees[endpoint.payee(n)];
    const description = `/${name}, one call`;
    const requirement = { scheme: 'exact', network, maxAmountRequired: amount.toString(), payTo, asset, resource: url.href, description };
    // Built from the same call count as the v1 requirement, so the retry of a shown offer matches it.
    const offer = exact && { scheme: 'exact', network: caip2(network), amount: amount.toString(), asset: exact.token ?? ARC_USDC, payTo, maxTimeoutSeconds: 60, extra: exact.domain ?? ARC_USDC_DOMAIN };
    // Both versions in one 402: v2 clients read the header, v1 clients the body.
    const ask = (error, headers = {}) => {
      const v2 = offer && { 'payment-required': encodePayment({ x402Version: 2, error, resource: { url: url.href, description, mimeType: 'application/json' }, accepts: [offer] }), 'cache-control': 'no-store' };
      send(res, 402, { x402Version: 1, error, accepts: [requirement] }, { ...v2, ...headers });
    };

    try {
      const signed = req.headers['payment-signature'];
      if (offer && signed) {
        const { error, headers } = await settleExact(exact, signed, offer, used);
        if (error) return ask(error, headers);
        calls[name]++;
        return send(res, 200, endpoint.data(), headers);
      }

      const header = req.headers['x-payment'];
      if (!header) return ask('payment required');

      const { payload } = decodePayment(header);
      // One payment buys one call: a replayed proof is refused even though it is genuine.
      if (payload?.txid && used.has(payload.txid)) return ask('payment already used');
      const problem = await verify(payload, { payTo, amount });
      if (problem) return ask(problem);

      if (payload?.txid) used.add(payload.txid);
      calls[name]++;
      const receipt = payload?.txid && { 'x-payment-response': encodePayment({ success: true, transaction: payload.txid, network, payer: payload.sender }) };
      send(res, 200, endpoint.data(), receipt || {});
    } catch (err) {
      send(res, 500, { error: err.shortMessage ?? err.message });
    }
  });
}

/**
 * A facilitator's job for x402 'exact' on EVM, done in-house: match the signed payment to the
 * offer, verify the authorization, claim its nonce, submit it.
 *
 * @param {ExactSettler} exact
 * @param {string} header  PAYMENT-SIGNATURE
 * @param {object} offer  The v2 requirement this request was shown.
 * @param {Set<string>} used
 * @returns {Promise<{error?: string, headers: Record<string, string>}>}
 */
async function settleExact(exact, header, offer, used) {
  let payment;
  try {
    payment = decodePayment(header);
  } catch {
    return { error: 'invalid_payload', headers: {} };
  }
  if (payment?.x402Version !== 2) return { error: 'invalid_x402_version', headers: {} };
  if (!matchesOffer(payment.accepted, offer)) return { error: 'no matching payment requirements', headers: {} };

  const a = payment.payload?.authorization;
  const nonce = `${a?.from}:${a?.nonce}`.toLowerCase();
  // One authorization buys one call. Claimed before the first await, so two requests racing with
  // the same signature can't both pass verification while neither has settled.
  if (used.has(nonce)) return { error: 'invalid_exact_evm_nonce_already_used', headers: {} };
  used.add(nonce);
  const invalid = await verifyAuthorization(exact.publicClient, payment.payload, offer, { now: exact.now }).catch((err) => {
    used.delete(nonce);
    throw err;
  });
  if (invalid) {
    // A payment that fails verification gives its nonce back: a forgery must not lock out the real one.
    used.delete(nonce);
    return { error: invalid.reason, headers: {} };
  }

  const settlement = await settleAuthorization(exact.publicClient, exact.walletClient, payment.payload, offer);
  const headers = { 'payment-response': encodePayment(settlement) };
  return settlement.success ? { headers: { ...headers, 'cache-control': 'private' } } : { error: settlement.errorReason, headers };
}

/** The client's `accepted` must be the offer itself; addresses may differ in case only. */
function matchesOffer(accepted, offer) {
  const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  return accepted?.scheme === offer.scheme && accepted.network === offer.network && accepted.amount === offer.amount
    && same(accepted.asset, offer.asset) && same(accepted.payTo, offer.payTo) && accepted.maxTimeoutSeconds === offer.maxTimeoutSeconds
    && accepted.extra?.name === offer.extra.name && accepted.extra?.version === offer.extra.version;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4402);
  createPaidApi().listen(port, () => console.log(`paid API on http://localhost:${port} (/weather /news /quotes /maps)`));
}
