/**
 * Amounts travel as atomic units (bigint) because chains and x402 count in the asset's smallest
 * unit. Policy limits are in US dollars, so every check converts to micro-dollars (1e-6 USD)
 * and compares integers: no floating point ever decides whether a payment goes out.
 */

/**
 * @typedef {object} Asset
 * @property {string} symbol
 * @property {number} decimals
 * @property {number} usd  Price of one whole unit in US dollars (1 for stablecoins).
 */

/** @type {Record<string, Asset>} */
export const ASSETS = {
  'usdc': { symbol: 'USDC', decimals: 6, usd: 1 },
  'pusd': { symbol: 'PUSD', decimals: 2, usd: 1 },
  'near': { symbol: 'NEAR', decimals: 24, usd: 2.5 },
  'bch': { symbol: 'BCH', decimals: 8, usd: 450 },
  'ccd': { symbol: 'CCD', decimals: 6, usd: 0.01 },
};

const MICROS = 1_000_000n;

/**
 * @param {bigint} atomic
 * @param {Asset} asset
 * @returns {bigint} micro-dollars
 */
export function toMicroUsd(atomic, asset) {
  const usdMicros = BigInt(Math.round(asset.usd * 1e6));
  return (atomic * usdMicros) / 10n ** BigInt(asset.decimals);
}

/** @param {number} usd */
export function usdToMicro(usd) {
  return BigInt(Math.round(usd * 1e6));
}

/** "$0.0125" for display; trailing zeros past the cents are dropped. */
export function formatUsd(micros) {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICROS;
  const frac = (abs % MICROS).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}$${whole}.${frac}`;
}

/**
 * @param {string} id  An ASSETS key, or the symbol in any case.
 * @returns {Asset}
 */
export function assetOf(id) {
  const asset = ASSETS[id.toLowerCase()];
  if (!asset) throw new Error(`unknown asset "${id}"; add it to ASSETS with its decimals and USD price`);
  return asset;
}
