import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, http, isAddressEqual, keccak256, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PaymentUnconfirmed } from '../guard.js';
import { chainIdOf, signAuthorization } from './eip3009.js';

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
/** USDC's EIP-712 domain on Arc (the token's name() and version()), which x402 offers carry in `extra`. */
export const ARC_USDC_DOMAIN = { name: 'USDC', version: '2' };

/**
 * Pays in USDC on Arc from the agent's own key, in one of two ways. An x402 'exact' offer that
 * names its EIP-712 domain gets an EIP-3009 authorization: signed here, settled (and its gas paid)
 * by the paywall. A payment with no offer, or a v1 offer without the domain (the demo paywall that
 * checks transfers), gets a plain ERC-20 transfer. A v2 offer without the domain gets neither.
 * Like every rail, the key should hold only what the agent may spend.
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
    this.chain = chain;
    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
  }

  get address() {
    return this.account.address;
  }

  /** @param {import('../policy.js').Intent & {x402?: import('../x402.js').Offer}} intent */
  async pay(intent) {
    if (intent.asset !== 'usdc') throw new Error(`ArcRail pays in USDC; ${intent.resource} asked for ${intent.asset}`);
    if (signsFor(intent.x402)) return this.#authorize(intent, intent.x402);
    // v2 has no payload for a transfer proof: the paywall would keep the money and refuse the call.
    if (intent.x402?.x402Version === 2) throw new Error(`${intent.resource} sent an x402 v2 offer without the token's EIP-712 domain; nothing to sign, and a transfer would not be accepted`);
    // Signed before it is sent, so the hash is known: once sent, an RPC error or the receipt wait
    // timing out does not mean nothing was paid, only that it is not confirmed yet.
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [intent.payTo, intent.amount] });
    const serializedTransaction = await this.account.signTransaction(await this.walletClient.prepareTransactionRequest({ to: ARC_USDC, data }));
    const hash = keccak256(serializedTransaction);
    let receipt;
    try {
      await this.walletClient.sendRawTransaction({ serializedTransaction });
      receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    } catch (err) {
      throw new PaymentUnconfirmed(hash, err);
    }
    if (receipt.status !== 'success') throw new Error(`USDC transfer ${hash} reverted`);
    return { network: this.network, txid: hash, proof: { txid: hash, sender: this.account.address } };
  }

  /**
   * Signs for exactly what the guard approved (the intent's payee and amount, not the raw offer)
   * and broadcasts nothing. The receipt has no txid until the paywall reports its settlement.
   *
   * @param {import('../policy.js').Intent} intent
   * @param {import('../x402.js').Offer} offer
   */
  async #authorize(intent, offer) {
    // The same key is valid on every EVM chain: a signature for Arc mainnet would spend real money.
    if (chainIdOf(offer.network) !== this.chain.id) throw new Error(`${intent.resource} asks for a signature on ${offer.network}; this rail signs for chain ${this.chain.id} only`);
    if (!isAddressEqual(offer.asset, ARC_USDC)) throw new Error(`${intent.resource} asks for a signature over ${offer.asset}, not Arc's USDC`);
    const proof = await signAuthorization(this.account, { ...offer, payTo: intent.payTo, amount: intent.amount });
    return { network: this.network, txid: undefined, proof };
  }
}

/** An x402 'exact' offer on an EVM chain that names the token's EIP-712 domain, i.e. EIP-3009. */
function signsFor(offer) {
  return offer?.scheme === 'exact' && /^eip155:\d+$/.test(offer.network) && Boolean(offer.extra?.name && offer.extra?.version);
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
