/**
 * Plays someone who stole the agent's key: it signs with NEAR_GUARD_AGENT_KEY alone and goes
 * straight to the chain, past the off-chain guard, the paywall and the person on the dashboard.
 * Each attempt shows what the guard contract, or NEAR itself, does with it.
 *
 *   node scripts/near-guard-stolen-key.js
 *
 * On chain (each one a transaction you can open on NearBlocks):
 *   - pay the look-alike rnaps. account                → refused by the contract: not on the allowlist
 *   - pay an allowed account more than the per-payment cap → refused by the contract
 *   - pay allowed accounts until the day's cap is used, then once more → the last one refused
 * Rejected by NEAR before they become transactions (a function-call key can't sign them):
 *   - a plain transfer to rnaps.
 *   - withdraw() from the guard
 *   - pay() with a deposit attached
 *   - adding a full-access key to the guard account
 *
 * The third case spends real testnet NEAR: a stolen key can still pay the allowed accounts, up to
 * the day's cap. That is the limit this demo shows. Testnet only.
 */
import { Account, actions, JsonRpcProvider, KeyPair } from 'near-api-js';
import { contractError, formatNear, GUARD_PAY_GAS, NEAR_RPC } from '../src/rails/near.js';

process.loadEnvFile('.env');
const { NEAR_GUARD_ID: guardId, NEAR_GUARD_AGENT_KEY: stolenKey, PAYEE_WEATHER: allowed, PAYEE_THIEF: thief } = process.env;
if (!guardId || !stolenKey) throw new Error('no NEAR_GUARD_ID / NEAR_GUARD_AGENT_KEY in .env; run scripts/near-guard-deploy.js');
if (!guardId.endsWith('.testnet')) throw new Error(`testnet only: ${guardId}`);

const provider = new JsonRpcProvider({ url: NEAR_RPC['near-testnet'] });
const attacker = new Account(guardId, provider, stolenKey);
const link = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
const refused = [];

console.log(`signing as ${guardId} with the agent's function-call key ${KeyPair.fromString(stolenKey).getPublicKey()} only\n`);

/** Calls pay() on the guard; returns the transaction hash and the contract's refusal, if any. */
async function pay(receiver, amount) {
  const outcome = await attacker.signAndSendTransaction({
    receiverId: guardId,
    actions: [actions.functionCall('pay', { receiver, amount: amount.toString() }, GUARD_PAY_GAS, 0n)],
    throwOnFailure: false,
  });
  const failure = outcome.status?.Failure;
  return { hash: outcome.transaction.hash, error: failure && contractError(failure) };
}

async function onChain(what, receiver, amount) {
  const { hash, error } = await pay(receiver, amount);
  if (error) {
    console.log(`✗ refused on chain: ${what}\n    ${error}\n    ${link(hash)}`);
    refused.push({ hash, signer: guardId, reason: error });
  } else {
    console.log(`✓ paid on chain: ${what}\n    ${link(hash)}`);
  }
  return !error;
}

/** Sends a transaction NEAR should reject outright, and prints why it did. */
async function invalid(what, acts, receiverId = guardId) {
  try {
    const outcome = await attacker.signAndSendTransaction({ receiverId, actions: acts, throwOnFailure: false });
    console.log(`! NOT REJECTED: ${what} ${link(outcome.transaction.hash)}`);
    process.exitCode = 1;
  } catch (err) {
    console.log(`✗ rejected by NEAR, no transaction: ${what}\n    ${err.type ?? err.name}: ${err.message.split('\n')[0]}`);
  }
}

const policy = await provider.callFunction({ contractId: guardId, method: 'get_policy', args: {} });
const cap = BigInt(policy.per_payment_cap);
console.log(`guard policy: ${formatNear(cap)} NEAR per payment, ${formatNear(BigInt(policy.daily_cap))} NEAR a day, ${formatNear(BigInt(policy.remaining_today))} NEAR left today\n`);

await onChain(`pay 0.01 NEAR to the look-alike ${thief}`, thief, 10n ** 22n);
await onChain(`pay ${allowed} 1 yoctoNEAR more than the per-payment cap`, allowed, cap + 1n);

// Use up what is left of today's cap with allowed payments, then try once more.
for (let left = BigInt(policy.remaining_today); left > 0n;) {
  const amount = left < cap ? left : cap;
  if (!(await onChain(`pay ${formatNear(amount)} NEAR to ${allowed}, within the caps`, allowed, amount))) break;
  left -= amount;
}
await onChain(`pay ${allowed} 0.001 NEAR more, after the day's cap is used`, allowed, 10n ** 21n);

await invalid(`a plain transfer of 0.01 NEAR to ${thief}`, [actions.transfer(10n ** 22n)], thief);
await invalid('withdraw(1 NEAR) from the guard', [actions.functionCall('withdraw', { amount: (10n ** 24n).toString() }, GUARD_PAY_GAS, 0n)]);
// 1 yoctoNEAR, so the rule that rejects it is the deposit rule, not the key's gas allowance.
await invalid('pay() with 1 yoctoNEAR attached', [actions.functionCall('pay', { receiver: allowed, amount: '1' }, GUARD_PAY_GAS, 1n)]);
await invalid('add a full-access key to the guard account', [actions.addFullAccessKey(KeyPair.fromRandom('ed25519').getPublicKey())]);

const after = await provider.callFunction({ contractId: guardId, method: 'get_policy', args: {} });
console.log(`\nguard now: spent today ${formatNear(BigInt(after.spent_today))} of ${formatNear(BigInt(after.daily_cap))} NEAR; ${thief} was never paid`);
console.log('\nfor docs/near-testnet-run.md ("refused"):');
console.log(JSON.stringify(refused.map(({ hash, signer, reason }) => ({ hash, signer, reason })), null, 2));
