/**
 * Funds the Agent API agent (from intents-agent-setup.js) from your own NEAR testnet account, for
 * when Tidepool's faucet can't drip to the agent wallet directly (it only drips to accounts that
 * exist on chain and are at least 24 hours old; the agent wallet is an implicit account).
 *
 *   node scripts/intents-agent-fund.js                  # verifier balances of your account and the agent
 *   node scripts/intents-agent-fund.js --usdc=5         # move 5 test USDC from your account to the agent
 *   node scripts/intents-agent-fund.js --create         # send 0.1 testnet NEAR to the agent's implicit
 *                                                       # account, so it exists on chain
 *
 * --usdc is a NEP-245 mt_transfer call on Tidepool's Intents verifier, signed by NEAR_ACCOUNT_ID
 * with 1 yoctoNEAR attached: test USDC you claimed on the faucet in "intents" mode moves inside the
 * verifier to the agent's account. Testnet only.
 */
import { Account, actions, JsonRpcProvider, nearToYocto } from 'near-api-js';
import { formatUsd } from '../src/money.js';
import { NEAR_RPC } from '../src/rails/near.js';
import { TIDEPOOL_USDC, TIDEPOOL_VERIFIER } from '../src/rails/intents.js';

process.loadEnvFile('.env');
const { NEAR_ACCOUNT_ID: owner, NEAR_PRIVATE_KEY, INTENTS_AGENT_ACCOUNT: agent } = process.env;
if (!owner?.endsWith('.testnet')) throw new Error(`testnet only: ${owner}`);
if (!agent) throw new Error('no INTENTS_AGENT_ACCOUNT in .env; run scripts/intents-agent-setup.js');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const provider = new JsonRpcProvider({ url: NEAR_RPC['near-testnet'] });
const account = new Account(owner, provider, NEAR_PRIVATE_KEY);
const link = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;

/** Test USDC (6 decimals) an account holds inside the verifier. */
async function usdc(accountId) {
  return BigInt(await provider.callFunction({ contractId: TIDEPOOL_VERIFIER, method: 'mt_balance_of', args: { account_id: accountId, token_id: TIDEPOOL_USDC } }));
}

if (process.argv.includes('--create')) {
  const exists = await provider.viewAccount({ accountId: agent }).then(() => true, () => false);
  if (exists) {
    console.log(`${agent} already exists on chain`);
  } else {
    const outcome = await account.signAndSendTransaction({ receiverId: agent, actions: [actions.transfer(nearToYocto('0.1'))] });
    console.log(`sent 0.1 testnet NEAR to ${agent}, which now exists on chain ${link(outcome.transaction.hash)}`);
  }
}

const amount = arg('usdc');
if (amount) {
  const atomic = BigInt(Math.round(Number(amount) * 1e6));
  const have = await usdc(owner);
  if (have < atomic) throw new Error(`${owner} holds ${formatUsd(have)} test USDC in the verifier, less than ${formatUsd(atomic)}; claim it on https://app.usetidepool.tech/faucet (NEAR, mode intents)`);
  const outcome = await account.signAndSendTransaction({
    receiverId: TIDEPOOL_VERIFIER,
    actions: [actions.functionCall('mt_transfer', { receiver_id: agent, token_id: TIDEPOOL_USDC, amount: atomic.toString(), memo: 'spend-guard demo agent' }, 30_000_000_000_000n, 1n)],
  });
  console.log(`moved ${formatUsd(atomic)} test USDC inside the verifier from ${owner} to ${agent} ${link(outcome.transaction.hash)}`);
}

console.log(`verifier balances of ${TIDEPOOL_USDC}: ${owner} ${formatUsd(await usdc(owner))}, agent ${agent.slice(0, 8)}… ${formatUsd(await usdc(agent))}`);
