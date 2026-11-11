import { createHash, randomUUID } from 'node:crypto';
import { PaymentPending } from '../guard.js';

/**
 * Tidepool: a community-run NEAR testnet implementation of the NEAR Intents Agent API (same
 * endpoints and policy model as the official, mainnet-only API, which the official SDK reaches by
 * changing its base URL). Not run by NEAR. https://www.usetidepool.tech/docs/guides/agent-api
 */
export const TIDEPOOL_URL = 'https://www.usetidepool.tech';

/** Test USDC on Tidepool's NEAR testnet verifier (6 decimals), the asset this rail pays in. */
export const TIDEPOOL_USDC = 'nep141:usdc.tidepool-sandbox.testnet';

/** An error answer from the Agent API (JSON:API), with its code and layer (auth, policy, ...). */
export class AgentApiError extends Error {
  /** @param {number} status  @param {{code?: string, layer?: string, title?: string, detail?: string}} [error] */
  constructor(status, error = {}) {
    super(`${error.code ?? `HTTP ${status}`}${error.detail ? `: ${error.detail}` : error.title ? `: ${error.title}` : ''}`);
    this.status = status;
    this.code = error.code;
    this.layer = error.layer;
  }
}

/**
 * A minimal client for the Agent API's /v1 endpoints.
 *
 * @param {object} options
 * @param {string} [options.baseUrl]  The API origin, without /v1.
 * @param {string} [options.apiKey]  The partner key (naa_…).
 * @param {typeof fetch} [options.fetch]
 */
export function agentApi({ baseUrl = TIDEPOOL_URL, apiKey, fetch = globalThis.fetch } = {}) {
  const origin = baseUrl.replace(/\/+$/, '');
  /**
   * @param {string} method
   * @param {string} path  Under /v1, e.g. "/agents/ID/transfer".
   * @param {{body?: object, grant?: string, idem?: string, signal?: AbortSignal}} [options]
   */
  return async function request(method, path, { body, grant, idem, signal } = {}) {
    const headers = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (grant) headers['x-grant-token'] = grant;
    if (idem) headers['idempotency-key'] = idem;
    const res = await fetch(`${origin}/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: signal ?? AbortSignal.timeout(45_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new AgentApiError(res.status, json.errors?.[0]);
    return json;
  };
}

/**
 * The NEP-413 hash an owner signs for an Agent API intent: sha256 of the borsh-encoded tag
 * 2^31 + 413, message, 32-byte nonce, recipient and an absent callback URL.
 *
 * @param {{message: string, nonce: string, recipient: string}} payload  nonce in base64.
 */
export function nep413Hash({ message, nonce, recipient }) {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([u32(b.length), b]);
  };
  const nonceBytes = Buffer.from(nonce, 'base64');
  if (nonceBytes.length !== 32) throw new Error(`a NEP-413 nonce is 32 bytes, not ${nonceBytes.length}`);
  return createHash('sha256').update(Buffer.concat([u32(2 ** 31 + 413), str(message), nonceBytes, str(recipient), Buffer.from([0])])).digest();
}

/**
 * Pays through the NEAR Intents Agent API (on Tidepool's testnet): a `transfer` of test USDC
 * inside the Intents verifier, from the agent's wallet to the payee's account. The agent holds a
 * partner API key and a grant token, never the owner's key, and the owner's signed policy
 * (destinations, per-transaction and daily limits, a USD budget) is checked by the API before
 * anything moves. Spend Guard decides first; the API's policy is a second, separate limit.
 */
export class IntentsAgentRail {
  /**
   * @param {object} options
   * @param {string} options.apiKey  Partner key (naa_…).
   * @param {string} options.agentId
   * @param {string} options.grantToken  ngt_…, registered by the owner with grant_issue.
   * @param {string} options.agentAccount  The agent wallet's NEAR account, the sender in the proof.
   * @param {string} [options.baseUrl]
   * @param {string} [options.asset]  Agent API asset id paid for x402 'usdc' offers.
   * @param {string} [options.network]
   * @param {typeof fetch} [options.fetch]
   * @param {number} [options.waitMs]  How long to wait for the transfer to settle.
   */
  constructor({ apiKey, agentId, grantToken, agentAccount, baseUrl = TIDEPOOL_URL, asset = TIDEPOOL_USDC, network = 'near-intents-testnet', fetch, waitMs = 90_000 }) {
    for (const [name, value] of Object.entries({ apiKey, agentId, grantToken, agentAccount })) {
      if (!value) throw new Error(`IntentsAgentRail needs ${name}`);
    }
    this.network = network;
    this.agentId = agentId;
    this.agentAccount = agentAccount;
    this.asset = asset;
    this.grantToken = grantToken;
    this.waitMs = waitMs;
    this.api = agentApi({ baseUrl, apiKey, fetch });
  }

  /** @param {import('../policy.js').Intent} intent */
  async pay(intent) {
    if (intent.asset !== 'usdc') throw new Error(`IntentsAgentRail pays in USDC; ${intent.resource} asked for ${intent.asset}`);
    const body = { asset: this.asset, amount: intent.amount.toString(), recipient: intent.payTo };
    let accepted;
    try {
      accepted = await this.api('POST', `/agents/${this.agentId}/transfer`, { body, grant: this.grantToken, idem: `spend-guard-${randomUUID()}` });
    } catch (err) {
      // Refused before anything moved: the owner's policy (destination, limits, budget), a
      // revoked grant, a frozen wallet.
      if (err instanceof AgentApiError) throw new Error(`the NEAR Intents Agent API refused: ${err.message}`, { cause: err });
      throw err;
    }
    const id = accepted.correlation_id;
    const status = await this.settled(id);
    if (status.status === 'SUCCESS' && status.details?.tx_hash) {
      const txid = status.details.tx_hash;
      return { network: this.network, txid, proof: { txid, sender: this.agentAccount, asset: this.asset, correlation_id: id } };
    }
    if (status.status === 'FAILED' || status.status === 'REFUNDED') {
      throw new Error(`the NEAR Intents Agent API did not make the transfer: ${status.status} ${status.failure_code ?? ''}`.trim());
    }
    // Accepted but not settled in time (or UNCERTAIN): it may still go through.
    throw new PaymentPending(`transfer ${id} was accepted by the NEAR Intents Agent API but is ${status.status ?? 'not settled'}; check GET /v1/status?correlation_id=${id}`, { correlationId: id });
  }


  /**
   * Long-polls the transfer's status until it ends or waitMs runs out. A failed poll (a network
   * error, a busy server) waits a little longer each time before the next one.
   */
  async settled(id) {
    const until = Date.now() + this.waitMs;
    let last = {};
    let backoff = 1000;
    while (Date.now() < until) {
      try {
        const wait = Math.max(1000, Math.min(30_000, until - Date.now()));
        last = await this.api('GET', `/status?correlation_id=${encodeURIComponent(id)}&wait_ms=${wait}`);
        backoff = 1000;
      } catch (err) {
        last = { status: undefined, error: err.message };
        await sleep(Math.min(backoff, Math.max(0, until - Date.now())));
        backoff = Math.min(backoff * 2, 8000);
        continue;
      }
      if (FINAL.has(last.status)) return last;
      // A long poll may come back early with nothing new; don't spin on it.
      await sleep(Math.min(500, Math.max(0, until - Date.now())));
    }
    return last;
  }

  /** The agent wallet's balance of the paying asset, in atomic units, as the API reports it. */
  async balance() {
    const { balances = [] } = await this.api('GET', `/agents/${this.agentId}/balances`);
    return BigInt(balances.find((b) => b.asset_id === this.asset)?.balance_raw ?? 0);
  }
}

const FINAL = new Set(['SUCCESS', 'FAILED', 'REFUNDED', 'UNCERTAIN', 'NEEDS_REVIEW']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tidepool's verifier: NEAR's Intents verifier contract (defuse v0.4.5), deployed on testnet. */
export const TIDEPOOL_VERIFIER = 'verifier.tidepool-sandbox.testnet';

/** The account that submits Tidepool's intents to the verifier, i.e. signs its transactions. */
export const TIDEPOOL_RELAYER = 'maker.tidepool-sandbox.testnet';

/**
 * The paywall's side: did transaction `txid` move at least `amount` of `asset` inside the Intents
 * verifier, from the agent's account (`sender`) to `payTo`? Reads the transaction and its receipts
 * from NEAR RPC and adds up the verifier's own NEP-245 `mt_transfer` events, so neither the agent
 * nor the Agent API is taken on trust. The transaction is signed by the relayer that submits the
 * intents (`proof.signer`, or Tidepool's), and RPC needs that account to find it.
 *
 * @param {Pick<import('near-api-js').JsonRpcProvider, 'viewTransactionStatusWithReceipts'>} provider
 * @param {{txid: string, sender: string, signer?: string}} proof
 * @param {{payTo: string, amount: bigint}} expected
 * @param {{verifier?: string, asset?: string, relayer?: string}} [options]
 * @returns {Promise<string|null>}  null when the payment checks out, otherwise why not.
 */
export async function checkIntentsPayment(provider, proof, expected, { verifier = TIDEPOOL_VERIFIER, asset = TIDEPOOL_USDC, relayer = TIDEPOOL_RELAYER } = {}) {
  if (typeof proof?.txid !== 'string' || typeof proof.sender !== 'string') return 'the proof needs txid and sender';
  let outcome;
  try {
    outcome = await provider.viewTransactionStatusWithReceipts({ txHash: proof.txid, accountId: proof.signer ?? relayer, waitUntil: 'EXECUTED_OPTIMISTIC' });
  } catch (err) {
    return `transaction ${proof.txid} not found: ${err.message}`;
  }
  return intentsPaymentProblem(outcome, proof, expected, { verifier, asset });
}

/**
 * The check in checkIntentsPayment, on an EXPERIMENTAL_tx_status result already fetched.
 *
 * @param {object} outcome
 * @param {{txid: string, sender: string}} proof
 * @param {{payTo: string, amount: bigint}} expected
 * @param {{verifier?: string, asset?: string}} [options]
 * @returns {string|null}
 */
export function intentsPaymentProblem(outcome, proof, expected, { verifier = TIDEPOOL_VERIFIER, asset = TIDEPOOL_USDC } = {}) {
  if (outcome?.transaction?.receiver_id !== verifier) return `transaction ${proof.txid} was not sent to the verifier ${verifier}`;
  let paid = 0n;
  const others = new Set();
  for (const r of outcome.receipts_outcome ?? []) {
    const o = r.outcome;
    // Only the verifier's own logs count, and only from receipts that succeeded.
    if (o?.executor_id !== verifier || !o.status || 'Failure' in o.status) continue;
    for (const log of o.logs ?? []) {
      const event = parseEvent(log);
      if (event?.standard !== 'nep245' || event.event !== 'mt_transfer') continue;
      for (const t of event.data ?? []) {
        if (t.old_owner_id !== proof.sender) continue;
        (t.token_ids ?? []).forEach((token, i) => {
          if (token !== asset) return;
          if (t.new_owner_id === expected.payTo) paid += BigInt(t.amounts?.[i] ?? 0);
          else others.add(t.new_owner_id);
        });
      }
    }
  }
  if (paid === 0n) {
    if (others.size) return `transaction ${proof.txid} moved ${asset} from ${proof.sender} to ${[...others].join(', ')}, not ${expected.payTo}`;
    return `transaction ${proof.txid} moved no ${asset} from ${proof.sender} to ${expected.payTo}`;
  }
  if (paid < expected.amount) return `transaction ${proof.txid} moved ${paid} of ${asset}, not ${expected.amount}`;
  return null;
}

/** The JSON of a NEP-297 `EVENT_JSON:` log line, or null. */
function parseEvent(log) {
  if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) return null;
  try {
    return JSON.parse(log.slice('EVENT_JSON:'.length));
  } catch {
    return null;
  }
}
