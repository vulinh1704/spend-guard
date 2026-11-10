/**
 * Checks a recorded NEAR testnet run against the chain, with no key and no account: read-only
 * RPC calls to a public archival node. The run is the `json near-verify` block in
 * docs/near-testnet-run.md (or the file given).
 *
 *   node scripts/near-verify.js [docs/near-testnet-run.md]
 *
 * What it checks, for each entry in the block:
 *   payments  the transaction paid `payTo` at least `amount` yoctoNEAR, read from its receipts with
 *             the check the demo paywall runs (nearPaymentProblem in src/rails/near.js)
 *   refused   the transaction failed, and the guard contract's error contains `reason`
 *   balances  the account holds exactly `amount` yoctoNEAR now
 *   guard     the contract's code is the committed wasm (same sha256), its get_policy matches, and
 *             the agent's key on it may only call pay()
 *
 * Prints one line per check and exits with 1 if any check fails. NEAR_RPC_URL picks another RPC.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { baseEncode } from 'near-api-js';
import { contractError, formatNear, NEAR_ARCHIVAL_RPC, nearPaymentProblem } from '../src/rails/near.js';

const file = process.argv[2] ?? 'docs/near-testnet-run.md';
const block = /```json near-verify\n([\s\S]*?)\n```/.exec(readFileSync(file, 'utf8'));
if (!block) {
  console.error(`no \`\`\`json near-verify block in ${file}`);
  process.exit(2);
}
const run = JSON.parse(block[1]);
if (run.network !== 'near-testnet') {
  console.error(`this script checks NEAR testnet runs only, not ${run.network}`);
  process.exit(2);
}
const urls = process.env.NEAR_RPC_URL ? [process.env.NEAR_RPC_URL] : NEAR_ARCHIVAL_RPC[run.network];
const explorer = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;

let failed = 0;
const pass = (line) => console.log(`✓ ${line}`);
const fail = (line) => {
  failed++;
  console.log(`✗ ${line}`);
};

/**
 * One JSON-RPC call, trying each archival node in turn when one is down or busy, and the whole
 * list again after a pause. Public nodes rate-limit, so calls are also spaced out a little.
 */
async function rpc(method, params) {
  let last;
  for (let round = 0; round < 3; round++) {
    if (round) await sleep(3000 * round);
    for (const url of urls) {
      await sleep(250);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'near-verify', method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        const body = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        if (!body.error) return body.result;
        const message = body.error.data ?? body.error.message;
        const cause = body.error.cause?.name ?? body.error.name;
        // A busy or failing node: another one, or the same one later, may answer.
        if (res.status === 429 || res.status >= 500 || !cause || /rate limit|timeout|unavailable/i.test(String(message))) {
          last = new Error(`${url}: ${message}`);
          continue;
        }
        // The node answered about the request itself (an unknown transaction, say): another
        // node would say the same.
        throw Object.assign(new Error(`${cause}: ${message}`), { answered: true });
      } catch (err) {
        if (err.answered) throw err;
        last = err;
      }
    }
  }
  throw new Error(`no RPC answered (${urls.join(', ')}): ${last?.message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const txStatus = (hash, signer) => rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: signer, wait_until: 'NONE' });
const viewAccount = (account) => rpc('query', { request_type: 'view_account', finality: 'final', account_id: account });

console.log(`checking ${file} against ${run.network} (${urls[0]})\n`);

for (const p of run.payments ?? []) {
  try {
    const problem = nearPaymentProblem(await txStatus(p.hash, p.signer), { txid: p.hash, sender: p.signer }, { payTo: p.payTo, amount: BigInt(p.amount) });
    if (problem) fail(`${problem} ${explorer(p.hash)}`);
    else pass(`${p.signer} paid ${formatNear(BigInt(p.amount))} NEAR to ${p.payTo} ${explorer(p.hash)}`);
  } catch (err) {
    fail(`${p.hash}: ${err.message}`);
  }
}

for (const r of run.refused ?? []) {
  try {
    const outcome = await txStatus(r.hash, r.signer);
    const failure = outcome.status?.Failure;
    if (!failure) fail(`${r.hash} succeeded, but this page says the guard refused it ${explorer(r.hash)}`);
    else if (!contractError(failure).includes(r.reason)) fail(`${r.hash} failed with "${contractError(failure)}", not "${r.reason}" ${explorer(r.hash)}`);
    else pass(`refused on chain: "${contractError(failure)}" ${explorer(r.hash)}`);
  } catch (err) {
    fail(`${r.hash}: ${err.message}`);
  }
}

for (const b of run.balances ?? []) {
  try {
    const { amount } = await viewAccount(b.account);
    if (BigInt(amount) === BigInt(b.amount)) pass(`${b.account} holds ${formatNear(BigInt(amount))} NEAR: ${b.why}`);
    else fail(`${b.account} holds ${formatNear(BigInt(amount))} NEAR, not ${formatNear(BigInt(b.amount))}; its history is at https://testnet.nearblocks.io/address/${b.account}`);
  } catch (err) {
    fail(`${b.account}: ${err.message}`);
  }
}

if (run.guard) await checkGuard(run.guard);

console.log(failed ? `\n${failed} check(s) failed` : '\nevery check passed');
process.exit(failed ? 1 : 0);

/**
 * @param {{contract: string, wasm: string, agentKey: string, allowed?: string[], notAllowed?: string[], perPaymentCap?: string, dailyCap?: string}} g
 */
async function checkGuard(g) {
  try {
    const { code_hash: onChain } = await viewAccount(g.contract);
    const local = baseEncode(createHash('sha256').update(readFileSync(g.wasm)).digest());
    if (onChain === local) pass(`${g.contract} runs ${g.wasm} (sha256 ${local})`);
    else fail(`${g.contract} runs code ${onChain}, but ${g.wasm} hashes to ${local}`);
  } catch (err) {
    fail(`${g.contract} code: ${err.message}`);
  }

  try {
    const res = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: g.contract, method_name: 'get_policy', args_base64: '' });
    const policy = JSON.parse(Buffer.from(res.result).toString('utf8'));
    const allowlist = new Set(policy.allowlist);
    for (const a of g.allowed ?? []) (allowlist.has(a) ? pass : fail)(`${a} is ${allowlist.has(a) ? '' : 'not '}on the guard's allowlist`);
    for (const a of g.notAllowed ?? []) (allowlist.has(a) ? fail : pass)(`${a} is ${allowlist.has(a) ? '' : 'not '}on the guard's allowlist`);
    if (g.perPaymentCap) (policy.per_payment_cap === g.perPaymentCap ? pass : fail)(`per-payment cap ${formatNear(BigInt(policy.per_payment_cap))} NEAR`);
    if (g.dailyCap) (policy.daily_cap === g.dailyCap ? pass : fail)(`daily cap ${formatNear(BigInt(policy.daily_cap))} NEAR`);
    console.log(`  get_policy: spent today ${formatNear(BigInt(policy.spent_today))} NEAR, paused ${policy.paused}, owner ${policy.owner}`);
  } catch (err) {
    fail(`${g.contract} get_policy: ${err.message}`);
  }

  try {
    const key = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: g.contract, public_key: g.agentKey });
    const fc = key.permission?.FunctionCall;
    const onlyPay = fc && fc.receiver_id === g.contract && fc.method_names.length === 1 && fc.method_names[0] === 'pay';
    if (onlyPay) pass(`the agent's key ${g.agentKey} may only call pay() on ${g.contract} (gas allowance ${fc.allowance ? `${formatNear(BigInt(fc.allowance))} NEAR left` : 'unlimited'})`);
    else fail(`the agent's key ${g.agentKey} on ${g.contract} is not limited to pay(): ${JSON.stringify(key.permission)}`);
  } catch (err) {
    fail(`the agent's key on ${g.contract}: ${err.message}`);
  }
}
