# Paying from a Circle wallet

`CircleWalletRail` (`src/rails/circle-wallet.js`) lets the agent pay from a Circle [developer-controlled wallet](https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet) on Arc testnet. Circle holds the key, split with MPC, and signs when asked. The agent's process has an API key and an entity secret, but no private key. Spend Guard still checks every payment before Circle is asked to send or sign anything.

```
agent ── payingFetch ── Guard ──────────────── CircleWalletRail ── Circle Wallets API ── Arc testnet USDC
                        budgets, payee list,   transfer: createTransaction + getTransaction
                        price spikes, human    authorization: signTypedData (EIP-3009)
                        approval, ledger
```

| Way to pay | Circle API | What the paywall gets | Who pays gas |
|---|---|---|---|
| `transfer` | `createTransaction` for USDC (token id `ef87c8c3-…`), then `getTransaction` until `COMPLETE` | The tx hash and the wallet address. The demo paywall checks the USDC `Transfer` log with `checkArcPayment`. | The Circle wallet, in USDC (about 0.0013 USDC for an EOA transfer) |
| `authorization` | `signTypedData` for an EIP-3009 `TransferWithAuthorization` | The x402 `exact` payload `{signature, authorization}`. Nothing is on chain until the paywall settles it. | The paywall's settler |
| `auto` (default) | Picks per payment: an x402 `exact` offer with USDC's EIP-712 domain is signed. No offer, or an x402 v1 offer without a domain (like the demo paywall's), is paid by transfer. Any other offer, such as a v2 `exact` offer without a domain or another scheme, is refused before Circle is asked, because a transfer would not unlock it. | | |

The rail signs the amount and payee the guard approved, never the numbers in the 402 response. The EIP-712 domain is pinned to Arc testnet USDC (`USDC`, version `2`, chain 5042002, `0x3600…0000`), and it hashes to the contract's `DOMAIN_SEPARATOR`. A paywall that asks for a signature on another chain or token is refused. This matters because the same address holds real money on Arc mainnet (`eip155:5042`). Every signature Circle returns is recovered and compared with the wallet address before it is used. An authorization is valid for at most 300 seconds, or less if the paywall's `maxTimeoutSeconds` is shorter.

## Set it up (testnet only)

Only you can do steps 1 to 3: they create an account and secrets. Edit `.env` in a text editor; don't paste the values into a shell, a chat or a commit. `.env` is git-ignored.

1. **Create a Circle developer account** at [console.circle.com](https://console.circle.com) and stay on testnet.
2. **Create a testnet API key.** In the Console, open *API & Client Keys* and create a *Standard* API key. Copy the whole string, which looks like `TEST_API_KEY:<key id>:<secret>`, and add it to `.env`:
   ```
   CIRCLE_API_KEY=TEST_API_KEY:...
   ```
   The rail refuses any key that doesn't start with `TEST_API_KEY:`.
3. **Create and register an entity secret.** This is a 32-byte secret, written as 64 hex characters. Circle uses it to authorize every signature from your wallets and never stores it.
   - Recommended: follow the steps in the Console's [entity secret configurator](https://console.circle.com/wallets/dev/configurator/entity-secret).
   - Or run Circle's [SDK registration script](https://developers.circle.com/wallets/dev-controlled/register-entity-secret#create-an-entity-secret-using-the-sdk) yourself.

   Either way you get a **recovery file, and you can download it only once.** It is the only way to reset the secret if you lose it. Store it outside the repo, for example in a password manager. `recovery/` and `recovery_file_*.dat` are git-ignored as a precaution. Then add the secret to `.env`:
   ```
   CIRCLE_ENTITY_SECRET=<64 hex characters>
   ```
4. **Create the wallet.** This needs Node 22 or later, because Circle's SDK does (Circle recommends 22.18+):
   ```
   node scripts/circle-wallet-setup.js
   ```
   The script creates a wallet set and one EOA wallet on `ARC-TESTNET`. It appends `CIRCLE_WALLET_SET_ID`, `CIRCLE_WALLET_ID` and `CIRCLE_WALLET_ADDRESS` to `.env` and prints the address. None of those values is secret, and the script never prints the key or the entity secret. Run it again to see the wallet and its balance. Wallets can't be deleted, so the script creates one only when `CIRCLE_WALLET_ID` is missing.
5. **Fund it with test USDC.** Use any one of these:
   - [faucet.circle.com](https://faucet.circle.com), network *Arc Testnet*, with the printed address.
   - `node scripts/circle-wallet-setup.js --faucet`, which uses Circle's faucet API.
   - `node scripts/circle-wallet-setup.js --fund 2`, which sends 2 test USDC from the existing Arc demo key (`ARC_PRIVATE_KEY`). The script accepts at most 5.
6. **Check it end to end:**
   ```
   node scripts/circle-wallet-setup.js --sign   # Circle signs an EIP-3009 authorization; Arc USDC checks it with eth_call, nothing is sent
   node scripts/circle-wallet-setup.js --pay    # one $0.01 payment to the demo paywall's /weather, through the guard
   ```
   `--pay` needs the demo payees from `node scripts/arc-testnet-wallet.js`. It prints the Circle transaction id and the ArcScan link.

| Variable | Secret | Set by |
|---|---|---|
| `CIRCLE_API_KEY` | yes | you (step 2) |
| `CIRCLE_ENTITY_SECRET` | yes | you (step 3) |
| `CIRCLE_WALLET_SET_ID`, `CIRCLE_WALLET_ID`, `CIRCLE_WALLET_ADDRESS` | no | `scripts/circle-wallet-setup.js` |

## Use it in code

```js
import { Guard, payingFetch } from 'spend-guard';
import { circleWalletRailFromEnv } from 'spend-guard/src/rails/circle-wallet.js';

// Checks with Circle that CIRCLE_WALLET_ID is a live ARC-TESTNET wallet (and matches CIRCLE_WALLET_ADDRESS).
const rail = await circleWalletRailFromEnv(process.env); // { mode: 'transfer' | 'authorization' } to force one way
const guard = new Guard({
  policy: { networks: ['arc-testnet'], dailyUsd: 5, perPaymentUsd: 1, askAboveUsd: 0.25, services: { 'api.example.com': { payTo: ['0x…'] } } },
  rails: [rail],
});
const res = await payingFetch(guard, 'https://api.example.com/data');
```

The rail uses the network name `arc-testnet`, the same as `ArcRail`, so it takes `ArcRail`'s place: the policy, the paywall check and the dashboard stay the same. The Circle transaction id is kept in the ledger entry's receipt (`receipt.circle.transactionId`).

## What Circle enforces, and what Spend Guard adds

Circle's controls and Spend Guard's work at different layers, so they add up:

| | Circle developer-controlled wallets | Circle Agent Wallets | Spend Guard |
|---|---|---|---|
| Who holds the key | Circle (MPC) | Circle and the user (2-of-2 MPC) | the rail; with this rail, Circle |
| Spending limits | none | per-transaction, daily, weekly and monthly USDC caps | per payment, per day, per service |
| Recipient rules | Compliance Engine watchlists (allow and block lists), sanctions screening | recipient and contract allow and block lists | payee allowlist per service, so a swapped or look-alike address is refused |
| Price awareness | none | none | price spike per endpoint, compared with what it usually costs |
| Human in the loop | none | an email OTP when the limits change | approval for flagged payments, with the reasons |
| Knows the x402 request | no | no | yes: resource URL, host, offered terms |
| Where it runs | testnet and mainnet | mainnet only, configured through the Circle CLI | before Circle is asked, on any network |

Circle's own guide to retiring wallets says to use the Compliance Engine "or enforce equivalent rules in your own backend before submitting transactions." Spend Guard is that backend layer for agents that pay x402 paywalls. Circle provides custody and screening, and its `DENIED` result still applies after Spend Guard has said yes. A transfer that Circle's screening denies is recorded in the ledger as `failed`, with Circle's reason.

## Limits and open points

- **No live run yet.** The rail and the setup script are tested offline, including against Circle's real SDK talking to a local stand-in for Circle's API (`test/circle-wallet.test.js`). Nothing has run against Circle itself, because that needs your account (steps 1 to 3).
- **To confirm on the first live run:** the exact signature format `signTypedData` returns (the rail adds a missing `0x`, rewrites v as 27/28 and s as low s, which USDC's `ECRecover` requires, and verifies every signature by recovery), the length limits for `memo` and `refId` (the rail keeps the memo under 100 characters), the faucet API's rate limits, and how the default testnet screening rules behave.
- **Authorization mode needs a paywall that settles EIP-3009.** That means an x402 v2 `exact` paywall, or Circle's Facilitator Service, which supports Arc testnet. Today's demo paywall checks transfers only, which is why `--pay` uses a transfer.
- **A transfer that is still pending after `timeoutMs`** (default 120 s) is recorded as `failed`, but it can still complete. The error names the Circle transaction id, so check it in the Console before paying again. `ArcRail` has the same gap while it waits for a receipt.
- **EOA wallets only for signing.** A smart-contract (SCA) wallet signs with ERC-1271, and the rail's recovery check would refuse that. A later step could use SCA wallets with Gas Station, so transfers need no gas.
