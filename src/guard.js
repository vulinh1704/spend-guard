import { EventEmitter } from 'node:events';
import { Ledger } from './ledger.js';
import { DEFAULT_POLICY, evaluate } from './policy.js';

/**
 * @typedef {object} Receipt
 * @property {string} network
 * @property {string} txid
 * @property {object} proof  What the paywall needs to see to release the resource (sent in X-PAYMENT).
 */

/**
 * @typedef {object} Rail  Moves money on one network. The guard is the only caller.
 * @property {string} network
 * @property {(intent: import('./policy.js').Intent) => Promise<Receipt>} pay
 * @property {(offer: object) => {asset: string, amount: bigint, payTo: string} | null} [terms]
 *   x402 v2: what paying this `accepts` entry would cost, or null if the rail can't pay it.
 */

/** Thrown when a payment is denied by policy or declined by the human. */
export class GuardRefused extends Error {
  /** @param {'denied'|'declined'} status  @param {import('./policy.js').Reason[]} reasons */
  constructor(status, reasons) {
    super(`payment ${status}: ${reasons.map((r) => r.message).join('; ')}`);
    this.status = status;
    this.reasons = reasons;
  }
}

/**
 * Sits between the agent and its wallets. The agent asks the guard to pay; the guard checks the
 * policy, asks a human when the policy says so, pays through the matching rail and records the
 * outcome. Emits 'entry' for every recorded decision (the dashboard listens to it).
 */
export class Guard extends EventEmitter {
  /**
   * @param {object} options
   * @param {Partial<import('./policy.js').Policy>} options.policy
   * @param {Rail[]} options.rails
   * @param {(intent: import('./policy.js').Intent, verdict: import('./policy.js').Verdict) => Promise<boolean>} [options.approve]
   *   Asked for payments the policy flags. Without it, flagged payments are declined.
   * @param {Ledger} [options.ledger]
   * @param {() => number} [options.now]
   */
  constructor({ policy, rails, approve = async () => false, ledger = new Ledger(), now = Date.now }) {
    super();
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.rails = new Map(rails.map((r) => [r.network, r]));
    this.approve = approve;
    this.ledger = ledger;
    this.now = now;
    // Payments run one at a time: two parallel tool calls must not both pass the daily budget
    // check before either has been recorded.
    this.queue = Promise.resolve();
  }

  /** Networks this guard can actually pay on: allowed by policy and backed by a rail. */
  get networks() {
    return this.policy.networks.filter((n) => this.rails.has(n));
  }

  /**
   * @param {import('./policy.js').Intent} intent
   * @returns {Promise<Receipt>}
   */
  pay(intent) {
    const run = this.queue.then(() => this.#pay(intent));
    this.queue = run.catch(() => {});
    return run;
  }

  async #pay(intent) {
    const now = this.now();
    const verdict = evaluate(intent, this.policy, {
      spentTodayUsd: this.ledger.spentToday(now),
      recentPricesUsd: this.ledger.recentPrices(intent),
    });
    const base = { at: now, intent, reasons: verdict.reasons, usd: verdict.usd };

    if (verdict.decision === 'deny') {
      this.#record({ ...base, status: 'denied' });
      throw new GuardRefused('denied', verdict.reasons);
    }
    if (verdict.decision === 'ask' && !(await this.approve(intent, verdict))) {
      this.#record({ ...base, status: 'declined' });
      throw new GuardRefused('declined', verdict.reasons);
    }

    const rail = this.rails.get(intent.network);
    if (!rail) {
      const error = `no rail for ${intent.network}`;
      this.#record({ ...base, status: 'failed', error });
      throw new Error(error);
    }
    try {
      const receipt = await rail.pay(intent);
      this.#record({ ...base, status: 'paid', receipt });
      return receipt;
    } catch (err) {
      this.#record({ ...base, status: 'failed', error: err.message });
      throw err;
    }
  }

  #record(entry) {
    this.emit('entry', this.ledger.record(entry));
  }
}
