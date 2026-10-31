# spend-guard docs

- [Architecture](architecture.md): how a paid request flows from the agent through the guard and a rail to the paywall, and the MCP server and dashboard around them.
- [Policy reference](policy.md): every field, every rule and reason code, with the exact messages.
- [Rails](rails.md): mock, NEAR, Arc USDC by transfer or by x402 `exact` (EIP-3009), Circle Gateway nanopayments and Circle Wallets.
- [Circle Wallets](circle-wallets.md): paying from a Circle developer-controlled wallet, and how Circle's controls and the guard fit together.
- [Threat model](threat-model.md): what the guard stops, what it cannot stop, and the known gaps.
- [Publishing](publishing.md): releasing a version to npm and listing it in the MCP Registry.

Project files: [CHANGELOG](../CHANGELOG.md) · [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md)
