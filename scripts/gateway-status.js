/**
 * The Arc agent's Circle Gateway balance and its latest nanopayments. A payment shows up once the
 * payee settles it (received), then is batched and lands on Arc (completed) with the batch's
 * transaction, usually within minutes.
 *
 *   node scripts/gateway-status.js [count]     # default 10
 */
import { existsSync } from 'node:fs';
import { formatUnits } from 'viem';
import { GatewayRail } from '../src/rails/gateway.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const rail = new GatewayRail({ privateKey: process.env.ARC_PRIVATE_KEY });
const { wallet, gateway } = await rail.balances();
console.log(`agent ${rail.address}`);
console.log(`wallet ${wallet.formatted} USDC · Gateway ${gateway.formattedAvailable} USDC available\n`);

const { transfers = [] } = await rail.client.searchTransfers({ from: rail.address, pageSize: Number(process.argv[2] ?? 10) });
for (const t of transfers) {
  const tx = t.txHash ? `https://testnet.arcscan.app/tx/${t.txHash}` : 'not on chain yet';
  console.log(`${t.createdAt}  ${t.status.padEnd(9)} ${formatUnits(BigInt(t.amount), 6).padEnd(6)} USDC → ${t.toAddress}  ${tx}`);
}
if (!transfers.length) console.log('no Gateway payments yet');
