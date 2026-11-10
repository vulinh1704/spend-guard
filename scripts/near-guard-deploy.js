/**
 * Deploys the guard contract (contracts/near-guard) on NEAR testnet for the demo, with your demo
 * account as its owner, and gives the agent a function-call key that may only call pay().
 *
 *   node scripts/near-guard-deploy.js [--fund=2.5] [--per-payment=0.15] [--daily=0.25] [--allowance=0.25]
 *
 * Needs .env from near-testnet-account.js and near-demo-payees.js. It:
 *   1. creates guard.<your account>, funded with --fund testnet NEAR from your account (about 1.6
 *      of it pays for the storage of the 163 KB contract), with your account's key as its full-access key;
 *   2. in one transaction signed by the guard account: deploys the committed wasm, calls new() with
 *      you as owner, the four honest payees as the allowlist and the two caps, and adds the agent's
 *      function-call key (receiver the guard, method pay only, --allowance NEAR for gas);
 *   3. appends NEAR_GUARD_ID and NEAR_GUARD_AGENT_KEY to .env, and prints the contract's policy.
 *
 * Testnet only: it refuses any account that is not *.testnet.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { Account, actions, baseEncode, JsonRpcProvider, KeyPair, nearToYocto } from 'near-api-js';
import { formatNear, NEAR_RPC } from '../src/rails/near.js';

const WASM = 'contracts/near-guard/res/spend_guard_near.wasm';
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;

process.loadEnvFile('.env');
const env = process.env;
for (const name of ['NEAR_ACCOUNT_ID', 'NEAR_PRIVATE_KEY', 'PAYEE_WEATHER', 'PAYEE_NEWS', 'PAYEE_QUOTES', 'PAYEE_MAPS']) {
  if (!env[name]) throw new Error(`${name} is not in .env; run near-testnet-account.js and near-demo-payees.js first`);
}
if (env.NEAR_GUARD_ID) {
  console.error(`.env already has a guard (${env.NEAR_GUARD_ID})`);
  process.exit(1);
}
if (env.NEAR_NETWORK !== 'near-testnet' || !env.NEAR_ACCOUNT_ID.endsWith('.testnet')) {
  console.error(`testnet only: ${env.NEAR_ACCOUNT_ID} on ${env.NEAR_NETWORK}`);
  process.exit(1);
}

const owner = env.NEAR_ACCOUNT_ID;
const guardId = `guard.${owner}`;
const allowlist = [env.PAYEE_WEATHER, env.PAYEE_NEWS, env.PAYEE_QUOTES, env.PAYEE_MAPS];
const perPayment = nearToYocto(arg('per-payment', '0.15'));
const daily = nearToYocto(arg('daily', '0.25'));
const wasm = readFileSync(WASM);
const codeHash = baseEncode(createHash('sha256').update(wasm).digest());

const provider = new JsonRpcProvider({ url: NEAR_RPC['near-testnet'] });
const ownerAccount = new Account(owner, provider, env.NEAR_PRIVATE_KEY);
const ownerKey = KeyPair.fromString(env.NEAR_PRIVATE_KEY).getPublicKey();
const agentKey = KeyPair.fromRandom('ed25519');

console.log(`owner ${owner}; creating ${guardId} with ${arg('fund', '2.5')} testnet NEAR`);
await ownerAccount.createSubAccount({ accountOrPrefix: 'guard', publicKey: ownerKey, nearToTransfer: nearToYocto(arg('fund', '2.5')) });

const guard = new Account(guardId, provider, env.NEAR_PRIVATE_KEY);
const init = { owner, allowlist, per_payment_cap: perPayment.toString(), daily_cap: daily.toString() };
const outcome = await guard.signAndSendTransaction({
  receiverId: guardId,
  actions: [
    actions.deployContract(new Uint8Array(wasm)),
    actions.functionCall('new', init, 30_000_000_000_000n, 0n),
    actions.addFunctionCallAccessKey(agentKey.getPublicKey(), guardId, ['pay'], nearToYocto(arg('allowance', '0.25'))),
  ],
  throwOnFailure: false,
});
if (outcome.status?.Failure) {
  console.error(`deploy failed: ${JSON.stringify(outcome.status.Failure)}`);
  console.error(`https://testnet.nearblocks.io/txns/${outcome.transaction.hash}`);
  process.exit(1);
}
appendFileSync('.env', `NEAR_GUARD_ID=${guardId}\nNEAR_GUARD_AGENT_KEY=${agentKey.toString()}\n`);

console.log(`deployed ${WASM} (sha256 ${codeHash}) https://testnet.nearblocks.io/txns/${outcome.transaction.hash}`);
const policy = await provider.callFunction({ contractId: guardId, method: 'get_policy', args: {} });
console.log(`allowlist: ${policy.allowlist.join(', ')}`);
console.log(`caps: ${formatNear(BigInt(policy.per_payment_cap))} NEAR per payment, ${formatNear(BigInt(policy.daily_cap))} NEAR a day; guard holds ${formatNear(BigInt(policy.available))} NEAR it can pay out`);
console.log(`agent key ${agentKey.getPublicKey().toString()}: may call pay() on ${guardId} only; written to .env as NEAR_GUARD_AGENT_KEY`);
