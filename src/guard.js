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
 * Thrown by a rail when money may have left but the rail can't tell, such as a transfer still
 * pending when it stopped waiting. The guard records it as 'pending', which counts against the
 * budget like 'paid': paying again must not go past the budget if the first one went through.
 */
export class PaymentPending extends Error {
  /**
   * @param {string} message  Says where to check before paying again.
   * @param {object} receipt  What is known so far, such as the provider's transaction id.
   * @param {ErrorOptions} [options]
   */
  constructor(message, receipt, options) {
    super(message, options);
    this.receipt = receipt;
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
      if (err instanceof PaymentPending) this.#record({ ...base, status: 'pending', receipt: err.receipt, error: err.message });
      else this.#record({ ...base, status: 'failed', error: err.message });
      throw err;
    }
  }

  #record(entry) {
    this.emit('entry', this.ledger.record(entry));
  }
}
