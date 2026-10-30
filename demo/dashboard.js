/**
 * A live page of the guard's decisions: the budget, what was paid (with the transaction) and
 * what was stopped (with every reason). Entries arrive over server-sent events, so the page
 * updates while the agent runs; a page opened late is sent the history first.
 *
 * With `approvals`, payments the policy flags wait on the page with Approve and Deny buttons.
 * The dashboard answers only to localhost, and an answer is taken only from the page itself:
 * another site open in the same browser cannot approve a payment, and neither can the agent
 * through its own HTTP tool.
 */
import http from 'node:http';
import { formatUsd, usdToMicro } from '../src/money.js';

/**
 * @param {import('../src/guard.js').Guard} guard
 * @param {{title?: string, account?: string, explorer?: (txid: string, network: string) => string|null, approvals?: import('../src/approval.js').Approvals}} [options]
 * @returns {http.Server}
 */
export function createDashboard(guard, { title = 'Spend Guard', account = '', explorer, approvals } = {}) {
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();
  // How each flagged payment was answered, keyed by the intent the guard and the approvals share.
  /** @type {WeakMap<object, 'approved'|'denied'|'timeout'>} */
  const answers = new WeakMap();

  const view = (entry) => ({
    id: entry.id,
    at: entry.at,
    status: entry.status,
    usd: formatUsd(entry.usd),
    endpoint: new URL(entry.intent.resource).pathname,
    payTo: entry.intent.payTo,
    reasons: entry.reasons.map((r) => r.message),
    answer: answers.get(entry.intent) ?? null,
    error: entry.error ?? null,
    tx: entry.receipt?.txid ?? null,
    txUrl: entry.receipt?.txid && explorer ? explorer(entry.receipt.txid, entry.intent.network) : null,
    // A signed payment (x402 exact) is settled by the paywall afterwards, and that can fail.
    unsettled: entry.receipt?.settlement?.success === false ? entry.receipt.settlement.errorReason ?? 'not settled' : null,
    spent: formatUsd(guard.ledger.spentToday(entry.at)),
    spentRatio: Number((guard.ledger.spentToday(entry.at) * 1000n) / usdToMicro(guard.policy.dailyUsd)) / 1000,
  });
  /** @param {import('../src/approval.js').Ask} ask */
  const askView = (ask) => ({
    id: ask.id,
    usd: formatUsd(ask.verdict.usd),
    endpoint: new URL(ask.intent.resource).pathname,
    host: ask.intent.host,
    payTo: ask.intent.payTo,
    network: ask.intent.network,
    reasons: ask.verdict.reasons.map((r) => r.message),
    expiresIn: Math.max(0, ask.expiresAt - approvals.now()),
  });

  const sse = (event, data) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
  const broadcast = (chunk) => {
    for (const res of clients) res.write(chunk);
  };

  guard.on('entry', (entry) => broadcast(sse(null, view(entry))));
  // The paywall's settlement arrives after the entry: it brings the transaction of a signed payment.
  guard.on('settled', (entry) => broadcast(sse('receipt', view(entry))));
  approvals?.on('asked', (ask) => broadcast(sse('ask', askView(ask))));
  approvals?.on('settled', ({ ask, approved, by }) => {
    // When the agent stopped waiting, nobody answered: the entry's own reason says what happened.
    if (by !== 'cancelled') answers.set(ask.intent, approved ? 'approved' : by === 'human' ? 'denied' : 'timeout');
    broadcast(sse('settled', { id: ask.id, approved, by }));
  });

  return http.createServer(async (req, res) => {
    // A DNS-rebinding page reaches us under its own host name; only localhost names are served.
    if (!LOOPBACK_HOSTS.has(hostname(req.headers.host))) return json(res, 403, { error: 'the dashboard answers on localhost only' });

    const answer = req.url?.match(/^\/approvals\/([\w-]{1,64})$/);
    if (answer && req.method === 'POST') return decide(req, res, answer[1]);

    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders(); // the page is connected even before there is anything to send
      for (const entry of guard.ledger.entries) res.write(sse(null, view(entry)));
      for (const ask of approvals?.pending ?? []) res.write(sse('ask', askView(ask)));
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page({ title, account, daily: formatUsd(usdToMicro(guard.policy.dailyUsd)), perPayment: formatUsd(usdToMicro(guard.policy.perPaymentUsd)), askAbove: formatUsd(usdToMicro(guard.policy.askAboveUsd)), spike: guard.policy.spikeRatio }));
      return;
    }
    res.writeHead(404).end();
  });

  async function decide(req, res, id) {
    if (!approvals) return json(res, 404, { error: 'this dashboard takes no approvals' });
    const refused = crossSite(req);
    if (refused) return json(res, 403, { error: refused });
    // A JSON body cannot be sent cross-site without a CORS preflight, which this server never grants.
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'send {"approve": true|false} as application/json' });
    let body;
    try {
      body = JSON.parse(await readBody(req, 1024));
    } catch {
      return json(res, 400, { error: 'send {"approve": true|false} as application/json' });
    }
    if (typeof body?.approve !== 'boolean') return json(res, 400, { error: '"approve" must be true or false' });
    if (!approvals.decide(id, body.approve)) return json(res, 404, { error: 'no payment is waiting under that id: it was answered, timed out or never asked' });
    json(res, 200, { ok: true });
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostname(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/** Why a request to answer an ask is refused, or null. Only the page itself, on this machine, may answer. */
function crossSite(req) {
  const from = req.socket.remoteAddress ?? '';
  if (!(from === '::1' || from.startsWith('127.') || from.startsWith('::ffff:127.'))) return 'approvals are taken from this machine only';
  // Browsers send Origin on every POST; a request without it did not come from the page.
  if (req.headers.origin !== `http://${req.headers.host}`) return 'approvals are taken from the dashboard page only';
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return 'approvals are taken from the dashboard page only';
  return null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function page({ title, account, daily, perPayment, askAbove, spike }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #ffffff; --text: #16181d; --muted: #5b6270; --line: #e3e6eb;
    --ok: #0f7b53; --ok-bg: #e3f4ec; --on-ok: #ffffff; --stop: #b42318; --stop-bg: #fdeceb; --ask: #8a5a00; --ask-bg: #fdf3dc;
    --meter: #2f5bea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --card: #171a21; --text: #eef0f4; --muted: #a2a9b6; --line: #2a2f3a;
      --ok: #4ad295; --ok-bg: #12291f; --on-ok: #06140d; --stop: #ff7b6e; --stop-bg: #2d1514; --ask: #f2c260; --ask-bg: #2b2210;
      --meter: #7c9cff;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 8px; }
  .account { color: var(--muted); font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 20px 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; min-width: 0; }
  .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .value { font-size: 24px; font-weight: 650; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .meter { height: 8px; border-radius: 4px; background: var(--line); margin-top: 10px; overflow: hidden; }
  .meter > div { height: 100%; width: 0; background: var(--meter); transition: width .4s ease; }
  .rules { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
  .approvals { margin: 0 0 20px; }
  .approvals h2 { color: var(--ask); }
  .asks { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  .ask { background: var(--ask-bg); border: 1px solid var(--line); border-left: 4px solid var(--ask); border-radius: 10px; padding: 12px 14px; min-width: 0; animation: in .35s ease; }
  .ask p { margin: 0 0 4px; overflow-wrap: anywhere; }
  .ask-title { font-weight: 600; }
  .ask .detail, .ask .countdown { color: var(--muted); font-size: 13px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  button { font: inherit; font-weight: 650; min-height: 44px; min-width: 96px; padding: 0 18px; border-radius: 8px; border: 2px solid transparent; cursor: pointer; }
  button:focus-visible { outline: 3px solid var(--meter); outline-offset: 2px; }
  button[aria-disabled="true"] { opacity: .6; cursor: progress; }
  .approve { background: var(--ok); color: var(--on-ok); }
  .deny { background: transparent; color: var(--stop); border-color: var(--stop); }
  .notice { margin: 0 0 16px; font-weight: 600; }
  .notice:empty { display: none; }
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .feed { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .feed > li { background: var(--card); border: 1px solid var(--line); border-left-width: 4px; border-radius: 10px; padding: 10px 14px; display: grid; grid-template-columns: auto 1fr auto; gap: 4px 12px; align-items: baseline; animation: in .35s ease; min-width: 0; }
  .feed > li.paid { border-left-color: var(--ok); }
  .feed > li.denied, .feed > li.declined, .feed > li.failed { border-left-color: var(--stop); }
  .feed > li.unconfirmed { border-left-color: var(--ask); }
  .pill { font-size: 12px; font-weight: 650; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .paid .pill { color: var(--ok); background: var(--ok-bg); }
  .unconfirmed .pill { color: var(--ask); background: var(--ask-bg); }
  .denied .pill, .declined .pill, .failed .pill { color: var(--stop); background: var(--stop-bg); }
  .endpoint { font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 0; overflow-wrap: anywhere; }
  .amount { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
  .feed .detail { grid-column: 2 / -1; color: var(--muted); font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
  .denied .detail, .declined .detail { color: var(--stop); }
  .detail a { color: inherit; }
  .empty { color: var(--muted); text-align: center; padding: 32px 0; }
  @keyframes in { from { opacity: 0; transform: translateY(-6px); } }
  @media (prefers-reduced-motion: reduce) { .feed > li, .ask { animation: none; } .meter > div { transition: none; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>${escape(title)}</h1>
    <span class="account">${escape(account)}</span>
  </header>
  <section class="cards" aria-label="Today">
    <div class="card"><div class="label">Spent today</div><div class="value" id="spent">$0.00</div><div class="meter" role="progressbar" aria-label="Daily budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="meter"><div></div></div></div>
    <div class="card"><div class="label">Daily budget</div><div class="value">${escape(daily)}</div></div>
    <div class="card"><div class="label">Paid</div><div class="value" id="paid">0</div></div>
    <div class="card"><div class="label">Stopped</div><div class="value" id="stopped">0</div></div>
  </section>
  <p class="rules">At most ${escape(perPayment)} per payment · approval above ${escape(askAbove)} · known payees only · prices over ${escape(spike)}x the usual are refused</p>
  <section class="approvals" id="approvals" aria-labelledby="approvals-title" hidden>
    <h2 id="approvals-title">Needs your approval</h2>
    <ul class="asks" id="asks"></ul>
  </section>
  <p class="notice" id="notice" role="status"></p>
  <p class="sr-only" id="announce" role="status"></p>
  <h2 id="feed-title" tabindex="-1">Payments</h2>
  <ol class="feed" id="feed" aria-live="polite" aria-labelledby="feed-title"><li class="empty" style="display:block;border:0;background:none">Waiting for the agent's first payment…</li></ol>
</main>
<script>
  const title = document.title;
  const feed = document.getElementById('feed');
  const asksEl = document.getElementById('asks');
  const notice = document.getElementById('notice');
  /** @type {Map<string, {li: HTMLLIElement, deadline: number, label: string}>} */
  const asks = new Map();
  let counts = { paid: 0, stopped: 0 };
  const LABEL = { paid: 'Paid', unconfirmed: 'Unconfirmed', denied: 'Stopped', declined: 'Declined', failed: 'Failed' };
  const ANSWER = { approved: 'approved by you', denied: 'you denied it', timeout: 'no answer in time' };
  const text = (tag, cls, value) => { const el = document.createElement(tag); el.className = cls; el.textContent = value; return el; };
  const clock = (ms) => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function detailOf(e) {
    const detail = document.createElement('div');
    detail.className = 'detail';
    const answered = e.answer ? ANSWER[e.answer] + ' · ' : '';
    if (e.status === 'paid' || e.status === 'unconfirmed') {
      const to = e.status === 'paid' ? 'to ' + e.payTo : 'sent to ' + e.payTo + ' but not confirmed: it may still go through, check the transaction';
      detail.append(answered + to + (e.tx ? ' · ' : ''));
      if (e.txUrl) { const a = document.createElement('a'); a.href = e.txUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = e.tx.slice(0, 10) + '…'; detail.append(a); }
      else if (e.tx) detail.append(e.tx.slice(0, 10) + '…');
      if (e.unsettled) detail.append(' · signed, but the paywall did not settle it (' + e.unsettled + '); it still counts until it expires');
    } else {
      detail.textContent = answered + (e.error ? [...e.reasons, e.error] : e.reasons).join(' · ');
    }
    return detail;
  }

  function addEntry(e) {
    feed.querySelector('.empty')?.remove();
    const li = document.createElement('li');
    li.className = e.status;
    li.dataset.id = e.id;
    li.append(text('span', 'pill', LABEL[e.status] ?? e.status), text('span', 'endpoint', e.endpoint), text('span', 'amount', e.usd));
    li.append(detailOf(e));
    feed.prepend(li);
    // An unconfirmed payment is neither: it counts in the spend above, as it may have gone out.
    if (e.status === 'paid') counts.paid++; else if (e.status !== 'unconfirmed') counts.stopped++;
    document.getElementById('paid').textContent = counts.paid;
    document.getElementById('stopped').textContent = counts.stopped;
    document.getElementById('spent').textContent = e.spent;
    const pct = Math.min(100, Math.round(e.spentRatio * 100));
    const meter = document.getElementById('meter');
    meter.firstElementChild.style.width = pct + '%';
    meter.setAttribute('aria-valuenow', pct);
  }

  function addAsk(a) {
    if (asks.has(a.id)) return;
    const li = document.createElement('li');
    li.className = 'ask';
    const label = a.usd + ' for ' + a.endpoint;
    const heading = text('p', 'ask-title', 'Pay ' + label + '?');
    heading.id = 'ask-' + a.id;
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const [cls, name, approve] of [['approve', 'Approve', true], ['deny', 'Deny', false]]) {
      const button = text('button', cls, name);
      button.type = 'button';
      button.setAttribute('aria-describedby', heading.id);
      button.addEventListener('click', () => answer(a.id, approve));
      actions.append(button);
    }
    li.append(heading, text('p', 'detail', 'to ' + a.payTo + ' on ' + a.network + ' · ' + a.reasons.join(' · ')), text('p', 'countdown', ''), actions);
    asksEl.append(li);
    asks.set(a.id, { li, deadline: Date.now() + a.expiresIn, label });
    tick();
    // Announced, not shown: the card itself is the visible signal.
    document.getElementById('announce').textContent = 'Approval needed: ' + label;
    refresh();
  }

  async function answer(id, approve) {
    const ask = asks.get(id);
    if (!ask || ask.li.dataset.busy) return;
    ask.li.dataset.busy = '1';
    // aria-disabled, not disabled: a disabled button drops keyboard focus to the page body.
    const buttons = ask.li.querySelectorAll('button');
    buttons.forEach((b) => b.setAttribute('aria-disabled', 'true'));
    let error = null;
    try {
      const res = await fetch('/approvals/' + encodeURIComponent(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve }) });
      if (!res.ok) error = (await res.json().catch(() => ({}))).error ?? 'HTTP ' + res.status;
    } catch {
      error = 'the guard is not reachable';
    }
    if (error) {
      delete ask.li.dataset.busy;
      buttons.forEach((b) => b.removeAttribute('aria-disabled'));
      return say('Could not ' + (approve ? 'approve' : 'deny') + ' ' + ask.label + ': ' + error);
    }
    removeAsk(id, (approve ? 'Approved ' : 'Denied ') + ask.label);
  }

  function removeAsk(id, message) {
    const ask = asks.get(id);
    if (!ask) return;
    const hadFocus = ask.li.contains(document.activeElement);
    ask.li.remove();
    asks.delete(id);
    say(message);
    refresh();
    // Keep keyboard users in place: on to the next payment waiting, else back to the feed.
    if (hadFocus) (asksEl.querySelector('.approve') ?? document.getElementById('feed-title')).focus();
  }

  function refresh() {
    document.getElementById('approvals').hidden = asks.size === 0;
    document.title = (asks.size ? '(' + asks.size + ') ' : '') + title;
  }

  function tick() {
    for (const ask of asks.values()) ask.li.querySelector('.countdown').textContent = 'Declines in ' + clock(Math.max(0, ask.deadline - Date.now())) + ' without an answer';
  }

  function say(message) { notice.textContent = message; }

  const events = new EventSource('/events');
  let opened = false;
  // After a reconnect the server sends the history again: start from a clean page.
  events.onopen = () => {
    if (opened) { feed.replaceChildren(); asksEl.replaceChildren(); asks.clear(); counts = { paid: 0, stopped: 0 }; refresh(); }
    opened = true;
  };
  events.onmessage = (event) => addEntry(JSON.parse(event.data));
  events.addEventListener('ask', (event) => addAsk(JSON.parse(event.data)));
  events.addEventListener('receipt', (event) => {
    const e = JSON.parse(event.data);
    for (const li of feed.children) if (li.dataset.id === e.id) li.querySelector('.detail').replaceWith(detailOf(e));
  });
  events.addEventListener('settled', (event) => {
    const s = JSON.parse(event.data);
    const ask = asks.get(s.id);
    if (ask) removeAsk(s.id, (s.by === 'cancelled' ? 'Withdrawn, the agent stopped waiting: ' : s.by !== 'human' ? 'No answer in time: declined ' : s.approved ? 'Approved ' : 'Denied ') + ask.label);
  });
  setInterval(tick, 1000);
</script>
</body>
</html>`;
}
