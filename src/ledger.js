import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { priceKey } from './policy.js';

/**
 * @typedef {object} Entry
 * @property {string} id  So that later lines about the entry, such as its settlement, can name it.
 * @property {number} at  ms since epoch
 * @property {'paid'|'unconfirmed'|'denied'|'declined'|'failed'} status  `unconfirmed`: sent, but
 *   the rail could not confirm it went through. `failed`: it never left.
 * @property {import('./policy.js').Intent} intent
 * @property {import('./policy.js').Reason[]} reasons
 * @property {bigint} usd  micro-dollars
 * @property {{network: string, txid: string, proof?: object}} [receipt]  An unconfirmed payment has its txid only.
 * @property {string} [error]
 */

/** Every decision the guard made, paid or not. Budgets and usual prices are read from here. */
export class Ledger {
  /**
   * @param {{file?: string}} [options]  With `file`, each entry is also appended there as a JSON
   *   line, and the file is shared: every process that uses it (a server per MCP client, say)
   *   decides against all of it, so they share one budget. Receipts go in whole: for an EIP-3009
   *   payment that is the signed authorization, which can only move the approved amount to the
   *   approved payee before it expires, so a reader of the file can't make it pay anything the
   *   guard has not already counted as spent.
   */
  constructor({ file } = {}) {
    /** @type {Entry[]} */
    this.entries = [];
    this.file = file;
    // Lines this ledger wrote carry its id, so that reading the file back skips them.
    this.id = randomUUID();
    this.read = { bytes: 0, lines: 0 };
  }

  /**
   * @param {Omit<Entry, 'id'>} entry
   * @returns {Entry}
   */
  record(entry) {
    const recorded = { id: randomUUID(), ...entry };
    this.entries.push(recorded);
    if (this.file) appendFileSync(this.file, JSON.stringify({ ...recorded, ledger: this.id }, bigintAsString) + '\n');
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
    applySettlement(entry, settlement, settlement.success ? settlement.transaction : undefined);
    if (this.file) appendFileSync(this.file, JSON.stringify({ at, status: 'settled', entry: entry.id, txid: entry.receipt.txid, settlement, ledger: this.id }, bigintAsString) + '\n');
  }

  /**
   * Runs `fn` as the only process deciding against the file, after reading what the others have
   * written to it: two of them must not both pass the budget check before either has recorded.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async exclusive(fn) {
    if (!this.file) return fn();
    const release = await lock(`${this.file}.lock`);
    try {
      this.sync();
      return await fn();
    } finally {
      release();
    }
  }

  /** Reads the entries other processes appended to the file since the last read. */
  sync() {
    if (!this.file) return;
    let buf;
    let fd;
    try {
      fd = openSync(this.file, 'r');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    try {
      buf = Buffer.alloc(Math.max(0, fstatSync(fd).size - this.read.bytes));
      readSync(fd, buf, 0, buf.length, this.read.bytes);
    } finally {
      closeSync(fd);
    }
    // A line another process is still writing is read next time.
    const end = buf.lastIndexOf(0x0a) + 1;
    const lines = buf.subarray(0, end).toString('utf8').split('\n').slice(0, -1);
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let entry;
      try {
        entry = JSON.parse(line);
        if (entry.status !== 'settled') {
          entry.usd = BigInt(entry.usd);
          entry.intent.amount = BigInt(entry.intent.amount);
        }
      } catch (err) {
        // A budget read from half a ledger would let the agent overspend.
        throw new Error(`line ${this.read.lines + i + 1} of the ledger ${this.file} is not a valid entry (${err.message}); fix or move the file`);
      }
      if (entry.ledger === this.id) return;
      // A settlement line is news about an entry written before it, not a payment of its own.
      if (entry.status === 'settled') {
        const paid = this.entries.findLast((e) => e.id === entry.entry);
        if (paid?.receipt) applySettlement(paid, entry.settlement, entry.txid);
      } else {
        this.entries.push(entry);
      }
    });
    this.read.bytes += end;
    this.read.lines += lines.length;
  }

  /** Micro-dollars paid on the UTC day of `now`, counting unconfirmed payments: they may have gone out. */
  spentToday(now) {
    const day = utcDay(now);
    let total = 0n;
    for (const e of this.entries) if ((e.status === 'paid' || e.status === 'unconfirmed') && utcDay(e.at) === day) total += e.usd;
    return total;
  }

  /** The last `limit` prices paid for this endpoint, in micro-dollars: the baseline for spotting a spike. */
  recentPrices(intent, limit = 20) {
    const key = priceKey(intent);
    return this.entries.filter((e) => e.status === 'paid' && priceKey(e.intent) === key).slice(-limit).map((e) => e.usd);
  }
}

/**
 * Takes the lock file `path`, waiting while another live process holds it, and returns its
 * release. The file holds the holder's pid, so a lock left by a process that died is taken over.
 */
async function lock(path) {
  for (let wait = 1; ; wait = Math.min(wait * 2, 50)) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return () => rmSync(path, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (abandoned(path)) rmSync(path, { force: true });
    else await sleep(wait);
  }
}

/** Whether the lock at `path` was left by a process that is gone. */
function abandoned(path) {
  let pid;
  let age;
  try {
    pid = Number(readFileSync(path, 'utf8'));
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false; // released meanwhile: try again
  }
  // Empty for an instant while its holder writes the pid; empty for long, the holder died then.
  if (!pid) return age > 10_000;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

/** @param {Entry} entry  @param {object} settlement  @param {string} [txid] */
function applySettlement(entry, settlement, txid) {
  entry.receipt.settlement = settlement;
  if (txid) entry.receipt.txid ??= txid;
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function bigintAsString(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}
