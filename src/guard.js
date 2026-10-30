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

/** Added to a payment the agent stopped waiting for: it would never get what it paid for. */
const CANCELLED = { code: 'cancelled', message: 'the agent stopped waiting, so nothing was paid' };

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
   * @param {(intent: import('./policy.js').Intent, verdict: import('./policy.js').Verdict, options: {signal?: AbortSignal}) => Promise<boolean>} [options.approve]
   *   Asked for payments the policy flags. Without it, flagged payments are declined. The signal
   *   aborts when the agent stops waiting, so the question can be withdrawn.
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
   * @param {{signal?: AbortSignal}} [options]  Abort it when the caller stops waiting: a payment
   *   that has not gone out by then never does.
   * @returns {Promise<Receipt>}
   */
  async pay(intent, { signal } = {}) {
    const first = await this.#serial(() => this.#turn(intent, signal));
    if (first.receipt) return first.receipt;
    // A human takes a while to answer, so the wait happens outside the queue: payments the policy
    // allows go on meanwhile, and this one is decided again afterwards, against the ledger as it is then.
    const { verdict } = first;
    if (!(await this.approve(intent, verdict, { signal }))) {
      this.#refuse('declined', { at: this.now(), intent, reasons: signal?.aborted ? [...verdict.reasons, CANCELLED] : verdict.reasons, usd: verdict.usd });
    }
    return (await this.#serial(() => this.#turn(intent, signal, verdict))).receipt;
  }

  #serial(step) {
    const run = this.queue.then(step);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * A payment's turn in the queue: decide it against the ledger as it is now, then refuse it, pay
   * it, or hand back the verdict to ask the human about.
   *
   * @param {import('./policy.js').Intent} intent
   * @param {AbortSignal} [signal]
   * @param {import('./policy.js').Verdict} [approved]  What the human said yes to, once asked.
   * @returns {Promise<{receipt: Receipt, verdict?: undefined} | {verdict: import('./policy.js').Verdict, receipt?: undefined}>}
   */
  async #turn(intent, signal, approved) {
    if (signal?.aborted) {
      if (!approved) throw signal.reason;
      this.#refuse('declined', { at: this.now(), intent, reasons: [...approved.reasons, CANCELLED], usd: approved.usd });
    }
    const now = this.now();
    const verdict = evaluate(intent, this.policy, {
      spentTodayUsd: this.ledger.spentToday(now),
      recentPricesUsd: this.ledger.recentPrices(intent),
    });
    const base = { at: now, intent, reasons: verdict.reasons, usd: verdict.usd };

    if (verdict.decision === 'deny') this.#refuse('denied', base);
    // A yes covers the ask rules, which read only the intent and the policy. The deny rules read
    // the ledger, which may have moved while the human decided: they were just checked again.
    if (verdict.decision === 'ask' && !approved) return { verdict };

    const rail = this.rails.get(intent.network);
    if (!rail) {
      const error = `no rail for ${intent.network}`;
      this.#record({ ...base, status: 'failed', error });
      throw new Error(error);
    }
    try {
      const receipt = await rail.pay(intent);
      this.#record({ ...base, status: 'paid', receipt });
      return { receipt };
    } catch (err) {
      this.#record({ ...base, status: 'failed', error: err.message });
      throw err;
    }
  }

  /** @returns {never} */
  #refuse(status, entry) {
    this.#record({ ...entry, status });
    throw new GuardRefused(status, entry.reasons);
  }

  #record(entry) {
    this.emit('entry', this.ledger.record(entry));
  }
}
