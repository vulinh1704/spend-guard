import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, isAddressEqual, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Circle's Arc testnet: USDC is the gas token, and the USDC ERC-20 (6 decimals) lives at a fixed address. */
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
});

export const ARC_USDC = '0x3600000000000000000000000000000000000000';

/**
 * Pays in USDC on Arc: an ERC-20 transfer from the agent's own key. Like every rail, the key
 * should hold only what the agent may spend.
 */
export class ArcRail {
  /**
   * @param {object} options
   * @param {`0x${string}`} options.privateKey  Read from the environment, never committed.
   * @param {string} [options.network]
   * @param {import('viem').Chain} [options.chain]
   * @param {import('viem').Transport} [options.transport]
   */
  constructor({ privateKey, network = 'arc-testnet', chain = arcTestnet, transport = http() }) {
    this.network = network;
    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
  }

  get address() {
    return this.account.address;
  }

  /** @param {import('../policy.js').Intent} intent */
  async pay(intent) {
    if (intent.asset !== 'usdc') throw new Error(`ArcRail pays in USDC; ${intent.resource} asked for ${intent.asset}`);
    const hash = await this.walletClient.writeContract({ address: ARC_USDC, abi: erc20Abi, functionName: 'transfer', args: [intent.payTo, intent.amount] });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`USDC transfer ${hash} reverted`);
    return { network: this.network, txid: hash, proof: { txid: hash, sender: this.account.address } };
  }
}

/**
 * The paywall's side: did transaction `txid` move at least `amount` USDC from `sender` to
 * `payTo`? Reads the receipt's Transfer events, so a forged proof gets nowhere.
 *
 * @param {import('viem').PublicClient} client
 * @param {{txid: `0x${string}`, sender: `0x${string}`}} proof
 * @param {{payTo: string, amount: bigint}} expected
 * @returns {Promise<string|null>}  null when the payment checks out, otherwise why not.
 */
export async function checkArcPayment(client, proof, expected) {
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: proof.txid });
  } catch (err) {
    return `transaction ${proof.txid} not found: ${err.shortMessage ?? err.message}`;
  }
  if (receipt.status !== 'success') return `transaction ${proof.txid} did not succeed`;
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).filter(
    (log) => isAddressEqual(log.address, ARC_USDC) && isAddressEqual(log.args.from, proof.sender) && isAddressEqual(log.args.to, expected.payTo),
  );
  const paid = transfers.reduce((sum, log) => sum + log.args.value, 0n);
  if (!transfers.length) return `transaction ${proof.txid} has no USDC transfer from ${proof.sender} to ${expected.payTo}`;
  if (paid < expected.amount) return `transaction ${proof.txid} paid ${paid} USDC units, not ${expected.amount}`;
  return null;
}
