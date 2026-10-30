import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * @typedef {object} Ask  A payment the policy flagged, waiting for a human yes or no.
 * @property {string} id  Random, so only a page that was shown the ask can answer it.
 * @property {number} at  ms since epoch
 * @property {number} expiresAt  With no answer by then, the payment is declined.
 * @property {import('./policy.js').Intent} intent
 * @property {import('./policy.js').Verdict} verdict
 */

/**
 * @typedef {object} Settlement
 * @property {Ask} ask
 * @property {boolean} approved
 * @property {'human'|'timeout'|'closed'|'cancelled'} by  `cancelled`: the agent stopped waiting.
 */

/**
 * Payments waiting for a human, answered from the dashboard. `ask` is the Guard's `approve`
 * callback: it resolves true only on an explicit approve, and false on deny, on timeout, when
 * the agent stops waiting or when the queue closes, so a payment nobody looked at never goes out.
 * Emits 'asked' (Ask) and 'settled' (Settlement).
 */
export class Approvals extends EventEmitter {
  /** @param {{timeoutMs?: number, now?: () => number}} [options] */
  constructor({ timeoutMs = 120_000, now = Date.now } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.now = now;
    /** @type {Map<string, {ask: Ask, settle: (approved: boolean, by: Settlement['by']) => void}>} */
    this.waiting = new Map();
    this.ask = this.ask.bind(this);
  }

  /**
   * @param {import('./policy.js').Intent} intent
   * @param {import('./policy.js').Verdict} verdict
   * @param {{signal?: AbortSignal}} [options]  When it aborts, the ask is withdrawn from the page.
   * @returns {Promise<boolean>}
   */
  ask(intent, verdict, { signal } = {}) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const at = this.now();
      const ask = { id: randomUUID(), at, expiresAt: at + this.timeoutMs, intent, verdict };
      const timer = setTimeout(() => settle(false, 'timeout'), this.timeoutMs);
      const cancel = () => settle(false, 'cancelled');
      const settle = (approved, by) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.waiting.delete(ask.id);
        this.emit('settled', { ask, approved, by });
        resolve(approved);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.waiting.set(ask.id, { ask, settle });
      this.emit('asked', ask);
    });
  }

  /** @returns {Ask[]} oldest first */
  get pending() {
    return [...this.waiting.values()].map((w) => w.ask);
  }

  /**
   * Answer one ask. Only `true` approves. Returns false, and changes nothing, when `id` is not
   * waiting: never asked, already answered or timed out.
   *
   * @param {string} id
   * @param {boolean} approved
   */
  decide(id, approved) {
    const waiting = this.waiting.get(id);
    if (!waiting) return false;
    waiting.settle(approved === true, 'human');
    return true;
  }

  /** Decline everything still waiting, e.g. when the server shuts down. */
  close() {
    for (const { settle } of [...this.waiting.values()]) settle(false, 'closed');
  }
}
