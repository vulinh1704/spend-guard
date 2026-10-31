# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```
npm ci
npm test               # node:test, offline
node demo/agent.js     # offline demo with mock payments
```

You need Node 22.22.2 or later, because `near-api-js` 7 does (Circle's SDK needs Node 22). `engines.node` in `package.json` must stay at least what every runtime dependency declares, and `test/package.test.js` checks it against `package-lock.json`. The NEAR, Arc and Gateway demos need testnet keys in `.env` (see the README). Tests never touch a network.

## Style

- Plain JavaScript (ESM) with JSDoc types. No TypeScript and no build step.
- Tests use `node:test` and `node:assert/strict` and live in `test/`.
- Comments explain why, not what. Keep functions short and names plain.
- Ask in an issue before adding a runtime dependency.

## Rules of the codebase

- `evaluate` stays pure: no clock, no network, no ledger access inside the policy.
- Amounts are bigint atomic units, and limits are compared in integer micro-dollars. No floating point decides a payment.
- A new rule gets a reason code, a test, and an entry in [docs/policy.md](docs/policy.md).
- A new rail follows [docs/rails.md](docs/rails.md). It comes with its paywall-side check, and with tests that use a fake client instead of a live chain.

## Pull requests

- One change per pull request, with `npm test` passing.
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
- Say how you tested it, and for a rail, on which testnet.
- Testnets only. Never commit `.env`, keys or seed phrases, and never paste them in an issue.

Report security problems privately, see [SECURITY.md](SECURITY.md).
