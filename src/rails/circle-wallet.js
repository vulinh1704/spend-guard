import { randomBytes, randomUUID } from 'node:crypto';
import {
  formatUnits, getAddress, getTypesForEIP712Domain, hexToBigInt, isAddress, isAddressEqual, numberToHex, parseSignature, recoverTypedDataAddress,
  serializeSignature, serializeTypedData, toHex,
} from 'viem';
import { assetOf } from '../money.js';
import { ARC_USDC, arcTestnet } from './arc.js';

/**
 * Circle's token id for the USDC ERC-20 on Arc testnet. Not the 18-decimal native gas balance
 * (15dc2b5d-…): a transfer of that emits no ERC-20 Transfer log, so checkArcPayment would not see it.
 */
export const ARC_TESTNET_USDC_TOKEN_ID = 'ef87c8c3-85de-598a-af50-c5135eecfa74';

/**
 * USDC's EIP-712 domain on Arc testnet; it hashes to the contract's DOMAIN_SEPARATOR (0x3611…c6b0).
 * Pinned here and never taken from a 402 response: the same address holds real money on Arc
 * mainnet, and a paywall must not be able to pick the chain a signature spends on.
 */
export const ARC_TESTNET_USDC_DOMAIN = { name: 'USDC', version: '2', chainId: arcTestnet.id, verifyingContract: ARC_USDC };

/** EIP-3009, the authorization x402's 'exact' scheme uses for USDC. */
export const TRANSFER_WITH_AUTHORIZATION = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

const USDC_DECIMALS = assetOf('usdc').decimals;

/**
 * @typedef {object} CircleClient  The part of Circle's developer-controlled wallets SDK the rail
 *   uses; tests pass a fake. Each call resolves to an axios response whose `data` is Circle's `data`.
 * @property {(input: object) => Promise<{data?: {id: string, state: string}}>} createTransaction
 * @property {(input: object) => Promise<{data?: {transaction?: {id: string, state: string, txHash?: string}}}>} getTransaction
 * @property {(input: object) => Promise<{data?: {signature: string}}>} signTypedData
 * @property {(input: {id: string}) => Promise<{data?: {wallet?: object}}>} [getWallet]
 */

/**
 * Pays USDC on Arc from a Circle developer-controlled wallet. Circle holds the key (MPC) and signs
 * on request, so the agent's process has an API key and an entity secret but never a private key;
 * the guard still decides before Circle is asked. Two ways to pay:
 *
 * - transfer: Circle sends a USDC transfer and the paywall checks it on chain (checkArcPayment).
 * - authorization: Circle signs an EIP-3009 TransferWithAuthorization, the x402 'exact' payload
 *   ({signature, authorization}); no transaction is sent, the paywall settles it.
 *
 * In 'auto' (the default) the paywall's offer in intent.x402 picks: an x402 'exact' option with
 * USDC's EIP-712 domain is signed; no offer, or an x402 v1 one without a domain, is paid by
 * transfer; any other offer is refused, since a transfer would not unlock it.
 */
export class CircleWalletRail {
  /**
   * @param {object} options
   * @param {CircleClient} options.client
   * @param {string} options.walletId
   * @param {string} options.address  The wallet's address; signatures are checked against it.
   * @param {'auto'|'transfer'|'authorization'} [options.mode]
   * @param {string} [options.network]
   * @param {string} [options.tokenId]
   * @param {typeof ARC_TESTNET_USDC_DOMAIN} [options.domain]
   * @param {number} [options.validForSeconds]  Longest time a signed authorization can be settled in.
   * @param {number} [options.timeoutMs]  How long to wait for a transfer to complete.
   * @param {() => number} [options.now]
   */
  constructor({ client, walletId, address, mode = 'auto', network = 'arc-testnet', tokenId = ARC_TESTNET_USDC_TOKEN_ID, domain = ARC_TESTNET_USDC_DOMAIN, validForSeconds = 300, timeoutMs = 120_000, now = Date.now }) {
    if (!['auto', 'transfer', 'authorization'].includes(mode)) throw new Error(`unknown CircleWalletRail mode "${mode}"`);
    Object.assign(this, { client, walletId, address: getAddress(address), mode, network, tokenId, domain, validForSeconds, timeoutMs, now });
  }

  /** @param {import('../policy.js').Intent & {x402?: object}} intent */
  async pay(intent) {
    if (intent.asset !== 'usdc') throw new Error(`CircleWalletRail pays in USDC; ${intent.resource} asked for ${intent.asset}`);
    const offer = this.mode === 'transfer' ? null : this.#authorizationOffer(intent);
    return (offer || this.mode === 'authorization') ? this.#authorize(intent, offer) : this.#transfer(intent);
  }

  async #transfer(intent) {
    const created = await this.client.createTransaction({
      walletId: this.walletId,
      tokenId: this.tokenId,
      destinationAddress: intent.payTo,
      amount: [formatUnits(intent.amount, USDC_DECIMALS)], // Circle takes decimal units: 10000n is '0.01'
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      idempotencyKey: randomUUID(),
      refId: intent.host, // shown next to the transaction in Circle's console
    });
    const id = created.data?.id;
    if (!id) throw new Error(`Circle did not accept the transfer for ${intent.resource}`);

    let tx;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      // Rejects when Circle ends the transaction FAILED, DENIED (its screening), CANCELLED or STUCK.
      ({ transaction: tx } = (await this.client.getTransaction({ id, waitForState: 'COMPLETE', signal })).data ?? {});
    } catch (err) {
      // Giving up waiting does not cancel the transfer, so say where to look before anyone pays again.
      const detail = signal.aborted ? `still pending after ${this.timeoutMs / 1000}s; check it in Circle before paying again` : err.message;
      throw new Error(`Circle transaction ${id} for ${intent.resource}: ${detail}`, { cause: err });
    }
    if (tx?.state !== 'COMPLETE' || !tx.txHash) throw new Error(`Circle transaction ${id} ended ${tx?.state ?? 'without a state'}`);
    return { network: this.network, txid: tx.txHash, proof: { txid: tx.txHash, sender: this.address }, circle: { transactionId: id } };
  }

  /**
   * Signs what the guard approved (intent.payTo, intent.amount), never the offer's own numbers.
   * A signed authorization can move only `value` to `to` before `validBefore`, so it counts as
   * spent when signed; the short window bounds a paywall that never settles.
   *
   * @param {object} intent
   * @param {{maxTimeoutSeconds?: number}|null} offer
   */
  async #authorize(intent, offer) {
    const ttl = Math.min(offer?.maxTimeoutSeconds ?? this.validForSeconds, this.validForSeconds);
    const validBefore = BigInt(Math.floor(this.now() / 1000) + ttl);
    const message = { from: this.address, to: getAddress(intent.payTo), value: intent.amount, validAfter: 0n, validBefore, nonce: toHex(randomBytes(32)) };
    const typed = { domain: this.domain, types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION }, primaryType: 'TransferWithAuthorization', message };
    // Circle signs a JSON string. Without EIP712Domain in its types, serializeTypedData drops the domain
    // and the signature would be for a hash USDC never checks.
    const data = serializeTypedData({ ...typed, types: { EIP712Domain: getTypesForEIP712Domain({ domain: this.domain }), ...typed.types } });
    const res = await this.client.signTypedData({ walletId: this.walletId, data, memo: `x402 ${intent.host}: ${intent.description ?? intent.resource}`.slice(0, 100) });

    const returned = res.data?.signature;
    if (!returned) throw new Error(`Circle returned no signature for ${intent.resource}`);
    let signature;
    try {
      signature = canonical(returned.startsWith('0x') ? returned : `0x${returned}`);
    } catch (err) {
      throw new Error(`Circle returned a malformed signature for ${intent.resource}`, { cause: err });
    }
    // A smart-contract wallet's signature or a domain mix-up would be rejected by USDC; catch it here.
    const signer = await recoverTypedDataAddress({ ...typed, signature });
    if (!isAddressEqual(signer, this.address)) throw new Error(`Circle's signature recovers to ${signer}, not the wallet ${this.address}`);

    const authorization = { from: message.from, to: message.to, value: message.value.toString(), validAfter: '0', validBefore: validBefore.toString(), nonce: message.nonce };
    return { network: this.network, proof: { signature, authorization }, authorization: { nonce: message.nonce, validBefore: authorization.validBefore }, circle: { walletId: this.walletId } };
  }

  /**
   * The x402 'exact' EIP-3009 option behind this intent, or null when the paywall wants a transfer:
   * no offer, or an x402 v1 one without an EIP-712 domain, like the demo paywall's. Anything else
   * is signed or refused, never paid some other way: an x402 v2 or eip155 paywall settles only an
   * authorization, so a transfer would move the money and still get a 402.
   */
  #authorizationOffer(intent) {
    const x402 = intent.x402;
    if (!x402) return null;
    const option = x402.raw ?? x402;
    const version = x402.x402Version ?? x402.version; // read before unwrapping: a raw v2 option has none
    const extra = option.extra ?? {};
    if (option.scheme !== 'exact') throw new Error(`${intent.resource} wants the x402 '${option.scheme}' scheme; this wallet pays 'exact' only`);
    if (!extra.name && !extra.version) {
      if (version === 1 || (version === undefined && !/^eip155:/.test(option.network ?? ''))) return null;
      throw new Error(`${intent.resource} offers x402 'exact' on ${option.network} without the token's EIP-712 domain; this wallet can't sign it, and a transfer would not unlock it`);
    }
    if ((extra.assetTransferMethod ?? 'eip3009') !== 'eip3009' || (extra.paymentFlow ?? 'authorization') !== 'authorization') {
      throw new Error(`${intent.resource} wants ${extra.assetTransferMethod ?? 'eip3009'}/${extra.paymentFlow ?? 'authorization'}; this wallet signs EIP-3009 authorizations only`);
    }
    const chainId = option.network === this.network ? this.domain.chainId : Number(/^eip155:(\d+)$/.exec(option.network)?.[1]);
    const same = extra.name === this.domain.name && extra.version === this.domain.version && chainId === this.domain.chainId
      && isAddress(option.asset ?? '') && isAddressEqual(option.asset, this.domain.verifyingContract);
    if (!same) throw new Error(`${intent.resource} wants an authorization for ${extra.name} ${extra.version} at ${option.asset} on ${option.network}; this wallet signs only for ${this.domain.name} ${this.domain.version} on chain ${this.domain.chainId}`);
    return option;
  }
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * The same signature in the form USDC's ECRecover accepts: v 27 or 28 and s in the lower half of the
 * curve order. Both v 0/1 and a high s recover to the same signer, but USDC reverts on them.
 *
 * @param {`0x${string}`} signature
 */
function canonical(signature) {
  const { r, s, yParity } = parseSignature(signature);
  if (hexToBigInt(s) <= SECP256K1_N / 2n) return serializeSignature({ r, s, yParity });
  return serializeSignature({ r, s: numberToHex(SECP256K1_N - hexToBigInt(s), { size: 32 }), yParity: 1 - yParity });
}

/**
 * Circle's wallets SDK client from CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET (and CIRCLE_BASE_URL,
 * which only tests set). The SDK is loaded here and nowhere else, so the other rails run without it
 * (it needs Node 22+). Testnet keys only.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Promise<CircleClient>}
 */
export async function circleClientFromEnv(env = process.env) {
  const missing = ['CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`${missing.join(' and ')} missing from the environment; see docs/circle-wallets.md`);
  if (!env.CIRCLE_API_KEY.startsWith('TEST_API_KEY:')) throw new Error('CIRCLE_API_KEY is not a testnet key (TEST_API_KEY:…); Circle mode runs on Arc testnet only');
  const { initiateDeveloperControlledWalletsClient } = await import('@circle-fin/developer-controlled-wallets');
  return initiateDeveloperControlledWalletsClient({ apiKey: env.CIRCLE_API_KEY, entitySecret: env.CIRCLE_ENTITY_SECRET, ...(env.CIRCLE_BASE_URL && { baseUrl: env.CIRCLE_BASE_URL }) });
}

/**
 * The rail for the wallet in CIRCLE_WALLET_ID, after checking with Circle that it is a live Arc
 * testnet wallet (and the address in CIRCLE_WALLET_ADDRESS, when set).
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{client?: CircleClient} & Partial<ConstructorParameters<typeof CircleWalletRail>[0]>} [options]
 */
export async function circleWalletRailFromEnv(env = process.env, { client, ...options } = {}) {
  if (!env.CIRCLE_WALLET_ID) throw new Error('CIRCLE_WALLET_ID missing from the environment; run node scripts/circle-wallet-setup.js');
  client ??= await circleClientFromEnv(env);
  const wallet = (await client.getWallet({ id: env.CIRCLE_WALLET_ID })).data?.wallet;
  if (wallet?.blockchain !== 'ARC-TESTNET') throw new Error(`Circle wallet ${env.CIRCLE_WALLET_ID} is on ${wallet?.blockchain ?? 'no chain'}, not ARC-TESTNET`);
  if (wallet.state !== 'LIVE') throw new Error(`Circle wallet ${wallet.id} is ${wallet.state}, not LIVE`);
  if (env.CIRCLE_WALLET_ADDRESS && !isAddressEqual(env.CIRCLE_WALLET_ADDRESS, wallet.address)) throw new Error(`CIRCLE_WALLET_ADDRESS is ${env.CIRCLE_WALLET_ADDRESS} but Circle says wallet ${wallet.id} is ${wallet.address}`);
  // USDC checks a contract wallet's signature with ERC-1271, which the rail's own check can't follow.
  // 'auto' signs too, whenever an x402 offer asks for it.
  if ((options.mode ?? 'auto') !== 'transfer' && wallet.accountType !== 'EOA') {
    throw new Error(`Circle wallet ${wallet.id} is ${wallet.accountType}; signing authorizations needs an EOA, so use mode 'transfer' for this wallet`);
  }
  return new CircleWalletRail({ client, walletId: wallet.id, address: wallet.address, ...options });
}
