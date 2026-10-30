import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { priceKey } from './policy.js';

/**
 * @typedef {object} Entry
 * @property {string} id  So that later lines about the entry, such as its settlement, can name it.
 * @property {number} at  ms since epoch
 * @property {'paid'|'denied'|'declined'|'failed'} status
 * @property {import('./policy.js').Intent} intent
 * @property {import('./policy.js').Reason[]} reasons
 * @property {bigint} usd  micro-dollars
 * @property {object} [receipt]
 * @property {string} [error]
 */

/** Every decision the guard made, paid or not. Budgets and usual prices are read from here. */
export class Ledger {
  /**
   * @param {{file?: string}} [options]  With `file`, each entry is also appended there as a JSON
   *   line. Receipts go in whole: for an EIP-3009 payment that is the signed authorization, which
   *   can only move the approved amount to the approved payee before it expires, so a reader of
   *   the file can't make it pay anything the guard has not already counted as spent.
   */
  constructor({ file } = {}) {
    /** @type {Entry[]} */
    this.entries = [];
    this.file = file;
  }

  /**
   * @param {Omit<Entry, 'id'>} entry
   * @returns {Entry}
   */
  record(entry) {
    const recorded = { id: randomUUID(), ...entry };
    this.entries.push(recorded);
    if (this.file) appendFileSync(this.file, JSON.stringify(recorded, bigintAsString) + '\n');
    return recorded;
  }

  /**
   * Adds the paywall's settlement to a paid entry, plus its transaction when the rail had none.
   * It arrives after the entry was written, so the file gets a 'settled' line naming the entry.
   *
   * @param {Entry} entry
   * @param {{success?: boolean, transaction?: string}} settlement  x402's SettleResponse.
   * @param {number} [at]
   */
  settle(entry, settlement, at = Date.now()) {
    entry.receipt.settlement = settlement;
    if (settlement.success && settlement.transaction) entry.receipt.txid ??= settlement.transaction;
    if (this.file) appendFileSync(this.file, JSON.stringify({ at, status: 'settled', entry: entry.id, txid: entry.receipt.txid, settlement }, bigintAsString) + '\n');
  }

  /** Micro-dollars actually paid on the UTC day of `now`. */
  spentToday(now) {
    const day = utcDay(now);
    let total = 0n;
    for (const e of this.entries) if (e.status === 'paid' && utcDay(e.at) === day) total += e.usd;
    return total;
  }

  /** The last `limit` prices paid for this endpoint, in micro-dollars: the baseline for spotting a spike. */
  recentPrices(intent, limit = 20) {
    const key = priceKey(intent);
    return this.entries.filter((e) => e.status === 'paid' && priceKey(e.intent) === key).slice(-limit).map((e) => e.usd);
  }
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function bigintAsString(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
