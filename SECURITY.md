# Security policy

spend-guard decides whether an AI agent's money leaves its wallet, so a way around it is a real bug. Thank you for looking.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub security advisories:

**https://github.com/vulinh1704/spend-guard/security/advisories/new**

Include:

- what you did and what the guard did (the verdict, the ledger entry, or the payment that went out),
- the policy you used,
- the package version and Node version,
- a proof of concept on a testnet or with `MockRail`.

Never send private keys or seed phrases, and never use mainnet funds to show a problem.

I aim to reply within a week. Once a fix is released, the advisory will be published with credit to you, unless you would rather stay anonymous.

## In scope

- A payment that goes out although the policy should refuse it, or that skips the human approval it needs.
- A way to make `checkNearPayment` or `checkArcPayment` accept a payment that did not happen, or that paid someone else or paid less.
- A key, or a key-derived secret, leaking through the guard, a rail, the ledger or the dashboard.

## Out of scope

- The limits and known gaps listed in [docs/threat-model.md](docs/threat-model.md). Ideas for closing them are welcome as normal issues.
- Bugs in dependencies (`viem`, `near-api-js`). Please report those upstream.
- The demo paywall's endpoints that turn bad on purpose.

## Supported versions

Only the latest `0.x` release gets security fixes.
