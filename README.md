# spend-guard

A spending guard for AI agents that pay for things. The agent never touches a wallet directly. It asks the guard, and the guard runs the payment through four checks before any money leaves:

- **Budgets:** per payment, per day, and per service.
- **Payee allowlist:** a paywall that suddenly asks to be paid at a new address is refused.
- **Price spikes:** a price several times the endpoint's usual price is refused.
- **Human approval:** payments above a threshold, or to unknown services, wait for a yes.

The guard pays HTTP 402 paywalls in the x402 style. Chain rails for NEAR, Bitcoin Cash and Concordium are in progress; a mock rail runs the demo offline.

```
npm test
node demo/agent.js
```

```
✓ paid $0.01   /quotes   {"NEAR":2.5,"BCH":450}
✗ denied /quotes   $0.40 is 40x the usual $0.01 for …/quotes; $0.40 is above the $0.25 that needs your approval
✗ denied /maps     … asked to be paid at drain-4f2a.testnet, which is not one of its known addresses
```

Requires Node 20 or later. There are no dependencies yet.
