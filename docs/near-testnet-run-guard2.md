# NEAR testnet runs on guard2, recorded

The demo video's runs on `guard2.spend-guard-bbeb82.testnet`, a second deployment of the guard contract with the same wasm and caps, are described in [near-testnet-run.md](near-testnet-run.md#a-second-guard-for-the-demo-video-11-nov-2026). Anyone can check them without a key or an account:

```
node scripts/near-verify.js docs/near-testnet-run-guard2.md
```

The script reads the JSON block below, as it does for [near-testnet-run.md](near-testnet-run.md): each transfer and refusal from a public archival RPC, guard2's code hash, policy and agent key, the Agent API transfer recorded with these runs, and the balance of the look-alike `rnaps.`. These runs have a file of their own because the script checks one guard contract per file. `node scripts/near-verify.js` with no argument checks the runs on `guard.spend-guard-bbeb82.testnet`.

```json near-verify
{
  "network": "near-testnet",
  "payments": [
    {"hash": "BRq8yqWh3mqqajGQ9cu5ESSx1pcSKMYEeycody3JmsrV", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "4em94gYiKeDhXPqTBcEhk2BqAmyS6Eqgkjw6H3SRPHWw", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "news.sg-paywall-25135e.testnet", "amount": "8000000000000000000000"},
    {"hash": "5XzNb9SKuimQwCNMDFsGHBad5DQANiJXn5QZDBJBuxKN", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "7x4prfJYUMQPiUVV3wQjeiyqGGQzxhbZDiuP9LTno6kv", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "HVcQ1Su3mMXCmCqqbwQAVseRFsFNf7BmTBFMd2Wc15zX", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "quotes.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "Co79cQibnwPwkK9aYLXba6EBMDvrDpvbJ4KTsscd9LH6", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000"},
    {"hash": "7gZmrqphyrRq48mNJjD4As8w8J3TwcrwrXcXZoWip3S9", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000"},
    {"hash": "3yPJAFHu1nHWyDQ8KGv99nypXLV9r6gHegZwE8yTM1g1", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "kwsmJ9GoLSXy54E2zgWbXgmgWTM1ejvaC5oa1HMHQWY", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "news.sg-paywall-25135e.testnet", "amount": "120000000000000000000000"},
    {"hash": "8Zge4umXCGvDYJ2xA8DFRfcX57VgvLCieyJJPnmJ7cLt", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "2AVAQdZ1xhoj6GsQJ5pxwpfmNxsQZ9VUz9sH5myqiDqZ", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "news.sg-paywall-25135e.testnet", "amount": "8000000000000000000000"},
    {"hash": "3TsyY2aSe4d5TJWbZ5EaqbPbm4dWLdypTP4ZcWm8wBnF", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "4000000000000000000000"},
    {"hash": "AfUxEWW24WdZ7kmLD3Zq64fSTvM6kaKfeJJS5DEZR5nm", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "news.sg-paywall-25135e.testnet", "amount": "8000000000000000000000"},
    {"hash": "6T3FowDPh1QocNns4ExAgor4CeLP4VbVbJ6wgCnZPj1B", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000"},
    {"hash": "G3VUhDRr8Cd4GcBWrYjzRyRpt43hHD4JVf6DDjrEjeQS", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "maps.sg-paywall-25135e.testnet", "amount": "6000000000000000000000"},
    {"hash": "6KgMzoXPGw8YZUJsgqwLPXA49iQoLFjsWgkdToA6R8Mj", "signer": "guard2.spend-guard-bbeb82.testnet", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "54000000000000000000000"}
  ],
  "intents": [
    {"hash": "5xwrt5ivQdXQFWHWg7RV7a5Ek8fHq2XCfKkhgdhPVnMs", "signer": "maker.tidepool-sandbox.testnet", "sender": "453c3a8887e1c24d31dfe6674e205700e004d2cc4775034dccc180e9b4642aaf", "payTo": "weather.sg-paywall-25135e.testnet", "amount": "10000"}
  ],
  "refused": [
    {"hash": "2yQrAxT7ze1TdtUTDZoKYMMzL2hYNMfhgZVb6vu8wm5g", "signer": "guard2.spend-guard-bbeb82.testnet", "reason": "rnaps.sg-paywall-25135e.testnet is not on the allowlist"},
    {"hash": "HC4rSw2DP5hL6CVNRQX9QNZ2uZ4s57muYHFReEshunCe", "signer": "guard2.spend-guard-bbeb82.testnet", "reason": "150000000000000000000001 yoctoNEAR is above the per-payment cap of 150000000000000000000000"},
    {"hash": "R5GdhDWtnKBLHWJfJM2HKzw1RVes8C6qVWFBLWQzNuN", "signer": "guard2.spend-guard-bbeb82.testnet", "reason": "1000000000000000000000 yoctoNEAR would bring today's spending to 251000000000000000000000, above the daily cap of 250000000000000000000000"}
  ],
  "balances": [
    {"account": "rnaps.sg-paywall-25135e.testnet", "amount": "50000000000000000000000", "why": "the look-alike payee was never paid: it holds the 0.05 NEAR it was created with"}
  ],
  "guard": {
    "contract": "guard2.spend-guard-bbeb82.testnet",
    "wasm": "contracts/near-guard/res/spend_guard_near.wasm",
    "agentKey": "ed25519:45VHQFM3LGQr9LznnVefmMCRtya9UTWWPURbM3KZ9YNx",
    "allowed": [
      "weather.sg-paywall-25135e.testnet",
      "news.sg-paywall-25135e.testnet",
      "quotes.sg-paywall-25135e.testnet",
      "maps.sg-paywall-25135e.testnet"
    ],
    "notAllowed": [
      "rnaps.sg-paywall-25135e.testnet"
    ],
    "perPaymentCap": "150000000000000000000000",
    "dailyCap": "250000000000000000000000"
  }
}
```
