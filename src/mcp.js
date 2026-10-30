/**
 * `spend-guard mcp`: the guard as an MCP server over stdio, so the agent in any MCP client
 * (Claude Desktop, Claude Code, Cursor, …) can pay x402 paywalls without holding a wallet. It
 * gets three tools: pay_and_fetch, spending_status and spending_policy. None of them approves
 * a payment or changes the policy: flagged payments wait for the human on the dashboard.
 *
 * JSON-RPC 2.0, one message per line on stdin/stdout (the MCP stdio transport). Nothing else may
 * be written to stdout while the server runs.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Guard, GuardRefused } from './guard.js';
import { Ledger } from './ledger.js';
import { formatUsd, usdToMicro } from './money.js';
import { MockRail } from './rails/mock.js';
import { payingFetch } from './x402.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_BODY = 100_000;
const RESPONSE_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
// Set by the guard, or not the agent's to set: a forged Origin or payment header could pass for
// the dashboard page or for a payment the guard never made.
const DROPPED_HEADERS = /^(host|origin|referer|cookie|connection|content-length|transfer-encoding|x-payment|payment-signature|sec-.*|proxy-.*)$/i;

export const TOOLS = Object.freeze([
  {
    name: 'pay_and_fetch',
    title: 'Fetch, paying the paywall if there is one',
    description: "Fetch a URL and, if it answers HTTP 402 (an x402 paywall), pay it through the user's Spend Guard. The payment goes out only if it fits the user's budget, goes to an address the service is known to use and is not a price spike; larger payments and unknown services wait for the user to approve them on the dashboard. Returns the HTTP status, what was paid (amount, payee, transaction) and the response body. Redirects are not followed. A refused payment is final: tell the user what was refused and why, and do not try to pay another way.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to fetch.' },
        method: { type: 'string', enum: METHODS, description: 'Default GET.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra request headers, e.g. {"accept": "application/json"}. Payment, cookie and origin headers are set by the guard or dropped.' },
        body: { type: 'string', description: 'Request body, for POST, PUT and PATCH.' },
      },
      required: ['url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'spending_status',
    title: 'Spending so far',
    description: "What has been spent today against the user's daily budget, payments waiting for the user's approval, and the latest payments with their outcome (paid, denied, declined or failed) and every reason. Check it before a series of paid calls.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many recent payments to list. Default 10.' } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'spending_policy',
    title: 'Spending rules',
    description: 'The rules the guard enforces: the networks it can pay on, the daily and per-payment limits, the amount above which the user approves, the price-spike ratio, and the known services with the addresses they may be paid at. Read only: only the user can change them.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]);

/** A tool call the agent got wrong: reported to it as a tool error, not a protocol error. */
export class ToolInputError extends Error {}

/**
 * @typedef {object} ToolResult
 * @property {{type: 'text', text: string}[]} content
 * @property {boolean} [isError]
 */

/**
 * The tools' handlers, bound to one guard.
 *
 * @param {object} context
 * @param {Guard} context.guard
 * @param {import('./approval.js').Approvals} [context.approvals]  Without it, flagged payments are declined.
 * @param {string} [context.dashboardUrl]  Where the user answers approvals. The agent may not fetch it.
 * @param {number} [context.responseTimeoutMs]  How long a server may take to start answering.
 * @returns {(name: string, args?: object, call?: {progress?: (message: string) => void, signal?: AbortSignal}) => Promise<ToolResult>}
 *   `signal` aborts when the client cancels the call: a payment not made by then is not made.
 */
export function toolRunner({ guard, approvals, dashboardUrl, responseTimeoutMs = RESPONSE_TIMEOUT_MS }) {
  const dashboard = dashboardUrl ? new URL(dashboardUrl) : null;
  const timedFetch = fetchWithin(responseTimeoutMs);

  async function payAndFetch(args, progress, signal) {
    const url = targetUrl(args.url);
    const method = args.method ?? 'GET';
    if (!METHODS.includes(method)) throw new ToolInputError(`method must be one of ${METHODS.join(', ')}`);
    if (args.body !== undefined && typeof args.body !== 'string') throw new ToolInputError('body must be a string');
    if (args.body !== undefined && method === 'GET') throw new ToolInputError('a GET request has no body');
    // Not followed, so the host the guard judges is always the host that asks for the money.
    const init = { method, headers: requestHeaders(args.headers), body: args.body, redirect: 'manual', signal };

    // The intent this call hands the guard. The guard's entries and asks carry that same object,
    // which tells this call's payment apart from a parallel call's, even for the same URL.
    let intent = null;
    const payer = {
      networks: guard.networks,
      rails: guard.rails,
      pay: (i, options) => guard.pay((intent = i), options),
      settled: (receipt, settlement) => guard.settled(receipt, settlement),
    };
    const entry = () => (intent ? guard.ledger.entries.findLast((e) => e.intent === intent) : undefined);
    let settled = null;
    let heartbeat;
    const onAsked = (ask) => {
      if (ask.intent !== intent) return;
      const where = dashboardUrl ? ` at ${dashboardUrl}` : '';
      progress(`Waiting for the user to approve ${formatUsd(ask.verdict.usd)} to ${ask.intent.payTo}${where}`);
      // A client that resets its timeout on progress (resetTimeoutOnProgress in the TypeScript SDK)
      // keeps waiting while the user decides. Others give up at their own timeout, which cancels
      // the call and withdraws the ask.
      heartbeat = setInterval(() => progress(`Still waiting for the user's approval (${Math.ceil((ask.expiresAt - Date.now()) / 1000)}s left)`), 10_000);
    };
    const onSettled = (s) => {
      if (s.ask.intent !== intent) return;
      settled = s;
      clearInterval(heartbeat);
    };
    approvals?.on('asked', onAsked);
    approvals?.on('settled', onSettled);

    let res;
    let type;
    let body;
    try {
      res = await payingFetch(payer, url, init, { fetch: timedFetch });
      type = res.headers.get('content-type') ?? '';
      body = await readBody(res, type);
    } catch (err) {
      if (err instanceof GuardRefused) return refusal(err, settled);
      return toolError(failure(url, err, entry()));
    } finally {
      clearInterval(heartbeat);
      approvals?.off('asked', onAsked);
      approvals?.off('settled', onSettled);
    }

    const last = entry();
    const paid = last?.status === 'paid' ? last : null;
    const lines = [`HTTP ${res.status} ${res.statusText}`.trim()];
    lines.push(paid ? `Paid ${payment(paid)}${settled?.approved ? ' (approved by the user)' : ''}.` : 'No payment was needed.');
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) lines.push(`Redirects to ${new URL(location, url).href}; not followed: call pay_and_fetch on it if you need it.`);
    if (paid && res.status === 402) lines.push('The server still asks for payment after being paid. Nothing more was paid; tell the user.');
    lines.push(`content-type: ${type || 'unknown'}`, '', body);
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: Boolean(paid && res.status === 402) };
  }

  /** What the agent is told when the call broke for another reason than a refusal. */
  function failure(url, err, entry) {
    const why = err.cause?.message ? `${err.message} (${err.cause.message})` : err.message;
    // Not retried: the request may not be safe to repeat, and a paywall that already took the
    // proof refuses it a second time. The agent must not pay again for what it already paid for.
    if (entry?.status === 'paid') return `Paid ${payment(entry)}, but the paid request failed: ${why}. Do not pay again: tell the user, who can check the payment.`;
    if (entry?.status === 'unconfirmed') {
      return `The payment of ${formatUsd(entry.usd)} to ${entry.intent.payTo} on ${entry.intent.network} is unconfirmed: ${entry.error}. It may still go through, so do not pay again: tell the user, who can check the transaction.`;
    }
    // The rails report a failure after sending as unconfirmed, so a failed payment never left.
    if (entry?.status === 'failed') return `The payment failed, so nothing was paid: ${entry.error}`;
    return `Could not fetch ${url}: ${why}`;
  }

  /** The http(s) URL to fetch, normalized, so that it matches the resource the guard records. */
  function targetUrl(raw) {
    if (typeof raw !== 'string') throw new ToolInputError('url is required');
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new ToolInputError(`"${raw}" is not a URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolInputError(`only http and https URLs can be fetched, not ${url.protocol}`);
    if (dashboard && isLoopback(url.hostname) && port(url) === port(dashboard)) {
      throw new ToolInputError('that is the Spend Guard dashboard, where the user approves payments; it is not for the agent');
    }
    return url.href;
  }

  function refusal(err, settled) {
    const reasons = err.reasons.map((r) => `- ${r.message}`);
    if (err.status === 'denied') {
      return toolError(['Spend Guard refused this payment, so nothing was paid and the content was not fetched:', ...reasons, '', 'Do not try to pay another way or through another URL. Tell the user what was refused and why.'].join('\n'));
    }
    if (settled?.by === 'human') {
      return toolError(['The user declined this payment, so nothing was paid:', ...reasons, '', 'Do not ask for it again unless the user says so.'].join('\n'));
    }
    const why = settled ? 'got no answer in time' : 'no one can be asked (the server runs without a dashboard)';
    const again = dashboardUrl ? ` The user can approve it at ${dashboardUrl} if you try again.` : '';
    return toolError([`This payment needs the user's approval and ${why}, so nothing was paid:`, ...reasons, '', `Tell the user.${again}`].join('\n'));
  }

  function spendingStatus(args) {
    const limit = args.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ToolInputError('limit must be a whole number from 1 to 50');
    guard.ledger.sync(); // what servers sharing the ledger have spent too
    const now = guard.now();
    const spent = guard.ledger.spentToday(now);
    const daily = usdToMicro(guard.policy.dailyUsd);
    const today = guard.ledger.entries.filter((e) => utcDay(e.at) === utcDay(now));
    const paid = today.filter((e) => e.status === 'paid').length;
    const unconfirmed = today.filter((e) => e.status === 'unconfirmed').length;
    const lines = [
      `Spent today (UTC): ${formatUsd(spent)} of the ${formatUsd(daily)} daily budget; ${formatUsd(spent < daily ? daily - spent : 0n)} left.`,
      `Today: ${paid} paid, ${unconfirmed ? `${unconfirmed} unconfirmed, ` : ''}${today.length - paid - unconfirmed} stopped.`,
    ];
    const pending = approvals?.pending ?? [];
    if (pending.length) {
      lines.push('', `Waiting for the user's approval${dashboardUrl ? ` at ${dashboardUrl}` : ''}:`);
      for (const ask of pending) lines.push(`- ${formatUsd(ask.verdict.usd)} for ${ask.intent.resource} to ${ask.intent.payTo}; declined in ${Math.max(0, Math.ceil((ask.expiresAt - Date.now()) / 1000))}s without an answer`);
    }
    const recent = guard.ledger.entries.slice(-limit).reverse();
    lines.push('', recent.length ? 'Latest payments, newest first:' : 'No payments yet.');
    for (const e of recent) {
      const detail = e.status === 'paid' ? (e.receipt?.txid ? `; transaction ${e.receipt.txid}` : '') : e.error ? `: ${e.error}` : `: ${e.reasons.map((r) => r.message).join('; ')}`;
      lines.push(`- ${new Date(e.at).toISOString()} ${e.status} ${formatUsd(e.usd)} ${e.intent.resource} to ${e.intent.payTo}${detail}`);
    }
    return text(lines.join('\n'));
  }

  function spendingPolicy() {
    const p = guard.policy;
    const usd = (n) => formatUsd(usdToMicro(n));
    const lines = [
      `Pays on: ${guard.networks.join(', ') || 'nothing (no rail for the networks the policy allows)'}.`,
      `Daily budget ${usd(p.dailyUsd)}; at most ${usd(p.perPaymentUsd)} per payment; the user approves payments above ${usd(p.askAboveUsd)}.`,
      `A price over ${p.spikeRatio}x an endpoint's usual price is refused. Services not listed below are ${p.unknownService === 'deny' ? 'refused' : 'paid only with the user\'s approval'}.`,
      '',
      Object.keys(p.services).length ? 'Known services and the addresses they may be paid at:' : 'No known services yet.',
      ...Object.entries(p.services).map(([host, s]) => `- ${host}: ${s.payTo.join(', ')}${s.maxUsd !== undefined ? `; at most ${usd(s.maxUsd)} per call` : ''}`),
    ];
    return text(lines.join('\n'));
  }

  return async function run(name, args = {}, { progress = () => {}, signal } = {}) {
    try {
      if (name === 'pay_and_fetch') return await payAndFetch(args, progress, signal);
      if (name === 'spending_status') return spendingStatus(args);
      if (name === 'spending_policy') return spendingPolicy();
      throw new ToolInputError(`unknown tool "${name}"`);
    } catch (err) {
      if (err instanceof ToolInputError) return toolError(`spend-guard: ${err.message}`);
      throw err;
    }
  };
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const toolError = (t) => ({ ...text(t), isError: true });
const payment = (e) => `${formatUsd(e.usd)} to ${e.intent.payTo} on ${e.intent.network}${e.receipt?.txid ? `, transaction ${e.receipt.txid}` : ''}`;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const port = (url) => url.port || (url.protocol === 'https:' ? '443' : '80');

/** Hosts that reach this machine, as the URL parser writes them (it rewrites 0x7f.1, 2130706433, …). */
function isLoopback(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.startsWith('127.') || hostname === '0.0.0.0'
    || hostname === '[::1]' || hostname === '[::]' || hostname.startsWith('[::ffff:7f') || hostname.startsWith('[::ffff:127.');
}

function requestHeaders(headers = {}) {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) throw new ToolInputError('headers must be an object of strings');
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') throw new ToolInputError(`header ${name} must be a string`);
    if (!DROPPED_HEADERS.test(name)) clean[name] = value;
  }
  return clean;
}

/**
 * fetch() that gives up when no response has started within `ms`, so a paywall that takes the
 * payment and then stalls cannot hold the call. Reading the body has its own limit (readBody).
 */
function fetchWithin(ms) {
  return async (url, init = {}) => {
    const late = new AbortController();
    const timer = setTimeout(() => late.abort(new Error(`no response within ${ms / 1000}s`)), ms);
    try {
      return await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, late.signal]) : late.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The body as text, cut at MAX_BODY bytes; binary bodies are described, not sent. */
async function readBody(res, type) {
  if (!res.body) return '';
  if (type && !/^text\/|json|xml|javascript|x-www-form-urlencoded/i.test(type)) {
    await res.body.cancel().catch(() => {});
    return `(a ${type} body, not shown)`;
  }
  const reader = res.body.getReader();
  // A body that never ends (a stream, a stalled server) must not hold the tool call forever.
  let stalled = false;
  const timer = setTimeout(() => {
    stalled = true;
    reader.cancel().catch(() => {});
  }, READ_TIMEOUT_MS);
  const chunks = [];
  let size = 0;
  try {
    while (size <= MAX_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    clearTimeout(timer);
  }
  const cut = size > MAX_BODY;
  if (cut) await reader.cancel().catch(() => {});
  const body = Buffer.concat(chunks).subarray(0, MAX_BODY).toString('utf8');
  if (cut) return `${body}\n… (cut at ${MAX_BODY} bytes)`;
  return stalled ? `${body}\n… (stopped reading after ${READ_TIMEOUT_MS / 1000}s)` : body;
}

/**
 * The guard the server runs, from the environment:
 *   SPEND_GUARD_POLICY        policy JSON file (the Policy in policy.js). Default: no known services,
 *                             so every payment waits for the user.
 *   SPEND_GUARD_RAILS         comma list of mock, near, arc. Default mock (pays nothing).
 *   SPEND_GUARD_MOCK_NETWORK  the network the mock rail pretends to pay on. Default near-testnet,
 *                             as the demo paywall (node demo/paid-api.js) asks.
 *   SPEND_GUARD_LEDGER        JSON-lines file of every decision, read back on start so the daily
 *                             budget survives a restart, and shared, so servers started by several
 *                             clients share one budget. Default ~/.spend-guard/ledger.jsonl; off
 *                             keeps it in memory, for this server alone.
 *   NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY  for near; ARC_PRIVATE_KEY for arc (testnet keys only).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{approve?: ConstructorParameters<typeof Guard>[0]['approve']}} [options]
 */
export async function guardFromEnv(env = process.env, { approve } = {}) {
  const rails = [];
  for (const name of (env.SPEND_GUARD_RAILS || 'mock').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (name === 'mock') {
      rails.push(new MockRail(env.SPEND_GUARD_MOCK_NETWORK || 'near-testnet'));
    } else if (name === 'near') {
      const { NearRail } = await import('./rails/near.js');
      rails.push(new NearRail({ accountId: required(env, 'NEAR_ACCOUNT_ID'), privateKey: required(env, 'NEAR_PRIVATE_KEY'), network: 'near-testnet' }));
    } else if (name === 'arc') {
      const { ArcRail } = await import('./rails/arc.js');
      rails.push(new ArcRail({ privateKey: required(env, 'ARC_PRIVATE_KEY') }));
    } else {
      throw new Error(`unknown rail "${name}" in SPEND_GUARD_RAILS (use mock, near or arc)`);
    }
  }
  const policy = env.SPEND_GUARD_POLICY ? readPolicy(env.SPEND_GUARD_POLICY) : {};
  policy.networks ??= rails.map((r) => r.network);
  const ledgerFile = env.SPEND_GUARD_LEDGER === 'off' ? null : env.SPEND_GUARD_LEDGER || path.join(os.homedir(), '.spend-guard', 'ledger.jsonl');
  return new Guard({ policy, rails, approve, ledger: ledgerFile ? loadLedger(ledgerFile) : new Ledger() });
}

function required(env, name) {
  if (!env[name]) throw new Error(`${name} is not set`);
  return env[name];
}

function readPolicy(file) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read the policy ${file}: ${err.message}`);
  }
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) throw new Error(`the policy ${file} must be a JSON object`);
  return policy;
}

/**
 * A ledger kept in `file`, shared with other servers on the same file, that starts with what is
 * already there. Read now, so that a line that does not parse stops the server at start.
 *
 * @param {string} file
 */
export function loadLedger(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const ledger = new Ledger({ file });
  ledger.sync();
  return ledger;
}

/**
 * Serve MCP on the given streams until the input ends.
 *
 * @param {object} options
 * @param {ReturnType<typeof toolRunner>} options.run
 * @param {string} [options.dashboardUrl]  Named in the instructions, so the agent can point the user to it.
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 */
export async function serveMcp({ run, dashboardUrl, input = process.stdin, output = process.stdout }) {
  const send = (msg) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  /** Calls still running, by request id, so that a cancel stops the call and not just its answer. */
  const running = new Map();
  const pending = new Set();
  const instructions = [
    'Spend Guard pays HTTP 402 (x402) paywalls for you within the budget and rules the user set. Use pay_and_fetch for any URL that may ask for payment; never pay another way.',
    'A refused payment is final: tell the user what was refused and why.',
    dashboardUrl
      ? `Payments above the approval amount wait for the user on the dashboard at ${dashboardUrl}; point the user there when a call is waiting.`
      : "This server runs without a dashboard, so payments that need the user's approval are declined.",
    'spending_status and spending_policy show the budget, recent payments and the rules.',
  ].join(' ');

  async function call(id, params) {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
    const controller = new AbortController();
    const { signal } = controller;
    running.set(id, controller);
    const token = params?._meta?.progressToken;
    let n = 0;
    const progress = (message) => {
      if (token !== undefined && !signal.aborted) send({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message } });
    };
    let result;
    try {
      result = await run(tool.name, params.arguments ?? {}, { progress, signal });
    } catch (err) {
      result = toolError(`spend-guard crashed: ${err?.message ?? err}`);
    } finally {
      running.delete(id);
    }
    if (!signal.aborted) send({ id, result });
  }

  function handle({ id, method, params }) {
    const isRequest = id !== undefined && id !== null;
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'spend-guard', title: 'Spend Guard', version: VERSION },
          instructions,
        },
      });
    }
    if (method === 'ping') return isRequest && send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const p = call(id, params);
      pending.add(p);
      p.finally(() => pending.delete(p));
      return undefined;
    }
    if (method === 'notifications/cancelled') {
      // The client has given up (often its own timeout while the user decides): a payment it would
      // never see the content of must not go out, so the call stops and its ask is withdrawn.
      const reason = params?.reason ? `: ${params.reason}` : '';
      running.get(params?.requestId)?.abort(new Error(`cancelled by the client${reason}`));
      return undefined;
    }
    if (!isRequest) return undefined; // other notifications (initialized, …) need no answer
    return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m && typeof m === 'object' && m.method) handle(m);
    }
  }
  // The client is gone, and nobody is left to receive what the calls still running would pay for.
  for (const controller of running.values()) controller.abort(new Error('the client went away'));
  await Promise.allSettled([...pending]);
}
