import { randomBytes } from 'node:crypto';

/**
 * A rail that pretends to pay: for tests and the offline demo. Its proof carries the payee and
 * amount so the demo paywall can check it was paid what it asked, at the address it asked.
 */
export class MockRail {
  /** @param {string} network */
  constructor(network) {
    this.network = network;
    /** @type {import('../policy.js').Intent[]} */
    this.paid = [];
  }

  /** @param {import('../policy.js').Intent} intent */
  async pay(intent) {
    this.paid.push(intent);
    const txid = randomBytes(16).toString('hex');
    return { network: this.network, txid, proof: { txid, payTo: intent.payTo, amount: intent.amount.toString(), asset: intent.asset } };
  }
}
