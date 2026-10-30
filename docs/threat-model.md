# Threat model

spend-guard protects an agent's wallet from two things: the agent's own bad payment decisions (a bug, a loop, a prompt injection) and paywalls that misbehave. It does this by checking every payment against a policy before a rail moves any money.

## Trust boundary

| Trusted | Not trusted |
|---|---|
| The policy you write | The model and the tool calls it makes |
| The guard, its ledger and its rails | Every paywall: its price, its payee, its description |
| The human who answers `approve` | Content the agent read on the way (pages, tool output) |
| The chain the paywall verifies against | The network between agent and paywall |

The guard is a library in the agent's process. It is a boundary only if the model reaches money through `payingFetch` (or the MCP tool, in progress) and never through a rail, a key or arbitrary code in that process.

## What the guard stops

| Threat | Example | What happens | Rule |
|---|---|---|---|
| Runaway agent | a loop calls a paid tool a thousand times | payments stop at the daily budget | `daily-budget` |
| Overpriced call | a paywall asks $50 for one weather call | refused, or sent to a human above the threshold | `per-payment`, `service-cap`, `large-payment` |
| Price spike | an endpoint goes from $0.01 to $0.40 after a few calls | refused | `price-spike` |
| Payee swap | a compromised paywall asks to be paid at a look-alike address (`rnaps` for `maps`) | refused | `payee-swap` |
| Injected detour | a page tells the agent to buy "premium data" from a new host | a human decides, or refused | `unknown-service` |
| Wrong chain | a paywall only offers a network you did not allow | not paid | `network`, `payingFetch` |
| Racing tool calls | three parallel $0.45 calls against a $1 budget | the third is refused | serialized `Guard.pay` |
| Made-up or reused proof (paywall side) | a client sends a made-up txid, or a proof the paywall already accepted, even twice at once | the paywall refuses it | `checkNearPayment`, `checkArcPayment`, replay check in the demo paywall |

Every decision, including the refusals, is in the ledger with its reasons, so you can audit what happened later.

## What it cannot stop

- **Code in the same process.** Anything that can call a rail or read its key can pay without the guard. Keep keys out of the model's reach. Circle Wallets (in progress) moves the key out of the process entirely.
- **Paying for nothing.** The guard checks the price and the payee, not the goods. A paywall can take the payment and return junk, an error, or another 402. The budgets bound the loss, and the ledger keeps the evidence.
- **An endpoint that is expensive from its first call.** A spike needs a usual price to compare against. Until there is one, only the caps and the approval threshold apply.
- **Slow creep.** A price that rises by less than `spikeRatio` each time moves the median with it. The caps still hold.
- **Many small payments to allowed payees.** They pass, up to the daily budget. That is what the budget is for.
- **A compromised payee on your allowlist.** The guard trusts the addresses you list.
- **A human who says yes.** `approve` shows reasons built from what the paywall sent (host, address). Show them as data, and never let the model answer `approve`.

## Known gaps

These are gaps in the current code, not design limits:

- **The ledger is not reloaded on restart.** With `new Ledger({ file })` every entry is appended to the file, but nothing reads it back. Restarting the agent resets today's spend and the usual prices.
- **Gas is not counted.** Budgets count the payment. On Arc the gas is also USDC and comes from the same balance.
- **A payment that went through but errored.** If a rail throws after the transaction was sent (an RPC timeout while waiting for the receipt, for example), the entry is `failed` and does not count against the budget, although the money may have left.
- **Non-stablecoin prices are fixed.** NEAR, BCH and CCD convert at constants in `ASSETS`, so dollar limits on them are approximate. USDC converts exactly.
- **Payee addresses are compared as exact strings.** An EVM address in another letter case is refused as a swap. This fails safe, but list addresses in the form the paywall sends.
- **A payment proof works for whoever sends it first.** The proof `{ txid, sender }` is public once the transfer is on chain, and nothing ties it to the agent or to the request. Someone who watches the chain can send it to the paywall before the agent does and get the call the agent paid for. The agent then gets `payment already used`, after its guard has already counted the payment. The x402 `exact` scheme on Arc (in progress) is meant to close this: the agent signs an EIP-3009 authorization with a fresh nonce and a deadline, sends it only to the paywall over HTTPS, and the paywall settles it once.
- **The demo paywall's replay check lives in memory.** It accepts each txid once, but only while the process runs, and the chain checks do not look at how old a transfer is. After a restart, an earlier transfer from a sender to a payee can buy a call again. A real paywall should store the txids it accepted and refuse transfers older than its payment timeout.

## Running an agent with it

- Give the agent a dedicated wallet that holds only what it may spend, and top it up instead of keeping a large balance.
- For unattended agents, set `unknownService: 'deny'` and list every service with its `payTo` and a `maxUsd`.
- Pass `new Ledger({ file })` to keep an audit trail.
- Route `approve` to a person (a CLI prompt, a chat message, the MCP client), never to the model.
- Keep keys in the environment or a key service, never in the repository. The scripts in this repo are for testnets only.

Found a way past the guard? Please report it privately, see [SECURITY.md](../SECURITY.md).
