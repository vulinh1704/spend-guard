# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## 0.2.0 - Unreleased

On `main`, not published to npm yet.

### Added

- x402 v2: `payingFetch` reads the `PAYMENT-REQUIRED` header (falling back to a v1 body), answers with `PAYMENT-SIGNATURE` and the offer echoed as `accepted`, records the paywall's `PAYMENT-RESPONSE` on the paid entry, and never pays twice for one request. New helpers: `readPaymentRequired`, `pickOffer`, `networkName`, `caip2`, `assetKey`.
- x402 `exact` on Arc: `ArcRail` signs an EIP-3009 `transferWithAuthorization` for USDC instead of sending a transfer, for the approved payee and amount only, valid for 120 seconds at most. Paywall side in `rails/eip3009`: `verifyAuthorization` and `settleAuthorization`. The demo paywall settles it itself (`createPaidApi({ exact })`, `node demo/agent.js --arc-x402`, `scripts/arc-facilitator.js`).
- Circle Gateway rail (`rails/gateway`): nanopayments from a USDC deposit in Circle's Gateway Wallet on Arc testnet, settled by Circle in batches. Seller helpers `gatewayOffer`, `checkGatewayAuthorization`, `settleGatewayPayment`; demo seller `demo/gateway-seller.js`; `node demo/agent.js --gateway`; `scripts/gateway-deposit.js` and `scripts/gateway-status.js`.
- Circle Wallets rail (`rails/circle-wallet`): pays from a Circle developer-controlled wallet, so no private key sits in the agent's process. Transfers, or EIP-3009 signatures through Circle. `scripts/circle-wallet-setup.js` and [docs/circle-wallets.md](docs/circle-wallets.md). Tested offline only; a live run needs your Circle account.
- MCP server: `spend-guard mcp` gives an MCP client `pay_and_fetch`, `spending_status` and `spending_policy`. Rails `mock`, `near`, `arc` and `gateway`. A cancelled call never pays. The ledger is read back on start and shared between servers.
- Approvals: `Approvals` queues flagged payments for an explicit yes, and the dashboard shows each one with Approve and Deny buttons and a countdown. A payment that waits for a human no longer holds up the others, and is checked again after the yes.
- `PaymentPending` and `PaymentUnconfirmed`: a rail that can't tell whether money left throws one, and the guard records the payment as `unconfirmed` and counts it against the budget. `ArcRail` and `NearRail` sign before they send, so a transfer that was sent but not confirmed keeps its hash.
- The dashboard links a signed payment to its settlement transaction once the paywall reports it.
- npm package `@vulinh1704/spend-guard`. The unscoped name `spend-guard` cannot be used on npm because it differs from the existing, unrelated `spendguard` package only by punctuation.
- Rail entry points: `@vulinh1704/spend-guard/rails/<name>`, so an agent loads only the SDK of the chain it pays on.
- Package metadata: `files` whitelist (`src/`, `bin/` and the dashboard ship), `sideEffects: false`, `engines.node >=20.19.0`, and the `spend-guard` command.
- CI on GitHub Actions: tests on Node 20, 22 and 24, plus the offline demo, which must still stop the price spike and the payee swap and ask before the large payment.
- Docs: [architecture](docs/architecture.md), [policy reference](docs/policy.md), [rails](docs/rails.md) and [threat model](docs/threat-model.md); [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
- The demo paywall has a `/report` endpoint ($0.30) that is honest but needs approval.

### Changed

- Deep imports such as `spend-guard/src/rails/near.js` no longer resolve, because the package now has an `exports` map. Import `@vulinh1704/spend-guard/rails/near` instead.
- With a file, the ledger reads back what other processes appended before each decision, so a restart keeps today's spend and servers on one file share one budget. Each entry has an `id`.
- `Guard.pay(intent, { signal })` is async and takes an abort signal: a payment not made by the time it aborts is not made. The `approve` callback gets the signal too.
- EVM payee addresses match the allowlist in any letter case. Other addresses still match exactly.
- The dashboard answers on localhost names only.

### Fixed

- The demo paywall takes a txid before it checks the payment on chain, so the same proof sent twice at once buys one call, not two.
- A transfer that was sent but whose confirmation failed was recorded as `failed` and not counted against the budget.
- A payment that went out was recorded a second time as `failed` when its ledger line could not be written or an `entry` listener threw, and `pay_and_fetch` told the agent that nothing was paid. It now stays `paid` and the agent gets the response. A line the file can't take waits, and nothing more is paid until the file has it.
- An x402 v1 `exact` offer that named Arc's USDC contract but no EIP-712 domain was paid by plain transfer (`ArcRail`, and `CircleWalletRail` in `auto`). Such a paywall settles only the signed authorization, so the money left and the agent still got a 402. Now only the demo paywalls' v1 offers, which name the asset instead of a contract, are paid by transfer; other offers without a domain are refused before anything is signed or sent.
- `CircleWalletRail` in mode `transfer` ignored the paywall's offer and paid an x402 `exact` offer by transfer, which the paywall keeps while still answering 402; each retry paid again. It now refuses any offer that wants a signature before Circle is asked.

## 0.1.0 - 2026-10-30

First version, on `main`. Not published to npm.

### Added

- `Guard`: checks every payment against the policy, asks a human through an `approve` callback when the policy says so, pays through the rail for the payment's network, records every outcome (`paid`, `denied`, `declined`, `failed`) and emits it as an `entry` event. Payments run one at a time, so parallel calls cannot race the daily budget.
- Policy rules, each with a reason code: `network`, `unknown-service`, `payee-swap`, `service-cap`, `per-payment`, `daily-budget`, `price-spike` (against the endpoint's median price) and `large-payment`. A refusal lists every rule that fired.
- Integer money: amounts as bigint atomic units, limits compared in micro-dollars. Assets `usdc`, `pusd`, `near`, `bch`, `ccd`.
- `Ledger` in memory, optionally appending JSON lines to a file.
- x402 client: `payingFetch` pays HTTP 402 paywalls through the guard and repeats the request with `X-PAYMENT`. Also `pickRequirement`, `encodePayment` and `decodePayment`.
- Rails: `MockRail`; `NearRail` with `checkNearPayment` (NEAR testnet); `ArcRail` with `checkArcPayment` (USDC on Circle's Arc testnet).
- Demo: a paywall with two honest endpoints and two that turn bad (a 40x price spike and a payee swap to a look-alike address), a scripted agent (mock, `--near`, `--arc`) and a live dashboard, checked with Mantis.
- Scripts that create testnet accounts and wallets, with keys written to the git-ignored `.env`.
- 34 tests.
