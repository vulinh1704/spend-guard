/**
 * Read-only look at the Agent API agent in .env (from intents-agent-setup.js): its wallet, its
 * owner-signed policy and its balances, as the API reports them.
 *
 *   node scripts/intents-agent-status.js
 */
import { agentApi, TIDEPOOL_URL } from '../src/rails/intents.js';

process.loadEnvFile('.env');
const { INTENTS_API_URL, INTENTS_API_KEY, INTENTS_AGENT_ID } = process.env;
if (!INTENTS_AGENT_ID) throw new Error('no INTENTS_AGENT_ID in .env; run scripts/intents-agent-setup.js');
const api = agentApi({ baseUrl: INTENTS_API_URL ?? TIDEPOOL_URL, apiKey: INTENTS_API_KEY });

const wallet = await api('GET', `/agents/${INTENTS_AGENT_ID}/wallet`);
const policy = await api('GET', `/agents/${INTENTS_AGENT_ID}/policy`);
const balances = await api('GET', `/agents/${INTENTS_AGENT_ID}/balances`);
console.log(JSON.stringify({ wallet, policy, balances }, null, 2));
