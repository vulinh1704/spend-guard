/**
 * Sets up the demo paywall's testnet accounts: a paywall account and one sub-account per payee,
 * including the look-alike "rnaps" that the bad /maps endpoint switches to. Appends their names
 * (and the paywall key) to .env. Run after near-testnet-account.js.
 *
 * The paywall account comes from the public testnet helper. If the helper refuses or is down (or
 * with --no-faucet), the paywall is made a sub-account of your agent account instead, funded with
 * 0.5 testnet NEAR from it: sg-paywall-<id>.<agent account>.
 *
 *   node scripts/near-demo-payees.js [--no-faucet]
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from 'near-api-js';

process.loadEnvFile('.env');
if (process.env.PAYWALL_ACCOUNT_ID) {
  console.error(`.env already has a paywall (${process.env.PAYWALL_ACCOUNT_ID})`);
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const prefix = `sg-paywall-${randomBytes(3).toString('hex')}`;
const keyPair = KeyPair.fromRandom('ed25519');

/** Asks the testnet helper for name.testnet; returns why not, or null once created. */
async function fromHelper(accountId) {
  try {
    const res = await fetch('https://helper.nearprotocol.com/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? null : `${res.status} ${await res.text()}`;
  } catch (err) {
    return err.message;
  }
}

let paywallId = `${prefix}.testnet`;
const refused = process.argv.includes('--no-faucet') ? 'skipped (--no-faucet)' : await fromHelper(paywallId);
if (refused) {
  const agent = new Account(process.env.NEAR_ACCOUNT_ID, provider, process.env.NEAR_PRIVATE_KEY);
  paywallId = `${prefix}.${agent.accountId}`;
  console.log(`testnet helper: ${refused}; creating ${paywallId} from your agent account instead`);
  await agent.createSubAccount({ accountOrPrefix: prefix, publicKey: keyPair.getPublicKey(), nearToTransfer: nearToYocto('0.5') });
}
appendFileSync('.env', `PAYWALL_ACCOUNT_ID=${paywallId}\nPAYWALL_PRIVATE_KEY=${keyPair.toString()}\n`);

const paywall = new Account(paywallId, provider, keyPair.toString());
// The faucet's account may need a moment before it can sign.
await new Promise((resolve) => setTimeout(resolve, 3000));

for (const name of ['weather', 'news', 'quotes', 'maps', 'rnaps']) {
  await paywall.createSubAccount({ accountOrPrefix: name, publicKey: keyPair.getPublicKey(), nearToTransfer: nearToYocto('0.05') });
  const id = `${name}.${paywallId}`;
  appendFileSync('.env', `PAYEE_${name === 'rnaps' ? 'THIEF' : name.toUpperCase()}=${id}\n`);
  console.log(`created ${id}`);
}
