# Rails

A rail moves money on one network. The guard is its only caller: it decides, the rail pays.

| Rail | Network id | Asset | How it pays | What the paywall checks | Status |
|---|---|---|---|---|---|
| `MockRail` | any you pass | any | nothing moves | payee and amount in the proof | works (tests, offline demo) |
| `NearRail` | `near-testnet` | `near` | native NEAR transfer from the agent's account, signed with a full-access key | `checkNearPayment`: the transfers to the payee among the transaction's receipts | works on NEAR testnet |
| `NearGuardRail` | `near-testnet` | `near` | a `pay(receiver, amount)` call on Spend Guard's contract, which holds the NEAR and makes the transfer; the agent's function-call key may call `pay` and nothing else | `checkNearPayment`, as for `NearRail`: the transfer the contract made is one of the call's receipts | works on NEAR testnet (`guard.spend-guard-bbeb82.testnet`) |
| `ArcRail`, transfer | `arc-testnet` | `usdc` | ERC-20 `transfer` of USDC from the agent's key | `checkArcPayment`: USDC `Transfer` events in the receipt | works on Arc testnet |
| `ArcRail`, x402 `exact` | `arc-testnet` | `usdc` | signs an EIP-3009 `transferWithAuthorization` and sends nothing; the paywall settles it and pays the gas | `verifyAuthorization`, then `settleAuthorization` | works on Arc testnet, with the demo paywall as its own settler |
| `GatewayRail` | `arc-testnet-gateway` | `usdc` | signs a Circle Gateway authorization against USDC deposited in the Gateway Wallet; Circle settles in batches | `checkGatewayAuthorization`, then Circle Gateway's settle (`settleGatewayPayment`) | works on Arc testnet, no Circle account needed |
| `CircleWalletRail` | `arc-testnet` | `usdc` | a Circle developer-controlled wallet transfers or signs, so no private key sits in the agent's process | as for `ArcRail` | tested offline against Circle's SDK; not run against Circle yet, because that needs your Circle account. See [circle-wallets.md](circle-wallets.md) |
| Bitcoin Cash, Concordium | | `bch`, `ccd`, `pusd` | | | planned |

## The interface

```js
/**
 * @typedef {object} Rail
 * @property {string} network
 * @property {(intent: Intent) => Promise<Receipt>} pay
 * @property {(offer: object) => {asset: string, amount: bigint, payTo: string} | null} [terms]
 *   x402 v2 only: the offers this rail claims for itself (GatewayRail). Without it, payingFetch
 *   gives the rail 'exact' offers in known tokens on its network.
 *
 * @typedef {object} Receipt
 * @property {string} network
 * @property {string} [txid]  A signed payment has none until the paywall reports its settlement.
 * @property {object} proof  The x402 payload: sent in PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1).
 */
```

The intent a rail gets carries the offer it is paying: `intent.offer` as the server sent it, and `intent.x402` read the same way for x402 v1 and v2 (CAIP-2 network, bigint amount, checksummed payee). A rail that signs uses them only for the scheme's details. The payee and the amount always come from the intent, which is what the guard approved.

Rails are imported from their own entry points, so an agent that pays only in USDC does not load the NEAR SDK, and one that never uses Circle does not load Circle's:

```js
import { MockRail } from '@vulinh1704/spend-guard/rails/mock';
import { NearRail, NearGuardRail, checkNearPayment } from '@vulinh1704/spend-guard/rails/near';
import { ArcRail, checkArcPayment, arcTestnet, ARC_USDC, ARC_USDC_DOMAIN } from '@vulinh1704/spend-guard/rails/arc';
import { signAuthorization, verifyAuthorization, settleAuthorization } from '@vulinh1704/spend-guard/rails/eip3009';
import { GatewayRail, gatewayOffer, checkGatewayAuthorization, settleGatewayPayment } from '@vulinh1704/spend-guard/rails/gateway';
import { CircleWalletRail, circleWalletRailFromEnv } from '@vulinh1704/spend-guard/rails/circle-wallet';
```

## Mock

`new MockRail(network)` records what it was asked to pay in `rail.paid` and returns a random txid. Its proof carries `payTo`, `amount` and `asset`, so the demo paywall checks it with a plain comparison. Use it in tests and offline demos. It moves no money.

## NEAR

```js
const rail = new NearRail({ accountId: process.env.NEAR_ACCOUNT_ID, privateKey: process.env.NEAR_PRIVATE_KEY });
```

- Pays native NEAR (`asset: 'near'`, 24 decimals) with a transfer from `accountId`, and refuses any other asset.
- Keeps the id of the transaction it signed. If sending fails after that (an RPC timeout, say), it throws `PaymentUnconfirmed` with that id, and the guard records the payment as `unconfirmed`, counted against the budget. A failure on chain is a plain `failed`.
- Proof: `{ txid, sender }`.
- `checkNearPayment(provider, proof, { payTo, amount })` is the paywall's side. It reads the transaction with all its receipts from the chain (`EXPERIMENTAL_tx_status`), checks that `sender` signed it, and adds up the transfers to `payTo` that succeeded, which must come to at least `amount`. Gas refunds don't count.
- RPC: `https://test.rpc.fastnear.com` for `near-testnet`. Pass `provider` to use another one.
- Setup: `scripts/near-testnet-account.js` (agent account from the testnet faucet) and `scripts/near-demo-payees.js`.
- The agent's account signs with a full-access key, because a function-call key can't send a transfer. Code that holds that key can pay without the guard. `NearGuardRail` closes that.

## NEAR guard contract

```js
const rail = new NearGuardRail({ guardId: process.env.NEAR_GUARD_ID, privateKey: process.env.NEAR_GUARD_AGENT_KEY });
```

The agent's NEAR sits in a small contract, `contracts/near-guard` (Rust, near-sdk 5), on its own account. The agent holds only a function-call key on that account, which may call `pay` on it and nothing else. The owner's key stays with the owner.

- `pay(receiver, amount)` pays only accounts on the owner's allowlist, at most `per_payment_cap` per payment and at most `daily_cap` per UTC day. Otherwise the call fails with the reason, such as `rnaps.sg-paywall-25135e.testnet is not on the allowlist`, and no NEAR moves. The transfer's callback, `on_pay_done`, gives the day's budget back when the transfer itself failed.
- `allow`, `disallow`, `set_caps`, `set_paused` and `withdraw` are for the owner only, and each needs exactly 1 yoctoNEAR attached. A function-call key can't attach a deposit, so the agent's key can't call them even if the method list allowed it.
- `get_policy` is a view call: owner, allowlist, caps, what is spent and left today, paused, and the balance available to pay.
- The rail sends `pay` with no deposit and `GUARD_PAY_GAS` (30 Tgas). A refusal throws `the guard contract refused: <reason>`, recorded as `failed`. A transfer that fails inside `pay` (a payee account that doesn't exist, say) throws too, since the contract got the NEAR back. As with `NearRail`, an error after signing throws `PaymentUnconfirmed`.
- Proof: `{ txid, sender }`, where `sender` is the guard account, which signed the call. The paywall's `checkNearPayment` finds the contract's transfer among the call's receipts. It doesn't trust the call's own status, because `pay` succeeds and returns `false` when its transfer fails.
- The off-chain guard still decides first: price spikes, unknown services and a person's Approve. The contract is the hard limit under it, and it holds against someone who steals the agent's key and goes straight to the chain.
- Limits: the key's gas allowance is charged to the guard's balance, so a stolen key can also spend that much on gas. The owner's full-access key on the guard account can redeploy the contract. The caps are in NEAR, and the off-chain guard's limits are in dollars.
- Setup: `scripts/near-guard-deploy.js` creates `guard.<your account>`, deploys the committed wasm (`contracts/near-guard/res`, with its sha256), calls `new()` with the allowlist and caps and adds the agent's key. `scripts/near-guard-stolen-key.js` plays someone who stole that key. In the MCP server it is `SPEND_GUARD_RAILS=near-guard`.

## Arc (USDC)

```js
const rail = new ArcRail({ privateKey: process.env.ARC_PRIVATE_KEY });
```

- Pays USDC on Circle's Arc testnet (chain id `5042002`, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`) with an ERC-20 `transfer` on the USDC contract at `0x3600000000000000000000000000000000000000` (6 decimals). It refuses any asset but `usdc`.
- Signs the transfer before sending it, so its hash is known. An error after sending, or no receipt, throws `PaymentUnconfirmed`: the money may have left, so the guard records `unconfirmed` and counts it. A reverted transfer throws a plain error (`failed`).
- Proof: `{ txid, sender }`.
- `checkArcPayment(publicClient, proof, { payTo, amount })` is the paywall's side. It reads the receipt's USDC `Transfer` events from `sender` to `payTo` and adds them up, so a made-up proof gets nothing. Like `checkNearPayment`, it does not check who sends the proof or how old the transfer is, so the paywall must accept each txid once. See the [known gaps](threat-model.md#known-gaps). Arc's RPC finds a transaction by its hash in any letter case, and with or without its `0x`, so `checkArcPayment` takes only `0x` and 64 hex digits, and a paywall must compare txids lowercased: the demo paywall does.
- Gas on Arc is paid in USDC, from the same balance. The guard's budgets count the payment, not the gas.
- Given an x402 `exact` offer that names USDC's EIP-712 domain, the same rail signs instead of sending. See the next section.
- Setup: `scripts/arc-testnet-wallet.js` writes a fresh agent key and payee addresses to `.env`. Fund the agent with test USDC at https://faucet.circle.com (Arc Testnet).

## x402 `exact` on Arc (EIP-3009)

`payingFetch` speaks x402 v2 and v1. It reads the offer from the `PAYMENT-REQUIRED` header, or from a v1 JSON body, and sends the payment back in `PAYMENT-SIGNATURE` (v2, with the offer echoed verbatim as `accepted`) or `X-PAYMENT` (v1). For an `exact` offer on `eip155:5042002` that names USDC's EIP-712 domain (`USDC`, version `2`), `ArcRail` signs an EIP-3009 `transferWithAuthorization` and sends no transaction. The paywall, or a facilitator it trusts, submits it and pays the gas, so a $0.01 call costs the agent exactly $0.01.

- The guard decides before anything is signed, because the signature is the payment. It is recorded as `paid` when signed, and it still counts if settlement then fails, since the signature can be settled until it expires.
- The rail signs the payee and amount the guard approved, never the offer's own numbers, with a random 32-byte nonce and a validity of at most 120 seconds.
- It refuses to sign for another chain (the same key is valid on Arc mainnet, `eip155:5042`) or another token. An offer that names the token contract but not its domain, in v1 or v2, is refused before anything is signed or sent, because such a paywall settles only the signature and a transfer would not unlock it. Only the demo paywalls' v1 offers, which name the asset (`usdc`) instead of a contract, are paid by transfer (`takesTransfer` in `src/x402.js`). An offer whose domain names another contract, such as Circle Gateway's wallet, is left to the rail that knows that scheme.
- Offers in Permit2, delegation or escrow flows, and tokens the guard cannot price, are skipped. The error says why.
- The paywall's side is in `src/rails/eip3009.js`. `verifyAuthorization` checks the recipient, the exact value, the time window, an EOA signature with low `s`, an unused nonce and the payer's balance, and answers with x402's error codes. `settleAuthorization` simulates, submits, and succeeds only on the token's own `Transfer` log. The demo paywall does this itself when given its `exact` option. `scripts/arc-facilitator.js` creates its settling key in `.env` and funds it with a little test USDC for gas.
- The paywall's `PAYMENT-RESPONSE` names the settlement transaction. The ledger appends it as a `settled` line naming the paid entry, and the dashboard turns the row into a link.
- Only EOA payers are verified. Smart-wallet signatures (ERC-1271, ERC-6492) are not accepted yet.

## Circle Gateway nanopayments

```js
const rail = new GatewayRail({ privateKey: process.env.ARC_PRIVATE_KEY });
```

`GatewayRail` pays from USDC the agent deposited once into Circle's Gateway Wallet on Arc testnet. Each call is an off-chain authorization under the Gateway Wallet's EIP-712 domain (`GatewayWalletBatched`), and Circle settles many of them on Arc in one batch transaction. There is no gas and no transaction per call, and no Circle account or API key on testnet.

- `terms(offer)` claims only Gateway offers: scheme `exact`, `extra.name` `GatewayWalletBatched` with version 1 or 2, USDC on `eip155:5042002`, and `extra.verifyingContract` equal to Circle's Gateway Wallet. `payingFetch` asks such rails first, so a Gateway offer never reaches `ArcRail`.
- Gateway only settles authorizations valid for at least 7 days, so the rail signs the shortest validity Gateway accepts, whatever the paywall asks for. The guard counts each signature as spent.
- It refuses to sign what the Gateway balance cannot cover, counting what it signed that Gateway has not settled yet, so no authorization waits for a later deposit to pay it out. That count is kept in memory and starts from zero after a restart.
- The receipt's `txid` is the authorization nonce. `gatewayTransferUrl(nonce)` is Gateway's public record of the payment, which shows the batch's Arc transaction once it lands. `rail.status(nonce)` returns the same record.
- The seller's side: `gatewayOffer` builds the offer, `checkGatewayAuthorization` checks the signature offline, and `settleGatewayPayment` asks Gateway's `/v1/x402/settle`. Serve only after settle succeeds: verify alone passes an unfunded payer. The demo seller is `demo/gateway-seller.js`.
- Setup: `node scripts/gateway-deposit.js 1` (approve and deposit, two Arc transactions), then `node demo/agent.js --gateway`. `node scripts/gateway-status.js` lists the payments and their batch transactions.

## Circle Wallets

`CircleWalletRail` pays from a Circle developer-controlled wallet on Arc testnet. Circle holds the key (MPC) and signs on request, so the agent's process has an API key and an entity secret but no private key. The rail transfers USDC through Circle, or, for an x402 `exact` offer, has Circle sign the EIP-3009 authorization. Its domain is pinned to Arc testnet USDC, and every signature is recovered and compared with the wallet before use. A transfer whose outcome Circle does not report in time throws `PaymentPending` and is recorded as `unconfirmed`.

It is tested offline, including Circle's real SDK against a local stand-in for Circle's API. It has not run against Circle itself, because that needs your Circle account, API key and entity secret. See [circle-wallets.md](circle-wallets.md) for the setup and for how Circle's own controls and Spend Guard's fit together.

## Writing a rail

- Handle one network per rail, and set `network` to the id the policies use.
- Check `intent.asset` and throw for anything the rail cannot pay. Never convert.
- Throw when the payment fails and nothing left: the guard records it as `failed` and passes the error on. When money may have left but the rail can't tell, throw `PaymentPending` (or `PaymentUnconfirmed` with the transaction hash). The guard records it as `unconfirmed` and counts it against the budget.
- Return a proof the paywall can check on its own, usually the transaction id and the sender. Also write the paywall-side check (`check<Name>Payment`) so servers can verify without trusting the client.
- A rail that signs pays the intent's payee and amount, never the offer's, and pins the chain and token it signs for.
- Never call `rail.pay` from anywhere but the guard. A rail has no policy of its own.
- Keep only what the agent may spend in the rail's account. The guard limits what it pays. A small balance limits what a bug could lose.
