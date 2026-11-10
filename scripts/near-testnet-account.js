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
// When the helper is down: the other way NEAR's hackathon FAQ (Q-008) gives for test NEAR.
const FALLBACK = `Without the helper:
  1. Create a testnet account in a NEAR wallet that supports testnet, and get test NEAR for it at https://near-faucet.io
  2. Write .env yourself (then chmod 600 .env), with the account and a full-access key it holds:
       NEAR_NETWORK=near-testnet
       NEAR_ACCOUNT_ID=<your account>.testnet
       NEAR_PRIVATE_KEY=ed25519:<its private key>
  3. Go on with node scripts/near-demo-payees.js, which falls back to sub-accounts of that account.`;

if (existsSync('.env')) {
  console.error('.env already exists; move it away first so its key is not lost');
  process.exit(1);
}

const accountId = process.argv[2] ?? `spend-guard-${randomBytes(3).toString('hex')}.testnet`;
const keyPair = KeyPair.fromRandom('ed25519');

let refused = null;
try {
  const res = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) refused = `${res.status} ${await res.text()}`;
} catch (err) {
  refused = err.message;
}
if (refused) {
  console.error(`the testnet helper did not create ${accountId}: ${refused}`);
  console.error(FALLBACK);
  process.exit(1);
}

writeFileSync('.env', `NEAR_NETWORK=near-testnet\nNEAR_ACCOUNT_ID=${accountId}\nNEAR_PRIVATE_KEY=${keyPair.toString()}\n`);
chmodSync('.env', 0o600);
console.log(`created ${accountId}; key written to .env`);
