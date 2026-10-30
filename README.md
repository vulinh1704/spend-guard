# spend-guard

A spending guard for AI agents that pay for things. The agent never touches a wallet directly. It asks the guard, and the guard checks every payment before any money leaves:

- **Budgets** per payment, per day and per service.
- **Payee allowlist:** a paywall that suddenly asks to be paid at a new address is refused.
- **Price spikes:** a price several times the endpoint's usual price is refused.
- **Human approval** for payments above a threshold or to unknown services.
- **One payment at a time,** so parallel tool calls cannot both slip under the daily budget.

The guard pays HTTP 402 paywalls in the x402 style: the server answers 402 with what it accepts, the guard decides, the rail pays, and the request is repeated with proof.

| Rail | Status |
|---|---|
| Mock (offline demo, tests) | works |
| NEAR testnet | works: real transfers, and the paywall verifies each one on chain |
| Bitcoin Cash, Concordium | planned |

## Try it

```
npm install
npm test                                 # 29 tests
node demo/agent.js                       # offline, mock payments
node demo/agent.js --dashboard           # live page on http://localhost:4400
```

```
✓ paid $0.01   /quotes   {"NEAR":2.5,"BCH":450}
✗ denied /quotes   $0.40 is 40x the usual $0.01 for …/quotes; $0.40 is above the $0.25 that needs your approval
✗ denied /maps     … asked to be paid at rnaps.paywall.testnet, which is not one of its known addresses
spent today $0.10 of $1.00; 2 payments stopped
```

### On NEAR testnet

```
node scripts/near-testnet-account.js     # agent account from the testnet faucet, key in .env
node scripts/near-demo-payees.js         # paywall account and payees, incl. the look-alike "rnaps"
node demo/agent.js --near --dashboard    # real testnet transfers, each verified on chain
```

`.env` is git-ignored. Testnet NEAR has no value. Never point the scripts at mainnet.

## Use it in an agent

```js
import { Guard, payingFetch } from 'spend-guard';
import { NearRail } from 'spend-guard/src/rails/near.js';

const guard = new Guard({
  policy: { networks: ['near-testnet'], dailyUsd: 5, perPaymentUsd: 1, askAboveUsd: 0.25, services: { 'api.example.com': { payTo: ['pay.example.testnet'] } } },
  rails: [new NearRail({ accountId: process.env.NEAR_ACCOUNT_ID, privateKey: process.env.NEAR_PRIVATE_KEY })],
  approve: async (intent, verdict) => askTheHuman(verdict.reasons),
});

const res = await payingFetch(guard, 'https://api.example.com/data');
```

The UI of the dashboard is checked with [Mantis](https://github.com/vulinh1704/mantis) (`scripts/check-dashboard.sh`).

Requires Node 20 or later. MIT licensed.
