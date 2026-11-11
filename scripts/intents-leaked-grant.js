/**
 * Plays someone who stole what the agent holds for the NEAR Intents Agent API: its partner API key
 * and its grant token. It calls the Agent API (Tidepool's community testnet) directly, past Spend
 * Guard, the paywall and the dashboard, and shows what the owner's signed policy still refuses.
 *
 *   node scripts/intents-leaked-grant.js
 *
 * Refused by the Agent API's policy, before anything moves (no transaction):
 *   - transfer to the look-alike rnaps. account          → not one of the policy's destinations
 *   - transfer $0.51 to an allowed payee                 → over the per-transaction limit
 *   - withdraw to rnaps., or swap                        → actions the policy doesn't allow
 *   - change the policy, signed with the thief's own key → only the owner's key can
 * Still allowed, and the limit this demo shows: a transfer to an allowed payee within the policy's
 * limits ($0.01 here). The policy's daily limit ($1.00) bounds how much of that a thief can do.
 *
 * Reads only INTENTS_API_URL, INTENTS_API_KEY, INTENTS_AGENT_ID and INTENTS_GRANT_TOKEN, never
 * INTENTS_OWNER_KEY. Testnet only: test USDC has no value.
 */
import { randomUUID } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { agentApi, AgentApiError, nep413Hash, TIDEPOOL_URL, TIDEPOOL_USDC } from '../src/rails/intents.js';

process.loadEnvFile('.env');
const { INTENTS_API_URL, INTENTS_API_KEY, INTENTS_AGENT_ID: agent, INTENTS_GRANT_TOKEN: grant, PAYEE_WEATHER: allowed, PAYEE_THIEF: thief } = process.env;
delete process.env.INTENTS_OWNER_KEY;
if (!agent || !grant || !INTENTS_API_KEY) throw new Error('no INTENTS_* in .env; run scripts/intents-agent-setup.js');
const api = agentApi({ baseUrl: INTENTS_API_URL ?? TIDEPOOL_URL, apiKey: INTENTS_API_KEY });
const link = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
const refusals = [];

console.log(`calling the NEAR Intents Agent API at ${INTENTS_API_URL ?? TIDEPOOL_URL} as agent ${agent}, with its API key and grant only\n`);

/** An agent action the policy should refuse; prints the API's code. */
async function refused(what, kind, body) {
  try {
    const accepted = await api('POST', `/agents/${agent}/${kind}`, { body, grant, idem: `leak-${randomUUID()}` });
    const status = await api('GET', `/status?correlation_id=${encodeURIComponent(accepted.correlation_id)}&wait_ms=20000`);
    if (status.status === 'SUCCESS') {
      console.log(`! NOT REFUSED: ${what} ${status.details?.tx_hash ? link(status.details.tx_hash) : ''}`);
      process.exitCode = 1;
    } else {
      console.log(`✗ refused by the Agent API: ${what}\n    ${status.status} ${status.failure_code ?? ''}`);
      refusals.push({ what, code: status.failure_code ?? status.status });
    }
  } catch (err) {
    if (!(err instanceof AgentApiError)) throw err;
    console.log(`✗ refused by the Agent API, nothing moved: ${what}\n    HTTP ${err.status} ${err.layer ?? ''} ${err.message}`);
    refusals.push({ what, code: err.code ?? `HTTP ${err.status}` });
  }
}

const tokens = (await api('GET', '/tokens')).data ?? [];
const other = tokens.find((t) => t.blockchain === 'near' && t.asset_id !== TIDEPOOL_USDC);

await refused(`transfer $0.01 to the look-alike ${thief}`, 'transfer', { asset: TIDEPOOL_USDC, amount: '10000', recipient: thief });
await refused(`transfer $0.51 to ${allowed}, over the per-transaction limit`, 'transfer', { asset: TIDEPOOL_USDC, amount: '510000', recipient: allowed });
await refused(`withdraw $0.01 to ${thief} on NEAR`, 'withdraw', { asset: TIDEPOOL_USDC, amount: '10000', chain: 'near', recipient: thief });
if (other) await refused(`swap $0.01 of USDC for ${other.symbol}`, 'swap', { origin_asset: TIDEPOOL_USDC, destination_asset: other.asset_id, amount: '10000' });

// An owner intent signed with the thief's own key: the API checks it against the agent's owner.
const thiefKey = KeyPair.fromRandom('ed25519');
try {
  const current = await api('GET', `/agents/${agent}/policy`);
  const policy = { ...current.policy, destinations: { mode: 'any', list: [] } };
  const gen = await api('POST', '/generate-intent', { body: { type: 'policy_update', agent_id: agent, expected_revision: current.revision, policy }, idem: `leak-${randomUUID()}` });
  const payload = gen.intent.payload;
  const signature = Buffer.from(thiefKey.sign(nep413Hash(payload)).signature).toString('base64');
  await api('POST', '/submit-intent', { body: { type: 'policy_update', correlation_id: gen.correlation_id, signed_data: { standard: 'nep413', payload, public_key: thiefKey.getPublicKey().toString(), signature } } });
  const status = await api('GET', `/status?correlation_id=${encodeURIComponent(gen.correlation_id)}&wait_ms=20000`);
  if (status.status === 'SUCCESS') {
    console.log('! NOT REFUSED: a policy update signed by a key that is not the owner\'s');
    process.exitCode = 1;
  } else {
    console.log(`✗ refused by the Agent API: open the destinations to any account, signed with the thief's own key\n    ${status.status} ${status.failure_code ?? ''}`);
    refusals.push({ what: 'policy_update signed by another key', code: status.failure_code ?? status.status });
  }
} catch (err) {
  if (!(err instanceof AgentApiError)) throw err;
  console.log(`✗ refused by the Agent API: open the destinations to any account, signed with the thief's own key\n    HTTP ${err.status} ${err.layer ?? ''} ${err.message}`);
  refusals.push({ what: 'policy_update signed by another key', code: err.code ?? `HTTP ${err.status}` });
}

// What the stolen key and grant can still do: pay an allowed payee within the limits.
try {
  const accepted = await api('POST', `/agents/${agent}/transfer`, { body: { asset: TIDEPOOL_USDC, amount: '10000', recipient: allowed }, grant, idem: `leak-${randomUUID()}` });
  const status = await api('GET', `/status?correlation_id=${encodeURIComponent(accepted.correlation_id)}&wait_ms=30000`);
  console.log(`${status.status === 'SUCCESS' ? '✓ still allowed' : `? ${status.status}`}: transfer $0.01 to ${allowed}, within the policy${status.details?.tx_hash ? `\n    ${link(status.details.tx_hash)}` : ''}`);
} catch (err) {
  if (!(err instanceof AgentApiError)) throw err;
  console.log(`? transfer $0.01 to ${allowed} did not go through: HTTP ${err.status} ${err.message}`);
}

const usage = (await api('GET', `/agents/${agent}/policy`)).usage?.budget?.daily;
if (usage) console.log(`\npolicy budget today: $${usage.spent_usd} of $${usage.limit_usd} spent; ${thief} was never paid`);
console.log('\nrefusals:', JSON.stringify(refusals));
