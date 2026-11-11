/**
 * Sets up an agent on the NEAR Intents Agent API, on Tidepool's community testnet
 * (https://www.usetidepool.tech, not run by NEAR), for `node demo/agent.js --intents`:
 *
 *   node scripts/intents-agent-setup.js [--base=https://www.usetidepool.tech]
 *
 * It:
 *   1. gets a free partner API key (POST /v1/keys: no sign-up, testnet only);
 *   2. makes a throwaway owner: a fresh ed25519 key, i.e. an implicit NEAR account (nothing is
 *      created on chain; Tidepool checks the owner's signatures off-chain);
 *   3. creates the agent with an owner-signed policy (NEP-413): transfers of test USDC only, only
 *      to the four honest demo payees (not rnaps.), at most $0.50 per transfer and $1.00 a day;
 *   4. issues the agent a grant token, valid until 1 Dec 2026;
 *   5. appends INTENTS_* to .env and prints the agent wallet's account, which you fund with test
 *      USDC on Tidepool's faucet (the faucet takes requests from its web page only).
 *
 * Needs PAYEE_WEATHER, PAYEE_NEWS, PAYEE_QUOTES, PAYEE_MAPS and PAYEE_THIEF in .env (from
 * near-demo-payees.js). The owner key stays in .env and is never given to the agent: the demo
 * and the MCP server read only INTENTS_API_KEY, INTENTS_AGENT_ID, INTENTS_GRANT_TOKEN and
 * INTENTS_AGENT_ACCOUNT.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { baseDecode, KeyPair } from 'near-api-js';
import { agentApi, nep413Hash, TIDEPOOL_URL, TIDEPOOL_USDC } from '../src/rails/intents.js';

const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? TIDEPOOL_URL;
if (!existsSync('.env')) throw new Error('no .env; run near-testnet-account.js and near-demo-payees.js first');
process.loadEnvFile('.env');
const env = process.env;
for (const name of ['PAYEE_WEATHER', 'PAYEE_NEWS', 'PAYEE_QUOTES', 'PAYEE_MAPS', 'PAYEE_THIEF']) {
  if (!env[name]) throw new Error(`${name} is not in .env; run near-demo-payees.js first`);
}
if (env.INTENTS_AGENT_ID) {
  console.error(`.env already has an Agent API agent (${env.INTENTS_AGENT_ID})`);
  process.exit(1);
}

const { api_key: apiKey } = await agentApi({ baseUrl: base })('POST', '/keys', { body: { name: 'spend-guard-demo' } });
const api = agentApi({ baseUrl: base, apiKey });
console.log(`API key: issued (${apiKey.slice(0, 8)}…), written to .env`);

const network = await api('GET', '/network');
if (!/testnet/i.test(JSON.stringify(network))) throw new Error(`testnet only, but ${base}/v1/network says ${JSON.stringify(network)}`);
console.log(`network: ${JSON.stringify(network)}`);

const tokens = (await api('GET', '/tokens')).data ?? [];
const usdc = tokens.find((t) => t.asset_id === TIDEPOOL_USDC);
if (!usdc) throw new Error(`${TIDEPOOL_USDC} is not in ${base}/v1/tokens`);
if (usdc.decimals !== undefined && usdc.decimals !== 6) throw new Error(`expected 6 decimals for ${TIDEPOOL_USDC}, got ${usdc.decimals}`);

// The owner: an implicit account is the hex of its ed25519 public key.
const ownerKey = KeyPair.fromRandom('ed25519');
const ownerPublic = ownerKey.getPublicKey().toString();
const owner = { type: 'near', account_id: Buffer.from(baseDecode(ownerPublic.slice('ed25519:'.length))).toString('hex'), public_key: ownerPublic };

/** generate-intent, sign the payload with the owner key (NEP-413), submit, wait for the outcome. */
async function ownerIntent(type, body) {
  const gen = await api('POST', '/generate-intent', { body: { type, ...body }, idem: `spend-guard-${randomUUID()}` });
  const payload = gen.intent.payload;
  const signature = Buffer.from(ownerKey.sign(nep413Hash(payload)).signature).toString('base64');
  await api('POST', '/submit-intent', { body: { type, correlation_id: gen.correlation_id, signed_data: { standard: 'nep413', payload, public_key: ownerPublic, signature } } });
  const status = await api('GET', `/status?correlation_id=${encodeURIComponent(gen.correlation_id)}&wait_ms=20000`);
  if (status.status !== 'SUCCESS') throw new Error(`${type}: ${status.status} ${status.failure_code ?? ''}`);
  return status;
}

const payees = [env.PAYEE_WEATHER, env.PAYEE_NEWS, env.PAYEE_QUOTES, env.PAYEE_MAPS];
const policy = {
  frozen: false,
  actions: ['transfer'],
  confidential: false,
  owner_approval: false,
  assets: [TIDEPOOL_USDC],
  limits: { per_transaction: { [TIDEPOOL_USDC]: '500000' }, daily: { [TIDEPOOL_USDC]: '1000000' } },
  max_actions_per_hour: 60,
  destinations: { mode: 'only', list: payees.map((address) => ({ action: 'transfer', address, confidential: false })) },
  budget: { daily_usd: '1', weekly_usd: null, monthly_usd: null },
  timelock_ms: 0,
};

const created = await ownerIntent('agent_create', { name: 'spend-guard demo agent', owner, policy });
const agentId = created.agent_id ?? created.details?.agent_id;
if (!agentId) throw new Error(`agent_create returned no agent id: ${JSON.stringify(created).slice(0, 300)}`);

const grantToken = `ngt_${randomBytes(32).toString('base64url')}`;
await ownerIntent('grant_issue', { agent_id: agentId, label: 'spend-guard demo', credential: createHash('sha256').update(grantToken).digest('hex'), expires_at: '2026-12-01T00:00:00.000Z' });

const wallet = await api('GET', `/agents/${agentId}/wallet`);
const agentAccount = wallet.near_account_id ?? wallet.account_id ?? wallet.address;
if (!agentAccount) throw new Error(`no account in GET /v1/agents/${agentId}/wallet: ${JSON.stringify(wallet).slice(0, 300)}`);

appendFileSync('.env', [
  `INTENTS_API_URL=${base}`,
  `INTENTS_API_KEY=${apiKey}`,
  `INTENTS_AGENT_ID=${agentId}`,
  `INTENTS_AGENT_ACCOUNT=${agentAccount}`,
  `INTENTS_GRANT_TOKEN=${grantToken}`,
  `INTENTS_OWNER_KEY=${ownerKey.toString()}`,
  '',
].join('\n'));

console.log(`owner ${owner.account_id} (throwaway implicit account; its key is in .env as INTENTS_OWNER_KEY)`);
console.log(`agent ${agentId}, wallet ${agentAccount}`);
console.log(`policy: transfer ${TIDEPOOL_USDC} only, to ${payees.join(', ')}; at most $0.50 per transfer and $1.00 a day`);
console.log(`grant: issued, valid until 2026-12-01, written to .env`);
console.log(`\nFund the wallet: open https://app.usetidepool.tech/faucet, Tokens tab, NEAR, mode "intents", paste ${agentAccount} and claim.`);
