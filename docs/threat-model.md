# Threat model

spend-guard protects an agent's wallet from two things: the agent's own bad payment decisions (a bug, a loop, a prompt injection) and paywalls that misbehave. It does this by checking every payment against a policy before a rail moves any money or signs anything.

## Trust boundary

| Trusted | Not trusted |
|---|---|
| The policy you write | The model and the tool calls it makes |
| The guard, its ledger and its rails | Every paywall: its price, its payee, its description, its settlement report |
| The human who answers `approve` (on the dashboard, say) | Content the agent read on the way (pages, tool output) |
| The chain the paywall verifies against, and Circle for the Circle rails | The network between agent and paywall |

The guard is a library in the agent's process, or the `spend-guard mcp` server next to it. It is a boundary only if the model reaches money through `payingFetch` or the MCP server's `pay_and_fetch`, and never through a rail, a key or arbitrary code. An agent that also has a shell could read `.env`; one with a browser-automation tool could open the dashboard and press Approve. Run the paying agent without those tools, for example Claude Desktop with only this server.

## What the guard stops

| Threat | Example | What happens | Rule |
|---|---|---|---|
| Runaway agent | a loop calls a paid tool a thousand times | payments stop at the daily budget | `daily-budget` |
| Overpriced call | a paywall asks $50 for one weather call | refused, or sent to a human above the threshold | `per-payment`, `service-cap`, `large-payment` |
| Price spike | an endpoint goes from $0.01 to $0.40 after a few calls | refused | `price-spike` |
| Payee swap | a compromised paywall asks to be paid at a look-alike address (`rnaps` for `maps`) | refused | `payee-swap` |
| Injected detour | a page tells the agent to buy "premium data" from a new host | a human decides, or refused | `unknown-service` |
| Wrong chain or scheme | a paywall offers only a network you did not allow, Permit2, or a token the guard can't price | not paid, and the error says why | `network`, `payingFetch` |
| Signature for the wrong chain | an `exact` offer for Arc mainnet, where the same key holds real money | not signed | `ArcRail`, `GatewayRail`, `CircleWalletRail` pin chain and token |
| Racing tool calls | three parallel $0.45 calls against a $1 budget, maybe from two MCP servers | the third is refused | decisions serialized, across processes through the ledger file's lock |
| Approval during a spend | a payment waits for a human while others go out | it is checked again against the budget after the yes | `Guard.pay` re-evaluates |
| Abandoned payment | the MCP client cancels a call, or times out, while it waits for approval | it is withdrawn and never paid | `pay_and_fetch` passes the abort signal to the guard |
| Forged approval | a web page posts "approve" to the dashboard | refused: localhost Host, loopback peer, same Origin, JSON body | `demo/dashboard.js` |
| Made-up or reused proof (paywall side) | a client sends a made-up txid, a proof or signature the paywall already accepted, even twice at once | the paywall refuses it | `checkArcPayment`, `checkNearPayment`, `verifyAuthorization`, `checkGatewayAuthorization`, replay checks in the demo paywalls |

Every decision, including the refusals, is in the ledger with its reasons, so you can audit what happened later.

## What it cannot stop

- **Code in the same process.** Anything that can call a rail or read its key can pay without the guard. Keep keys out of the model's reach. The Circle Wallets rail moves the key out of the process entirely, to Circle.
- **Paying for nothing.** The guard checks the price and the payee, not the goods. A paywall can take the payment and return junk, an error, or another 402. The budgets bound the loss, the ledger keeps the evidence, and a second 402 after paying never gets a second payment.
- **An endpoint that is expensive from its first call.** A spike needs a usual price to compare against. Until there is one, only the caps and the approval threshold apply.
- **Slow creep.** A price that rises by less than `spikeRatio` each time moves the median with it. The caps still hold.
- **Many small payments to allowed payees.** They pass, up to the daily budget. That is what the budget is for.
- **A compromised payee on your allowlist.** The guard trusts the addresses you list.
- **A human who says yes.** The approval card shows reasons built from what the paywall sent (host, address). Show them as data, and never let the model answer `approve`.
- **A signature held by the paywall.** A signed payment can be settled by whoever holds it until it expires: 120 seconds at most for x402 `exact`, and at least 7 days for Circle Gateway, which is Gateway's own minimum. The guard counts every signature as spent, so the budget already covers it.

## Known gaps

These are gaps in the current code, not design limits:

- **Gas is not counted.** Budgets count the payment. On Arc the gas of a transfer is also USDC and comes from the same balance. With x402 `exact` and Circle Gateway the agent pays no gas.
- **Non-stablecoin prices are fixed.** NEAR, BCH and CCD convert at constants in `ASSETS`, so dollar limits on them are approximate. USDC converts exactly.
- **A transfer proof works for whoever sends it first.** With plain transfers (`--arc`, `--near`), the proof `{ txid, sender }` is public once the transfer is on chain, and nothing ties it to the agent or to the request. Someone who watches the chain can send it to the paywall before the agent does and get the call the agent paid for. The agent then gets `payment already used`, after its guard has already counted the payment. x402 `exact` and Circle Gateway close this: the agent signs for one payee with a fresh nonce and sends the signature only to the paywall, which settles it once.
- **The demo paywall's replay check lives in memory.** It accepts each txid once, but only while the process runs, and the chain checks do not look at how old a transfer is. After a restart, an earlier transfer from a sender to a payee can buy a call again. A real paywall should store the txids it accepted and refuse transfers older than its payment timeout.
- **The settlement a paywall reports is taken on trust.** The transaction in its `PAYMENT-RESPONSE` is recorded and linked without an on-chain check. It changes no budget: the payment was counted when it was signed.
- **Gateway's count of unsettled signatures lives in memory.** After a restart, `GatewayRail` no longer knows what it signed that Gateway has not settled, so it could sign for more than the deposit covers. The guard's budgets still hold.
- **Smart-wallet payers.** The x402 `exact` checks accept EOA signatures only, and the Circle rail refuses a contract wallet unless it pays by transfer.

## Running an agent with it

- Give the agent a dedicated wallet that holds only what it may spend, and top it up instead of keeping a large balance. With Circle Gateway, keep the deposit small too.
- For unattended agents, set `unknownService: 'deny'` and list every service with its `payTo` and a `maxUsd`.
- Pass `new Ledger({ file })` to keep an audit trail. The file is read back before each decision, so a restart keeps today's spend, and processes on the same file share one budget.
- Route `approve` to a person (a CLI prompt, or the dashboard's Approve and Deny buttons through `Approvals`), never to the model.
- Keep keys in the environment or a key service, never in the repository. The scripts in this repo are for testnets only.

Found a way past the guard? Please report it privately, see [SECURITY.md](../SECURITY.md).
