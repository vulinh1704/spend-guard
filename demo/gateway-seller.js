/**
 * The demo paywall as an x402 v2 seller paid through Circle Gateway: the endpoints of paid-api.js
 * (two honest, two that turn bad) priced as nanopayments in USDC on Arc testnet. Each paid call is
 * settled with Circle before its data is served. No Circle account or API key: a seller only needs
 * an address to be paid at.
 *
 *   node demo/gateway-seller.js      # listens on PORT (default 4403); payees from ARC_PAYEE_* in .env
 */
import { existsSync } from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ENDPOINTS } from './paid-api.js';
import { checkGatewayAuthorization, gatewayOffer, settleGatewayPayment } from '../src/rails/gateway.js';
import { decodePayment, encodePayment } from '../src/x402.js';

/**
 * @param {object} options
 * @param {Record<string, string>} options.payees  Arc address per payee name (the keys of PAYEES in paid-api.js).
 * @param {typeof settleGatewayPayment} [options.settle]  Stubbed in tests.
 * @returns {http.Server}
 */
export function createGatewaySeller({ payees, settle = settleGatewayPayment }) {
  const calls = Object.fromEntries(Object.keys(ENDPOINTS).map((k) => [k, 0]));
  // Nonces being settled or already settled: one authorization buys one call.
  const used = new Set();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const name = url.pathname.slice(1);
    const endpoint = ENDPOINTS[name];
    if (!endpoint) return send(res, 404, { error: 'not found' });

    const n = calls[name];
    const offer = gatewayOffer({ payTo: payees[endpoint.payee(n)], amount: BigInt(Math.round(endpoint.usd(n) * 1e6)) });
    const resource = { url: url.href, description: `/${name}, one call`, mimeType: 'application/json' };
    const required = { 'payment-required': encodePayment({ x402Version: 2, resource, accepts: [offer] }) };

    const header = req.headers['payment-signature'];
    if (!header) return send(res, 402, {}, required);

    let payment;
    try {
      payment = decodePayment(header);
    } catch {
      return send(res, 400, { error: 'PAYMENT-SIGNATURE is not base64 JSON' });
    }
    const raw = payment?.payload?.authorization?.nonce;
    if (!raw) return send(res, 402, { error: 'not a Gateway authorization' }, required);
    // Hex, and the signature covers its bytes, not its spelling: in another letter case it is the same payment.
    const nonce = String(raw).toLowerCase();
    if (used.has(nonce)) return send(res, 402, { error: 'payment already used' }, required);
    // Reserved before any await, so two copies of one payment can't both be served.
    used.add(nonce);

    const problem = await checkGatewayAuthorization(payment.payload, offer);
    const settled = problem ? { success: false, errorReason: problem } : await settle(payment, offer);
    if (!settled.success) {
      used.delete(nonce);
      const response = encodePayment({ success: false, errorReason: settled.errorReason, network: offer.network });
      return send(res, 402, { error: 'payment not settled', reason: settled.errorReason }, { ...required, 'payment-response': response });
    }

    calls[name]++;
    const payer = settled.payer ?? payment.payload.authorization.from;
    send(res, 200, endpoint.data(), { 'payment-response': encodePayment({ success: true, transaction: settled.transaction, network: offer.network, payer }) });
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = process.env;
  const payees = { weather: env.ARC_PAYEE_WEATHER, news: env.ARC_PAYEE_NEWS, quotes: env.ARC_PAYEE_QUOTES, maps: env.ARC_PAYEE_MAPS, thief: env.ARC_PAYEE_THIEF };
  const port = Number(env.PORT ?? 4403);
  createGatewaySeller({ payees }).listen(port, () => console.log(`Gateway seller on http://localhost:${port} (/weather /news /quotes /maps)`));
}
