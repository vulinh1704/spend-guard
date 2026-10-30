# Policy reference

A policy is a plain object. The guard merges it over `DEFAULT_POLICY` (a shallow merge), so you only set what you change.

```js
import { Guard } from '@vulinh1704/spend-guard';
import { ArcRail } from '@vulinh1704/spend-guard/rails/arc';

const guard = new Guard({
  policy: {
    networks: ['arc-testnet'],
    dailyUsd: 5,
    perPaymentUsd: 1,
    askAboveUsd: 0.25,
    spikeRatio: 5,
    unknownService: 'ask',
    services: {
      'api.weather.example': { payTo: ['0x1111111111111111111111111111111111111111'], maxUsd: 0.5 },
    },
  },
  rails: [new ArcRail({ privateKey: process.env.ARC_PRIVATE_KEY })],
  approve: async (intent, verdict) => askTheHuman(verdict.reasons),
});
```

## Fields

| Field | Default | Meaning |
|---|---|---|
| `networks` | `[]` | Networks the agent may pay on, e.g. `arc-testnet`, `near-testnet`. Empty means nothing is allowed. |
| `dailyUsd` | `5` | Total the agent may spend per UTC day. |
| `perPaymentUsd` | `1` | No single payment may cost more than this. |
| `askAboveUsd` | `0.25` | Payments above this wait for a human yes. |
| `spikeRatio` | `5` | A price at least this many times the endpoint's usual price is refused. |
| `unknownService` | `'ask'` | What to do when the host is not in `services`: `'ask'` or `'deny'`. |
| `services` | `{}` | Known services by host name (`host:port` when there is a port). |
| `services[host].payTo` | (required) | Addresses this service may be paid at. Any other address is a payee swap. |
| `services[host].maxUsd` | none | The most one call to this service may cost. |

All dollar limits are numbers in US dollars. They are converted to integer micro-dollars before any comparison.

## How a verdict is made

`evaluate(intent, policy, history)` runs every rule and returns `{ decision, reasons, usd }`:

- `usd` is the payment in micro-dollars (bigint), converted from the intent's atomic amount with the asset's decimals and USD price from `ASSETS`.
- If any rule denies, the decision is `deny`, and `reasons` lists every denial followed by every rule that would only have asked.
- Otherwise, if any rule asks, the decision is `ask`, and `reasons` lists those rules.
- Otherwise the decision is `allow` and `reasons` is empty.

What happens next is up to the guard:

| Decision | Guard does | Ledger status | Agent sees |
|---|---|---|---|
| `allow` | pays through the rail | `paid` (or `failed` if the rail throws) | the receipt, or the rail's error |
| `ask` | calls `approve(intent, verdict)`. Without an `approve` callback the answer is no | `paid` after a yes, `declined` after a no | the receipt, or `GuardRefused` with `status: 'declined'` |
| `deny` | nothing moves | `denied` | `GuardRefused` with `status: 'denied'` and `reasons` |

`history` comes from the ledger. `spentTodayUsd` is the sum of `paid` entries on the UTC day of `now`. `recentPricesUsd` holds the last 20 prices paid for the same endpoint.

## Rules

Each example below uses the policy at the top of this page and a `$0.01` USDC request to `https://api.weather.example/forecast?city=Hanoi`. The messages are the exact strings the guard returns.

### `network` (deny)

The intent's network is not in `networks`.

```
base-sepolia is not one of the allowed networks (arc-testnet)
```

A network that is allowed but has no rail is never picked by `payingFetch`, which only considers `guard.networks` (allowed and backed by a rail). A direct `guard.pay` on such a network is recorded as `failed` with `no rail for <network>`.

### `unknown-service` (ask, or deny)

The host is not in `services`. With `unknownService: 'ask'` the human decides. With `'deny'` the payment is refused. A prompt-injected agent sent to a new paywall ends up here.

```
api.maps.example is not a known service
```

An unknown service has no allowlist, so the payee-swap and service-cap rules do not apply to it. Only the network, per-payment, daily, spike and ask rules do.

### `payee-swap` (deny)

The host is known, but it asks to be paid at an address that is not in its `payTo`. This is the classic paywall attack: same host, same price, but the money goes somewhere new, often to a look-alike address.

```
api.weather.example asked to be paid at 0x1111111111111111111111111111111111111112, which is not one of its known addresses
```

Addresses are compared as exact strings. List EVM addresses in the same form the paywall sends them (usually EIP-55 checksummed). Otherwise a correct address in another case is refused as a swap.

### `service-cap` (deny)

The payment is above `services[host].maxUsd`.

```
$0.60 is over the $0.50 cap for api.weather.example
```

### `per-payment` (deny)

The payment is above `perPaymentUsd`.

```
$1.50 is over the $1.00 limit for one payment
```

### `daily-budget` (deny)

Today's paid total plus this payment would go over `dailyUsd`. Landing exactly on the budget is allowed. Only `paid` entries count, so denied, declined and failed payments do not use up the budget.

```
paying $0.01 would take today's spend to $5.005, over the $5.00 budget
```

### `price-spike` (deny)

The price is at least `spikeRatio` times the endpoint's usual price. The usual price is the median of the last 20 prices paid for the same endpoint, where an endpoint is host plus path, without the query. One API often charges differently per endpoint but the same for every call to one endpoint.

```
$0.40 is 40x the usual $0.01 for api.weather.example/forecast
```

The first payment to an endpoint has no usual price yet, so this rule cannot fire on it. The caps and the approval threshold still apply.

### `large-payment` (ask)

The payment is above `askAboveUsd`.

```
$0.30 is above the $0.25 that needs your approval
```

When another rule denies, this reason is still listed after the denials, so the human sees everything that was wrong.

### Several rules at once

A verdict lists every rule that fired. In the demo, the `/quotes` endpoint jumps from $0.01 to $0.40:

```
deny
  price-spike    $0.40 is 40x the usual $0.01 for 127.0.0.1:<port>/quotes
  large-payment  $0.40 is above the $0.25 that needs your approval
```

## Assets

Amounts arrive in the asset's atomic units and are converted with `ASSETS` from `src/money.js`:

| Asset id | Symbol | Decimals | USD per unit |
|---|---|---|---|
| `usdc` | USDC | 6 | 1 |
| `pusd` | PUSD | 2 | 1 |
| `near` | NEAR | 24 | 2.5 (fixed) |
| `bch` | BCH | 8 | 450 (fixed) |
| `ccd` | CCD | 6 | 0.01 (fixed) |

Stablecoins convert exactly. Prices for the other assets are fixed constants, so their dollar limits are approximate. An asset that is not in `ASSETS` is an error (`unknown asset "dai"; add it to ASSETS with its decimals and USD price`): nothing is paid and nothing is recorded.
