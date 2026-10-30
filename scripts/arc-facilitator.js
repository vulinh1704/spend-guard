/**
 * Sets up the demo paywall's settling key for `node demo/agent.js --arc-x402`. The paywall submits
 * the agent's EIP-3009 authorizations itself, and on Arc the gas is paid in USDC, so the key needs
 * a little: this creates it in .env (git-ignored) if missing and tops it up from the demo agent's
 * wallet. One settlement costs under 0.003 USDC; the top-up never exceeds 1 test USDC.
 * Testnet only: never reuse these keys on mainnet.
 *
 *   node scripts/arc-facilitator.js
 */
import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import { createPublicClient, createWalletClient, erc20Abi, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { formatUsd } from '../src/money.js';
import { ARC_USDC, arcTestnet } from '../src/rails/arc.js';

const TOP_UP_BELOW = 100_000n; // 0.10 USDC
const TARGET = 500_000n; // 0.50 USDC
const MAX_TOP_UP = 1_000_000n; // 1 USDC, whatever the numbers above say

if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.ARC_PRIVATE_KEY) throw new Error('no ARC_PRIVATE_KEY in .env; run node scripts/arc-testnet-wallet.js first');

if (!process.env.ARC_FACILITATOR_PRIVATE_KEY) {
  const key = generatePrivateKey();
  appendFileSync('.env', `ARC_FACILITATOR_PRIVATE_KEY=${key}\n`);
  chmodSync('.env', 0o600);
  process.env.ARC_FACILITATOR_PRIVATE_KEY = key;
  console.log('created ARC_FACILITATOR_PRIVATE_KEY in .env');
}

const facilitator = privateKeyToAccount(process.env.ARC_FACILITATOR_PRIVATE_KEY);
const agent = privateKeyToAccount(process.env.ARC_PRIVATE_KEY);
const client = createPublicClient({ chain: arcTestnet, transport: http() });
const balanceOf = (address) => client.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] });

const has = await balanceOf(facilitator.address);
console.log(`facilitator ${facilitator.address} holds ${formatUsd(has)} USDC`);
if (has >= TOP_UP_BELOW) process.exit(0);

const amount = TARGET - has > MAX_TOP_UP ? MAX_TOP_UP : TARGET - has;
const wallet = createWalletClient({ account: agent, chain: arcTestnet, transport: http() });
const hash = await wallet.writeContract({ address: ARC_USDC, abi: erc20Abi, functionName: 'transfer', args: [facilitator.address, amount] });
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') throw new Error(`top-up ${hash} reverted`);
console.log(`sent ${formatUsd(amount)} USDC from the agent ${agent.address}: https://testnet.arcscan.app/tx/${hash}`);
console.log(`facilitator now holds ${formatUsd(await balanceOf(facilitator.address))} USDC`);
