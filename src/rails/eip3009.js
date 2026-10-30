/**
 * x402's 'exact' scheme on EVM chains, for tokens with EIP-3009 (USDC): the payer signs a
 * TransferWithAuthorization and sends no transaction; whoever settles it submits it and pays the
 * gas. The client half signs; the server half is a self-hosted facilitator that verifies and
 * settles, since the public x402.org facilitator does not serve Arc.
 */
import { erc20Abi, getAddress, isAddressEqual, parseEventLogs, parseSignature, toHex, verifyTypedData } from 'viem';

export const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/** The (v, r, s) overload, which every FiatToken version has, and the replay check. */
export const EIP3009_ABI = [
  {
    type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', outputs: [],
    inputs: [...TRANSFER_WITH_AUTHORIZATION.TransferWithAuthorization, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }],
  },
  {
    type: 'function', name: 'authorizationState', stateMutability: 'view', outputs: [{ type: 'bool' }],
    inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }],
  },
];

// FiatToken's ecrecover refuses the upper half of s, so such a signature could never settle.
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * @typedef {object} ExactRequirement  What an x402 v2 paywall asks for (one `accepts` entry).
 * @property {string} network  CAIP-2, e.g. "eip155:5042002".
 * @property {string} asset  Token contract.
 * @property {string} payTo
 * @property {string|bigint} amount  Atomic units.
 * @property {number} [maxTimeoutSeconds]
 * @property {{name: string, version: string}} extra  The token's EIP-712 domain.
 */

/**
 * @typedef {object} Authorization  EIP-3009 fields as x402 sends them: numbers as decimal strings.
 * @property {`0x${string}`} from
 * @property {`0x${string}`} to
 * @property {string} value
 * @property {string} validAfter
 * @property {string} validBefore
 * @property {`0x${string}`} nonce
 */

/** @typedef {{signature: `0x${string}`, authorization: Authorization}} ExactPayload  The x402 'exact' EVM payload. */

/** @param {string} network  "eip155:5042002" → 5042002 */
export function chainIdOf(network) {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`not an EVM network: ${network}`);
  return Number(m[1]);
}

/**
 * The EIP-712 message both sides hash. The domain comes from the requirement, as in x402: a wrong
 * name or version only yields a signature the token rejects, and chainId plus verifyingContract
 * pin it to one token on one chain.
 *
 * @param {ExactRequirement} requirement
 * @param {Authorization} a
 */
export function typedData(requirement, a) {
  const { name, version } = requirement.extra ?? {};
  if (!name || !version) throw new Error(`${requirement.asset}: no EIP-712 domain (extra.name and extra.version)`);
  return {
    domain: { name, version, chainId: chainIdOf(requirement.network), verifyingContract: getAddress(requirement.asset) },
    types: TRANSFER_WITH_AUTHORIZATION,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value),
      validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce,
    },
  };
}

/**
 * Client: sign a one-shot authorization. No transaction and no gas, but it is a bearer cheque:
 * whoever holds it can move exactly `amount` to `payTo` until `validBefore`. The window is capped
 * so a paywall that asks for a long timeout can't sit on a signed payment.
 *
 * @param {import('viem').LocalAccount} account
 * @param {ExactRequirement} requirement
 * @param {{now?: () => number, maxWindow?: number}} [options]  maxWindow in seconds.
 * @returns {Promise<ExactPayload>}
 */
export async function signAuthorization(account, requirement, { now = Date.now, maxWindow = 120 } = {}) {
  const t = Math.floor(now() / 1000);
  /** @type {Authorization} */
  const authorization = {
    from: account.address,
    to: getAddress(requirement.payTo),
    value: String(requirement.amount),
    validAfter: '0',
    validBefore: String(t + Math.min(requirement.maxTimeoutSeconds ?? 60, maxWindow)),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const signature = await account.signTypedData(typedData(requirement, authorization));
  return { signature, authorization };
}

/**
 * Server: does `payload` pay `requirement`? Read-only. The reasons are x402's error codes.
 * Checks an EOA signature offline; smart-wallet payers (ERC-1271/6492) are not accepted.
 *
 * @param {Pick<import('viem').PublicClient, 'readContract'>} client
 * @param {ExactPayload} payload
 * @param {ExactRequirement} requirement
 * @param {{now?: () => number}} [options]
 * @returns {Promise<{reason: string, message: string}|null>}  null when it checks out.
 */
export async function verifyAuthorization(client, payload, requirement, { now = Date.now } = {}) {
  const { signature, authorization: a } = payload ?? {};
  if (typeof signature !== 'string' || !a) return { reason: 'invalid_payload', message: 'not an EIP-3009 authorization' };
  if (!isAddressEqual(a.to, requirement.payTo)) return { reason: 'invalid_exact_evm_recipient_mismatch', message: `authorization pays ${a.to}, not ${requirement.payTo}` };
  // Exact means exact: the official facilitator refuses overpayment too.
  if (BigInt(a.value) !== BigInt(requirement.amount)) return { reason: 'invalid_exact_evm_payload_authorization_value_mismatch', message: `authorization is for ${a.value}, not ${requirement.amount}` };
  const t = BigInt(Math.floor(now() / 1000));
  // Six seconds of slack for the settling transaction to land in a block.
  if (BigInt(a.validBefore) < t + 6n) return { reason: 'invalid_exact_evm_payload_authorization_valid_before', message: 'authorization has expired' };
  if (BigInt(a.validAfter) > t) return { reason: 'invalid_exact_evm_payload_authorization_valid_after', message: 'authorization is not valid yet' };

  let valid = false;
  try {
    valid = signature.length === 132 && BigInt(parseSignature(signature).s) <= HALF_N && (await verifyTypedData({ address: a.from, signature, ...typedData(requirement, a) }));
  } catch {
    valid = false;
  }
  if (!valid) return { reason: 'invalid_exact_evm_signature', message: `signature is not from ${a.from}` };

  const asset = getAddress(requirement.asset);
  if (await client.readContract({ address: asset, abi: EIP3009_ABI, functionName: 'authorizationState', args: [a.from, a.nonce] })) {
    return { reason: 'invalid_exact_evm_nonce_already_used', message: 'authorization was already used' };
  }
  if ((await client.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [a.from] })) < BigInt(a.value)) {
    return { reason: 'invalid_exact_evm_insufficient_balance', message: `${a.from} cannot cover ${a.value}` };
  }
  return null;
}

/**
 * Server: submit a verified authorization (the settler pays the gas) and report the outcome as an
 * x402 SettleResponse. Success needs the token's own Transfer log, not just a mined transaction.
 *
 * @param {Pick<import('viem').PublicClient, 'simulateContract'|'waitForTransactionReceipt'>} publicClient
 * @param {Pick<import('viem').WalletClient, 'account'|'writeContract'>} walletClient
 * @param {ExactPayload} payload
 * @param {ExactRequirement} requirement
 * @param {{timeout?: number}} [options]  How long to wait for the receipt, in ms.
 */
export async function settleAuthorization(publicClient, walletClient, payload, requirement, { timeout = 60_000 } = {}) {
  const { signature, authorization: a } = payload;
  const asset = getAddress(requirement.asset);
  const base = { network: requirement.network, payer: a.from };
  let hash;
  try {
    const { r, s, v, yParity } = parseSignature(signature);
    const { request } = await publicClient.simulateContract({
      account: walletClient.account, address: asset, abi: EIP3009_ABI, functionName: 'transferWithAuthorization',
      args: [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? BigInt(yParity + 27)), r, s],
    });
    hash = await walletClient.writeContract(request);
  } catch (err) {
    return { success: false, errorReason: 'invalid_exact_evm_transaction_simulation_failed', errorMessage: err.shortMessage ?? err.message, transaction: '', ...base };
  }

  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout });
  } catch {
    // Broadcast but not confirmed yet: the hash is all the payer can follow up on.
    return { success: false, errorReason: 'settlement_pending', transaction: hash, ...base };
  }
  if (receipt.status !== 'success') return { success: false, errorReason: 'invalid_exact_evm_transaction_failed', transaction: hash, ...base };
  const moved = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).some(
    (log) => isAddressEqual(log.address, asset) && isAddressEqual(log.args.from, a.from) && isAddressEqual(log.args.to, a.to) && log.args.value === BigInt(a.value),
  );
  if (!moved) return { success: false, errorReason: 'invalid_exact_evm_transfer_event_mismatch', transaction: hash, ...base };
  return { success: true, transaction: hash, amount: String(a.value), ...base };
}
