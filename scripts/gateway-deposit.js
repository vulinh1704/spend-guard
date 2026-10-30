/**
 * Moves test USDC from the Arc agent's wallet into its Circle Gateway balance (approve + deposit:
 * two Arc testnet transactions, gas paid in USDC), then waits until Gateway credits it. The agent
 * can only spend what is in Gateway, so deposit about a day's budget, no more.
 *
 *   node scripts/gateway-deposit.js [usdc]     # default 1
 */
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseUnits } from 'viem';
import { GatewayRail } from '../src/rails/gateway.js';

// The demo spends cents; the cap keeps a typo from parking the whole wallet in Gateway.
const MAX_USDC = 2;

if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.ARC_PRIVATE_KEY) {
  console.error('no ARC_PRIVATE_KEY in .env; run node scripts/arc-testnet-wallet.js first');
  process.exit(1);
}
const usdc = process.argv[2] ?? '1';
if (!/^\d+(\.\d{1,6})?$/.test(usdc) || !(Number(usdc) > 0 && Number(usdc) <= MAX_USDC)) {
  console.error(`usage: node scripts/gateway-deposit.js [usdc]   (more than 0, at most ${MAX_USDC})`);
  process.exit(1);
}

const rail = new GatewayRail({ privateKey: process.env.ARC_PRIVATE_KEY });
const before = (await rail.balances()).gateway.available;
console.log(`agent ${rail.address}: depositing ${usdc} USDC into Circle Gateway on Arc testnet`);
const { approvalTxHash, depositTxHash } = await rail.deposit(usdc);
if (approvalTxHash) console.log(`approve  https://testnet.arcscan.app/tx/${approvalTxHash}`);
console.log(`deposit  https://testnet.arcscan.app/tx/${depositTxHash}`);

// Gateway credits a deposit once it sees the block, usually within seconds on Arc.
const expected = before + parseUnits(usdc, 6);
for (let i = 0; i < 30; i++) {
  const { wallet, gateway } = await rail.balances();
  if (gateway.available >= expected || i === 29) {
    console.log(`wallet ${wallet.formatted} USDC · Gateway ${gateway.formattedAvailable} USDC available`);
    break;
  }
  await sleep(2000);
}
