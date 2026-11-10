# NEAR testnet runs, recorded

These are real runs of the demo on NEAR testnet. Anyone can check them without a key or an account:

```
node scripts/near-verify.js
```

The script reads the JSON block at the end of this page. It fetches each transaction with its receipts from a public archival RPC (a regular RPC node forgets transactions after a few days) and runs the same check the demo paywall runs before it serves data (`nearPaymentProblem` in `src/rails/near.js`). It also reads the balances listed there, and checks that each one is still what this page says. It prints one line per check and exits with 1 if any check fails.

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

## What the script checks

```json near-verify
{
  "network": "near-testnet",
  "payments": [
    { "hash": "G2AbHz2ZFcuTBuVSgFJYpXnMK9Uhh1Mvzm7tUgCBaPGB", "signer": "spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000" },
    { "hash": "GMkwi61c14WkZwmdNTC14oTdC9hf4UU8MLrtkw8i2Dz", "signer": "spend-guard-bbeb82.testnet", "payTo": "news.sg-paywall-25135e.testnet", "amount": "8000000000000000000000" },
    { "hash": "GwRVPQo9jWovtNcn4nR5ss76p3ukEaYU8h7b5X5GywbW", "signer": "spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000" },
    { "hash": "XMGPxvnhxxmAKTBbpvenNiRNv51zgb3EDXvkmohHLhu", "signer": "spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000" },
    { "hash": "A2ujrR5RAeuAdAw92yB2fnzwNmVieJfc2oM9kQT41h5f", "signer": "spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000" },
    { "hash": "7vVpQaZwtJojWDJChoZDge4v61CA21h3S2sFiHvkqu4B", "signer": "spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000" },
    { "hash": "7EHuuhjKDRiZwDJedeXo7GBrkE7RrsFyA2HVHNkKn7xH", "signer": "spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000" },
    { "hash": "GujNUwRx2LnTtaer8EoTF6y3K6PWJtgCkPeMyEAAhkvi", "signer": "spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000" }
  ],
  "balances": [
    { "account": "rnaps.sg-paywall-25135e.testnet", "amount": "50000000000000000000000", "why": "the look-alike payee was never paid: it holds the 0.05 NEAR it was created with" }
  ]
}
```
