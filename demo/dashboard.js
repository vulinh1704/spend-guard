/**
 * A live page of the guard's decisions: the budget, what was paid (with the transaction) and
 * what was stopped (with every reason). Entries arrive over server-sent events, so the page
 * updates while the agent runs; a page opened late is sent the history first.
 */
import http from 'node:http';
import { formatUsd, usdToMicro } from '../src/money.js';

/**
 * @param {import('../src/guard.js').Guard} guard
 * @param {{title?: string, account?: string, explorer?: (txid: string) => string}} [options]
 * @returns {http.Server}
 */
export function createDashboard(guard, { title = 'Spend Guard', account = '', explorer } = {}) {
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();
  const view = (entry) => ({
    at: entry.at,
    status: entry.status,
    usd: formatUsd(entry.usd),
    endpoint: new URL(entry.intent.resource).pathname,
    payTo: entry.intent.payTo,
    reasons: entry.reasons.map((r) => r.message),
    tx: entry.receipt?.txid ?? null,
    txUrl: entry.receipt?.txid && explorer ? explorer(entry.receipt.txid) : null,
    spent: formatUsd(guard.ledger.spentToday(entry.at)),
    spentRatio: Number((guard.ledger.spentToday(entry.at) * 1000n) / usdToMicro(guard.policy.dailyUsd)) / 1000,
  });

  guard.on('entry', (entry) => {
    const data = `data: ${JSON.stringify(view(entry))}\n\n`;
    for (const res of clients) res.write(data);
  });

  return http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const entry of guard.ledger.entries) res.write(`data: ${JSON.stringify(view(entry))}\n\n`);
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
    --ok: #0f7b53; --ok-bg: #e3f4ec; --stop: #b42318; --stop-bg: #fdeceb; --ask: #8a5a00; --ask-bg: #fdf3dc;
    --meter: #2f5bea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --card: #171a21; --text: #eef0f4; --muted: #a2a9b6; --line: #2a2f3a;
      --ok: #4ad295; --ok-bg: #12291f; --stop: #ff7b6e; --stop-bg: #2d1514; --ask: #f2c260; --ask-bg: #2b2210;
      --meter: #7c9cff;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; }
  h1 { font-size: 22px; margin: 0; }
  .account { color: var(--muted); font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 20px 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; min-width: 0; }
  .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .value { font-size: 24px; font-weight: 650; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .meter { height: 8px; border-radius: 4px; background: var(--line); margin-top: 10px; overflow: hidden; }
  .meter > div { height: 100%; width: 0; background: var(--meter); transition: width .4s ease; }
  .rules { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { background: var(--card); border: 1px solid var(--line); border-left-width: 4px; border-radius: 10px; padding: 10px 14px; display: grid; grid-template-columns: auto 1fr auto; gap: 4px 12px; align-items: baseline; animation: in .35s ease; min-width: 0; }
  li.paid { border-left-color: var(--ok); }
  li.denied, li.declined, li.failed { border-left-color: var(--stop); }
  .pill { font-size: 12px; font-weight: 650; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .paid .pill { color: var(--ok); background: var(--ok-bg); }
  .denied .pill, .declined .pill, .failed .pill { color: var(--stop); background: var(--stop-bg); }
  .endpoint { font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 0; overflow-wrap: anywhere; }
  .amount { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
  .detail { grid-column: 2 / -1; color: var(--muted); font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
  .denied .detail, .declined .detail { color: var(--stop); }
  .detail a { color: inherit; }
  .empty { color: var(--muted); text-align: center; padding: 32px 0; }
  @keyframes in { from { opacity: 0; transform: translateY(-6px); } }
  @media (prefers-reduced-motion: reduce) { li { animation: none; } .meter > div { transition: none; } }
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
  <ol id="feed" aria-live="polite"><li class="empty" style="display:block;border:0;background:none">Waiting for the agent's first payment…</li></ol>
</main>
<script>
  const feed = document.getElementById('feed');
  const counts = { paid: 0, stopped: 0 };
  const LABEL = { paid: 'Paid', denied: 'Stopped', declined: 'Declined', failed: 'Failed' };
  const text = (tag, cls, value) => { const el = document.createElement(tag); el.className = cls; el.textContent = value; return el; };
  new EventSource('/events').onmessage = (event) => {
    const e = JSON.parse(event.data);
    feed.querySelector('.empty')?.remove();
    const li = document.createElement('li');
    li.className = e.status;
    li.append(text('span', 'pill', LABEL[e.status] ?? e.status), text('span', 'endpoint', e.endpoint), text('span', 'amount', e.usd));
    const detail = document.createElement('div');
    detail.className = 'detail';
    if (e.status === 'paid') {
      detail.append('to ' + e.payTo + (e.tx ? ' · ' : ''));
      if (e.txUrl) { const a = document.createElement('a'); a.href = e.txUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = e.tx.slice(0, 10) + '…'; detail.append(a); }
    } else {
      detail.textContent = e.reasons.join(' · ');
    }
    li.append(detail);
    feed.prepend(li);
    if (e.status === 'paid') counts.paid++; else counts.stopped++;
    document.getElementById('paid').textContent = counts.paid;
    document.getElementById('stopped').textContent = counts.stopped;
    document.getElementById('spent').textContent = e.spent;
    const pct = Math.min(100, Math.round(e.spentRatio * 100));
    const meter = document.getElementById('meter');
    meter.firstElementChild.style.width = pct + '%';
    meter.setAttribute('aria-valuenow', pct);
  };
</script>
</body>
</html>`;
}
