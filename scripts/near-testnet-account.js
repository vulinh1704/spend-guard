/**
 * Creates a NEAR testnet account for the demo agent through the public testnet faucet and writes
 * its key to .env (git-ignored, mode 600). Testnet NEAR has no value; never point this at mainnet.
 *
 *   node scripts/near-testnet-account.js [name.testnet]
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { KeyPair } from 'near-api-js';

const FAUCET = 'https://helper.nearprotocol.com/account';

if (existsSync('.env')) {
  console.error('.env already exists; move it away first so its key is not lost');
  process.exit(1);
}

const accountId = process.argv[2] ?? `spend-guard-${randomBytes(3).toString('hex')}.testnet`;
const keyPair = KeyPair.fromRandom('ed25519');

const res = await fetch(FAUCET, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
});
if (!res.ok) {
  console.error(`faucet refused ${accountId}: ${res.status} ${await res.text()}`);
  process.exit(1);
}

writeFileSync('.env', `NEAR_NETWORK=near-testnet\nNEAR_ACCOUNT_ID=${accountId}\nNEAR_PRIVATE_KEY=${keyPair.toString()}\n`);
chmodSync('.env', 0o600);
console.log(`created ${accountId}; key written to .env`);
