# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## 0.2.0 - Unreleased

Planned for this release. Items marked *in progress* are still being built on their own branches and are not on `main` yet.

### Added

- npm package `@vulinh1704/spend-guard`. The unscoped name `spend-guard` cannot be used on npm because it differs from the existing, unrelated `spendguard` package only by punctuation.
- Rail entry points: `@vulinh1704/spend-guard/rails/mock`, `/rails/near` and `/rails/arc`, so an agent loads only the SDK of the chain it pays on.
- Package metadata: `files` whitelist (only `src/` and `bin/` ship), `sideEffects: false`, `engines.node >=20.19.0`, and the `spend-guard` command entry.
- CI on GitHub Actions: tests on Node 20, 22 and 24, plus the offline demo, which must still stop the price spike and the payee swap.
- Docs: [architecture](docs/architecture.md), [policy reference](docs/policy.md), [rails](docs/rails.md) and [threat model](docs/threat-model.md); [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
- *In progress:* x402 `exact` payments on Arc: the agent signs an EIP-3009 USDC `transferWithAuthorization` and the paywall or a facilitator settles it.
- *In progress:* Circle Gateway rail: pay from a USDC balance held in Circle Gateway.
- *In progress:* Circle Wallets rail: a Circle developer-controlled wallet signs, so no private key sits in the agent's process.
- *In progress:* MCP server (the `spend-guard` command), so MCP clients pay through the guard and approvals reach a person.

### Changed

- Deep imports such as `spend-guard/src/rails/near.js` no longer resolve, because the package now has an `exports` map. Import `@vulinh1704/spend-guard/rails/near` instead.

### Fixed

- The demo paywall takes a txid before it checks the payment on chain, so the same proof sent twice at once buys one call, not two.

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
