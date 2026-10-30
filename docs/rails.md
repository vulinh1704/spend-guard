# Rails

A rail moves money on one network. The guard is its only caller: it decides, the rail pays.

| Rail | Network id | Asset | How it pays | What the paywall checks | Status |
|---|---|---|---|---|---|
| `MockRail` | any you pass | any | nothing moves | payee and amount in the proof | works (tests, offline demo) |
| `NearRail` | `near-testnet` | `near` | native NEAR transfer from the agent's account | `checkNearPayment`: receiver and deposit of the transaction | works on NEAR testnet |
| `ArcRail` | `arc-testnet` | `usdc` | ERC-20 `transfer` of USDC from the agent's key | `checkArcPayment`: USDC `Transfer` events in the receipt | works on Arc testnet |
| x402 `exact` (EIP-3009) | `arc-testnet` | `usdc` | the agent signs a USDC `transferWithAuthorization`; the paywall or a facilitator submits it | the signed authorization, then the settled transfer | in progress |
| Circle Gateway | | `usdc` | pays from a USDC balance held in Circle Gateway | | in progress |
| Circle Wallets | `arc-testnet` | `usdc` | a Circle developer-controlled wallet signs, so no private key sits in the agent's process | as for `ArcRail` | in progress, see [circle-wallets.md](circle-wallets.md) |
| Bitcoin Cash, Concordium | | `bch`, `ccd`, `pusd` | | | planned |

"In progress" means the work is on a branch for 0.2.0 and not on `main` yet. The [CHANGELOG](../CHANGELOG.md) says when each one lands.

## The interface

```js
/**
 * @typedef {object} Rail
 * @property {string} network
 * @property {(intent: Intent) => Promise<Receipt>} pay
 *
 * @typedef {object} Receipt
 * @property {string} network
 * @property {string} txid
 * @property {object} proof  What the paywall needs to see (sent in X-PAYMENT).
 */
```

Rails are imported from their own entry points, so an agent that pays only in USDC does not load the NEAR SDK:

```js
import { MockRail } from '@vulinh1704/spend-guard/rails/mock';
import { NearRail, checkNearPayment } from '@vulinh1704/spend-guard/rails/near';
import { ArcRail, checkArcPayment, arcTestnet, ARC_USDC } from '@vulinh1704/spend-guard/rails/arc';
```

## Mock

`new MockRail(network)` records what it was asked to pay in `rail.paid` and returns a random txid. Its proof carries `payTo`, `amount` and `asset`, so the demo paywall checks it with a plain comparison. Use it in tests and offline demos. It moves no money.

## NEAR

```js
const rail = new NearRail({ accountId: process.env.NEAR_ACCOUNT_ID, privateKey: process.env.NEAR_PRIVATE_KEY });
```

- Pays native NEAR (`asset: 'near'`, 24 decimals) with a transfer from `accountId`, and refuses any other asset.
- Proof: `{ txid, sender }`.
- `checkNearPayment(provider, proof, { payTo, amount })` is the paywall's side. It reads the transaction from the chain and checks that it succeeded, went to `payTo` and deposited at least `amount`.
- RPC: `https://test.rpc.fastnear.com` for `near-testnet`. Pass `provider` to use another one.
- Setup: `scripts/near-testnet-account.js` (agent account from the testnet faucet) and `scripts/near-demo-payees.js`.

## Arc (USDC)

```js
const rail = new ArcRail({ privateKey: process.env.ARC_PRIVATE_KEY });
```

- Pays USDC on Circle's Arc testnet (chain id `5042002`, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`) with an ERC-20 `transfer` on the USDC contract at `0x3600000000000000000000000000000000000000` (6 decimals). It refuses any asset but `usdc`.
- Waits for the receipt and throws if the transfer reverted.
- Proof: `{ txid, sender }`.
- `checkArcPayment(publicClient, proof, { payTo, amount })` is the paywall's side. It reads the receipt's USDC `Transfer` events from `sender` to `payTo` and adds them up, so a forged proof gets nothing.
- Gas on Arc is paid in USDC, from the same balance. The guard's budgets count the payment, not the gas.
- Setup: `scripts/arc-testnet-wallet.js` writes a fresh agent key and payee addresses to `.env`. Fund the agent with test USDC at https://faucet.circle.com (Arc Testnet).

## x402 `exact` on Arc (in progress)

The standard x402 `exact` scheme for EVM chains: instead of sending a transaction, the agent signs an EIP-3009 `transferWithAuthorization` for USDC and puts it in `X-PAYMENT`. The paywall, or a facilitator it trusts, submits it and pays the gas. Arc testnet USDC supports EIP-3009 (EIP-712 domain name `USDC`, version `2`). The guard still decides before anything is signed.

## Circle Gateway (in progress)

A rail that pays from a USDC balance held in Circle Gateway instead of a wallet on one chain. Details land with the rail.

## Circle Wallets (in progress)

A rail backed by a Circle developer-controlled wallet. Circle holds the key and signs on request, so the agent's process never sees a private key. See [circle-wallets.md](circle-wallets.md).

## Writing a rail

- Handle one network per rail, and set `network` to the id the paywalls use.
- Check `intent.asset` and throw for anything the rail cannot pay. Never convert.
- Throw when the payment fails. The guard records it as `failed` and passes the error on.
- Return a proof the paywall can check on its own, usually the transaction id and the sender. Also write the paywall-side check (`check<Name>Payment`) so servers can verify without trusting the client.
- Never call `rail.pay` from anywhere but the guard. A rail has no policy of its own.
- Keep only what the agent may spend in the rail's account. The guard limits what it pays. A small balance limits what a bug could lose.
