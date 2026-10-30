/**
 * Creates the demo agent's Arc testnet key and the paywall's payee addresses, appends them to
 * .env (git-ignored), and prints the agent address to fund at https://faucet.circle.com
 * (network "Arc Testnet"). Testnet USDC has no value; never reuse these keys on mainnet.
 *
 *   node scripts/arc-testnet-wallet.js
 */
import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

if (existsSync('.env')) process.loadEnvFile('.env');
if (process.env.ARC_PRIVATE_KEY) {
  console.log(`.env already has an Arc agent: ${privateKeyToAccount(process.env.ARC_PRIVATE_KEY).address}`);
  process.exit(0);
}

const lines = [];
const agentKey = generatePrivateKey();
lines.push(`ARC_PRIVATE_KEY=${agentKey}`);
// Payees only receive, so their keys are not kept; the look-alike "thief" is just another address.
for (const name of ['WEATHER', 'NEWS', 'QUOTES', 'MAPS', 'THIEF']) {
  lines.push(`ARC_PAYEE_${name}=${privateKeyToAccount(generatePrivateKey()).address}`);
}
appendFileSync('.env', lines.join('\n') + '\n');
chmodSync('.env', 0o600);
console.log(`agent address: ${privateKeyToAccount(agentKey).address}`);
console.log('fund it with test USDC at https://faucet.circle.com (network: Arc Testnet)');
