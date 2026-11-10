# NEAR testnet runs, recorded

These are real runs of the demo on NEAR testnet. Anyone can check them without a key or an account:

```
node scripts/near-verify.js
```

The script reads the JSON block at the end of this page. It fetches each transaction with its receipts from a public archival RPC (a regular RPC node forgets transactions after a few days) and runs the same check the demo paywall runs before it serves data (`nearPaymentProblem` in `src/rails/near.js`). It also reads the balances listed there, and checks that each one is still what this page says. For the guard contract, it checks that the code on chain is the committed `contracts/near-guard/res/spend_guard_near.wasm` (same sha256), that its policy is the one below, that the refused calls failed with the contract's own reason, and that the agent's key on the guard account may only call `pay()`. It prints one line per check and exits with 1 if any check fails.

## `node demo/agent.js --near`, 30 Oct 2026, 17:49 UTC

Agent account `spend-guard-bbeb82.testnet`, which signs with a full-access key. Demo paywall `sg-paywall-25135e.testnet`. Prices are in dollars, converted at the demo's fixed $2.50 per NEAR.

| Call | Paid to | testnet NEAR | Transaction |
|---|---|---|---|
| `/weather` $0.01 | `weather.sg-paywall-25135e.testnet` | 0.004 | [`G2AbHz2Z…`](https://testnet.nearblocks.io/txns/G2AbHz2ZFcuTBuVSgFJYpXnMK9Uhh1Mvzm7tUgCBaPGB) |
| `/news` $0.02 | `news.sg-paywall-25135e.testnet` | 0.008 | [`GMkwi61c…`](https://testnet.nearblocks.io/txns/GMkwi61c14WkZwmdNTC14oTdC9hf4UU8MLrtkw8i2Dz) |
| `/quotes` $0.01 | `quotes.sg-paywall-25135e.testnet` | 0.004 | [`GwRVPQo9…`](https://testnet.nearblocks.io/txns/GwRVPQo9jWovtNcn4nR5ss76p3ukEaYU8h7b5X5GywbW) |
| `/quotes` $0.01 | `quotes.sg-paywall-25135e.testnet` | 0.004 | [`XMGPxvnh…`](https://testnet.nearblocks.io/txns/XMGPxvnhxxmAKTBbpvenNiRNv51zgb3EDXvkmohHLhu) |
| `/quotes` $0.01 | `quotes.sg-paywall-25135e.testnet` | 0.004 | [`A2ujrR5R…`](https://testnet.nearblocks.io/txns/A2ujrR5RAeuAdAw92yB2fnzwNmVieJfc2oM9kQT41h5f) |
| `/quotes` $0.40 | refused before signing: 40x the usual price | | none |
| `/maps` $0.015 | `maps.sg-paywall-25135e.testnet` | 0.006 | [`7vVpQaZw…`](https://testnet.nearblocks.io/txns/7vVpQaZwtJojWDJChoZDge4v61CA21h3S2sFiHvkqu4B) |
| `/maps` $0.015 | `maps.sg-paywall-25135e.testnet` | 0.006 | [`7EHuuhjK…`](https://testnet.nearblocks.io/txns/7EHuuhjKDRiZwDJedeXo7GBrkE7RrsFyA2HVHNkKn7xH) |
| `/maps` $0.015 | refused before signing: the look-alike `rnaps.sg-paywall-25135e.testnet` | | none |
| `/weather` $0.01 | `weather.sg-paywall-25135e.testnet` | 0.004 | [`GujNUwRx…`](https://testnet.nearblocks.io/txns/GujNUwRx2LnTtaer8EoTF6y3K6PWJtgCkPeMyEAAhkvi) |
| `/report` $0.30 | declined: nobody pressed Approve | | none |

Eight transfers, 0.04 testnet NEAR in all. A refused payment leaves nothing on chain to look up, so the check for the look-alike payee is its balance: `rnaps.sg-paywall-25135e.testnet` still holds exactly the 0.05 NEAR it was created with.

The same agent ran the demo once before, at 10:49 UTC on the same day, with the same result. Those eight transfers are on the agent's page on [NearBlocks](https://testnet.nearblocks.io/address/spend-guard-bbeb82.testnet).

## The guard contract, deployed 10 Nov 2026, 03:46 UTC

`node scripts/near-guard-deploy.js` created `guard.spend-guard-bbeb82.testnet` with 2.5 testnet NEAR from `spend-guard-bbeb82.testnet`, which is the owner ([`7j6muV37…`](https://testnet.nearblocks.io/txns/7j6muV37Np84L9N8YuSS1p9eJGxmaag8tE5dNxpXk88p)). One transaction signed by the guard account then deployed the wasm, called `new()` and added the agent's function-call key ([`BXmtwnFa…`](https://testnet.nearblocks.io/txns/BXmtwnFao1kE57wHq5u4u6RHMwoPcpDwtKL8wR9QULJd)).

- Allowlist: `weather.`, `news.`, `quotes.` and `maps.sg-paywall-25135e.testnet`. Not `rnaps.`.
- Caps: 0.15 NEAR per payment, 0.25 NEAR per UTC day.
- Agent key `ed25519:3rU4oZyq9ZTSynaxeJ5haLR2Fwm3Uh3jD2muvtXr5uz8`: may call `pay` on the guard account and nothing else, with 0.25 NEAR of gas allowance.

### `node demo/agent.js --near-guard`, 10 Nov 2026, 03:46 UTC

The same scripted agent and paywall as above, but the agent signs only `pay()` calls on the guard, and the guard contract makes each transfer. The off-chain guard refused the price spike and the look-alike payee before anything was signed, as in the plain run. The paywall checked each payment by the transfer receipt inside the transaction.

| Call | Paid to | testnet NEAR | Transaction |
|---|---|---|---|
| `/weather` | `weather.` | 0.004 | [`61ZDKuUN…`](https://testnet.nearblocks.io/txns/61ZDKuUNvmyarLoZsY3M4KibCVoDq2ZT77bgc6Y8AtgG) |
| `/news` | `news.` | 0.008 | [`9z9cUYvK…`](https://testnet.nearblocks.io/txns/9z9cUYvKEYAQ5PqXsRFgAqq6dZ928bWEYxbDbt9ofmpL) |
| `/quotes` | `quotes.` | 0.004 | [`7nF5Qgvm…`](https://testnet.nearblocks.io/txns/7nF5Qgvmc1dCccmkxMGZX3895dMS4APWnQfxTCJWRhUq) |
| `/quotes` | `quotes.` | 0.004 | [`GoXbsdoJ…`](https://testnet.nearblocks.io/txns/GoXbsdoJUskqEtHhx9txEwtUG6rm3KUh3f1P9n2zjjee) |
| `/quotes` | `quotes.` | 0.004 | [`9qN3YHCn…`](https://testnet.nearblocks.io/txns/9qN3YHCnapi9Z6pS8wQ41284EGez6kMiWi7A48e7PvXt) |
| `/maps` | `maps.` | 0.006 | [`6DZB6izo…`](https://testnet.nearblocks.io/txns/6DZB6izov3BnGA4PtB6GJhRqArQXNKDbbUzGMTtv3c8i) |
| `/maps` | `maps.` | 0.006 | [`7G9pSzGg…`](https://testnet.nearblocks.io/txns/7G9pSzGgjGCNEnkoSFYfbMnMrKqwMm2ELCz8jYKaaf8o) |
| `/weather` | `weather.` | 0.004 | [`3pJiBu2L…`](https://testnet.nearblocks.io/txns/3pJiBu2LZex3F3bZ3Rc8EwVKR45DweqhaKjzGBm66MFE) |

The demo's last line was `guard contract 2.498494 → 2.455223 NEAR (-0.043271: 0.040000 paid, 0.003271 gas)`. The agent key's gas is charged to the guard account.

### `node scripts/near-guard-stolen-key.js`, 10 Nov 2026, 03:47 UTC

This script signs with the agent's key alone and goes straight to the chain, past the off-chain guard, the paywall and the dashboard. That is what someone who stole the key could do.

| Attempt | Result | Transaction |
|---|---|---|
| `pay` 0.01 NEAR to `rnaps.sg-paywall-25135e.testnet` | refused by the contract: `rnaps.sg-paywall-25135e.testnet is not on the allowlist` | [`BeMwBR9L…`](https://testnet.nearblocks.io/txns/BeMwBR9LYFu5y5zos1YJCRMsthTNi7praS1iRV6ybaEi) |
| `pay` `weather.` 1 yoctoNEAR over the per-payment cap | refused by the contract: `… is above the per-payment cap of 150000000000000000000000` | [`H9geFseW…`](https://testnet.nearblocks.io/txns/H9geFseWeP7z2C5Sqca73grsM1TfZTCZgv3zuSPB6wNX) |
| `pay` 0.15 NEAR to `weather.` | paid: allowed payee, within the caps | [`8M9TQcRP…`](https://testnet.nearblocks.io/txns/8M9TQcRPFegxxnbNbK1ykLa1GfxJZyG3nMbgzSN9btUV) |
| `pay` 0.06 NEAR to `weather.` | paid: that used the rest of the day's 0.25 NEAR | [`7uwjnL2r…`](https://testnet.nearblocks.io/txns/7uwjnL2rW9fQSao52zoGJiFxS1jHLmFnJycV1tpdHZNk) |
| `pay` 0.001 NEAR more to `weather.` | refused by the contract: `… would bring today's spending to 251000000000000000000000, above the daily cap of 250000000000000000000000` | [`EsNspDom…`](https://testnet.nearblocks.io/txns/EsNspDomuB5camR2kEtUyM7gP1GYQob9Wxe1nv6L9FE1) |
| a plain transfer to `rnaps.` | rejected by NEAR, never a transaction: `Access key requires full access` | none |
| `withdraw` from the guard | rejected by NEAR: `Access key does not allow method withdraw` | none |
| `pay` with a deposit attached | rejected by NEAR: `Deposit is not allowed with function call` (checked separately with 1 yoctoNEAR; the script's first run attached 1 NEAR and was rejected for going past the key's gas allowance) | none |
| add a full-access key to the guard account | rejected by NEAR: `Access key requires full access` | none |

So a stolen agent key could still pay the allowed accounts up to the day's cap: 0.21 NEAR here, on top of the demo's 0.04. It could not pay `rnaps.`, go past either cap, withdraw, or take over the account. Its gas allowance also bounds how much gas it can burn from the guard's balance.

## What the script checks

```json near-verify
{
  "network": "near-testnet",
  "payments": [
    {"hash": "G2AbHz2ZFcuTBuVSgFJYpXnMK9Uhh1Mvzm7tUgCBaPGB", "signer": "spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "GMkwi61c14WkZwmdNTC14oTdC9hf4UU8MLrtkw8i2Dz", "signer": "spend-guard-bbeb82.testnet", "payTo": "news.sg-paywall-25135e.testnet", "amount": "8000000000000000000000"},
    {"hash": "GwRVPQo9jWovtNcn4nR5ss76p3ukEaYU8h7b5X5GywbW", "signer": "spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "XMGPxvnhxxmAKTBbpvenNiRNv51zgb3EDXvkmohHLhu", "signer": "spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "A2ujrR5RAeuAdAw92yB2fnzwNmVieJfc2oM9kQT41h5f", "signer": "spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "7vVpQaZwtJojWDJChoZDge4v61CA21h3S2sFiHvkqu4B", "signer": "spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000"},
    {"hash": "7EHuuhjKDRiZwDJedeXo7GBrkE7RrsFyA2HVHNkKn7xH", "signer": "spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000"},
    {"hash": "GujNUwRx2LnTtaer8EoTF6y3K6PWJtgCkPeMyEAAhkvi", "signer": "spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "61ZDKuUNvmyarLoZsY3M4KibCVoDq2ZT77bgc6Y8AtgG", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "9z9cUYvKEYAQ5PqXsRFgAqq6dZ928bWEYxbDbt9ofmpL", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "news.sg-paywall-25135e.testnet", "amount": "8000000000000000000000"},
    {"hash": "7nF5Qgvmc1dCccmkxMGZX3895dMS4APWnQfxTCJWRhUq", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "GoXbsdoJUskqEtHhx9txEwtUG6rm3KUh3f1P9n2zjjee", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "9qN3YHCnapi9Z6pS8wQ41284EGez6kMiWi7A48e7PvXt", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "6DZB6izov3BnGA4PtB6GJhRqArQXNKDbbUzGMTtv3c8i", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000"},
    {"hash": "7G9pSzGgjGCNEnkoSFYfbMnMrKqwMm2ELCz8jYKaaf8o", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000"},
    {"hash": "3pJiBu2LZex3F3bZ3Rc8EwVKR45DweqhaKjzGBm66MFE", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "8M9TQcRPFegxxnbNbK1ykLa1GfxJZyG3nMbgzSN9btUV", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "150000000000000000000000"},
    {"hash": "7uwjnL2rW9fQSao52zoGJiFxS1jHLmFnJycV1tpdHZNk", "signer": "guard.spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "60000000000000000000000"}
  ],
  "refused": [
    {"hash": "BeMwBR9LYFu5y5zos1YJCRMsthTNi7praS1iRV6ybaEi", "signer": "guard.spend-guard-bbeb82.testnet", "reason": "rnaps.sg-paywall-25135e.testnet is not on the allowlist"},
    {"hash": "H9geFseWeP7z2C5Sqca73grsM1TfZTCZgv3zuSPB6wNX", "signer": "guard.spend-guard-bbeb82.testnet", "reason": "is above the per-payment cap of 150000000000000000000000"},
    {"hash": "EsNspDomuB5camR2kEtUyM7gP1GYQob9Wxe1nv6L9FE1", "signer": "guard.spend-guard-bbeb82.testnet", "reason": "above the daily cap of 250000000000000000000000"}
  ],
  "balances": [
    {"account": "rnaps.sg-paywall-25135e.testnet", "amount": "50000000000000000000000", "why": "the look-alike payee was never paid: it holds the 0.05 NEAR it was created with"}
  ],
  "guard": {
    "contract": "guard.spend-guard-bbeb82.testnet",
    "wasm": "contracts/near-guard/res/spend_guard_near.wasm",
    "agentKey": "ed25519:3rU4oZyq9ZTSynaxeJ5haLR2Fwm3Uh3jD2muvtXr5uz8",
    "allowed": [
      "weather.sg-paywall-25135e.testnet",
      "news.sg-paywall-25135e.testnet",
      "quotes.sg-paywall-25135e.testnet",
      "maps.sg-paywall-25135e.testnet"
    ],
    "notAllowed": [
      "rnaps.sg-paywall-25135e.testnet"
    ],
    "perPaymentCap": "150000000000000000000000",
    "dailyCap": "250000000000000000000000"
  }
}
```
