import { appendFileSync } from 'node:fs';
import { priceKey } from './policy.js';

/**
 * @typedef {object} Entry
 * @property {number} at  ms since epoch
 * @property {'paid'|'pending'|'denied'|'declined'|'failed'} status  'pending': the rail can't tell
 *   whether the money left (PaymentPending), so it counts as spent.
 * @property {import('./policy.js').Intent} intent
 * @property {import('./policy.js').Reason[]} reasons
 * @property {bigint} usd  micro-dollars
 * @property {object} [receipt]
 * @property {string} [error]
 */

/** Entries whose money left, or may have: budgets and usual prices count both. */
const SPENT = new Set(['paid', 'pending']);

/** Every decision the guard made, paid or not. Budgets and usual prices are read from here. */
export class Ledger {
  /** @param {{file?: string}} [options]  With `file`, each entry is also appended there as a JSON line. */
  constructor({ file } = {}) {
    /** @type {Entry[]} */
    this.entries = [];
    this.file = file;
  }

  /** @param {Entry} entry */
  record(entry) {
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, JSON.stringify(entry, bigintAsString) + '\n');
    return entry;
  }

  /** Micro-dollars paid, or maybe paid (pending), on the UTC day of `now`. */
  spentToday(now) {
    const day = utcDay(now);
    let total = 0n;
    for (const e of this.entries) if (SPENT.has(e.status) && utcDay(e.at) === day) total += e.usd;
    return total;
  }

  /** The last `limit` prices paid for this endpoint, in micro-dollars: the baseline for spotting a spike. */
  recentPrices(intent, limit = 20) {
    const key = priceKey(intent);
    return this.entries.filter((e) => SPENT.has(e.status) && priceKey(e.intent) === key).slice(-limit).map((e) => e.usd);
  }
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function bigintAsString(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
