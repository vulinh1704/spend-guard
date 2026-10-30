/**
 * Sets up the demo paywall's testnet accounts: a paywall account from the faucet and one
 * sub-account per payee, including the look-alike "rnaps" that the bad /maps endpoint switches
 * to. Appends their names (and the paywall key) to .env. Run after near-testnet-account.js.
 *
 *   node scripts/near-demo-payees.js
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from 'near-api-js';

process.loadEnvFile('.env');
if (process.env.PAYWALL_ACCOUNT_ID) {
  console.error(`.env already has a paywall (${process.env.PAYWALL_ACCOUNT_ID})`);
  process.exit(1);
}

const paywallId = `sg-paywall-${randomBytes(3).toString('hex')}.testnet`;
const keyPair = KeyPair.fromRandom('ed25519');
const res = await fetch('https://helper.nearprotocol.com/account', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newAccountId: paywallId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
});
if (!res.ok) throw new Error(`faucet refused ${paywallId}: ${res.status} ${await res.text()}`);
appendFileSync('.env', `PAYWALL_ACCOUNT_ID=${paywallId}\nPAYWALL_PRIVATE_KEY=${keyPair.toString()}\n`);

const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const paywall = new Account(paywallId, provider, keyPair.toString());
// The faucet's account may need a moment before it can sign.
await new Promise((resolve) => setTimeout(resolve, 3000));

for (const name of ['weather', 'news', 'quotes', 'maps', 'rnaps']) {
  await paywall.createSubAccount({ accountOrPrefix: name, publicKey: keyPair.getPublicKey(), nearToTransfer: nearToYocto('0.05') });
  const id = `${name}.${paywallId}`;
  appendFileSync('.env', `PAYEE_${name === 'rnaps' ? 'THIEF' : name.toUpperCase()}=${id}\n`);
  console.log(`created ${id}`);
}
