/**
 * Read-only look at the Agent API agent in .env (from intents-agent-setup.js): its wallet, its
 * owner-signed policy and its balances as the API reports them, and the tokens that the agent and
 * your own account (NEAR_ACCOUNT_ID) hold inside the Intents verifier, read from NEAR RPC.
 *
 *   node scripts/intents-agent-status.js
 */
import { JsonRpcProvider } from 'near-api-js';
import { agentApi, TIDEPOOL_URL, TIDEPOOL_USDC, TIDEPOOL_VERIFIER } from '../src/rails/intents.js';
import { NEAR_RPC } from '../src/rails/near.js';

process.loadEnvFile('.env');
const { INTENTS_API_URL, INTENTS_API_KEY, INTENTS_AGENT_ID, INTENTS_AGENT_ACCOUNT, NEAR_ACCOUNT_ID } = process.env;
if (!INTENTS_AGENT_ID) throw new Error('no INTENTS_AGENT_ID in .env; run scripts/intents-agent-setup.js');
const api = agentApi({ baseUrl: INTENTS_API_URL ?? TIDEPOOL_URL, apiKey: INTENTS_API_KEY });
const provider = new JsonRpcProvider({ url: NEAR_RPC['near-testnet'] });

const wallet = await api('GET', `/agents/${INTENTS_AGENT_ID}/wallet`);
const policy = await api('GET', `/agents/${INTENTS_AGENT_ID}/policy`);
const balances = await api('GET', `/agents/${INTENTS_AGENT_ID}/balances`);

// What the verifier contract itself says, for every token each account holds there.
const accounts = {};
for (const account of [INTENTS_AGENT_ACCOUNT, NEAR_ACCOUNT_ID].filter(Boolean)) {
  try {
    const tokens = await provider.callFunction({ contractId: TIDEPOOL_VERIFIER, method: 'mt_tokens_for_owner', args: { account_id: account } });
    const ids = tokens.map((t) => t.token_id);
    const amounts = ids.length ? await provider.callFunction({ contractId: TIDEPOOL_VERIFIER, method: 'mt_batch_balance_of', args: { account_id: account, token_ids: ids } }) : [];
    accounts[account] = Object.fromEntries(ids.map((id, i) => [id, amounts[i]]));
  } catch (err) {
    accounts[account] = { error: err.message };
  }
}
console.log(JSON.stringify({ wallet, policy, balances, verifier: { contract: TIDEPOOL_VERIFIER, usdc: TIDEPOOL_USDC, accounts } }, null, 2));
