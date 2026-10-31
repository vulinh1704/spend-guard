# Publishing

What the maintainer runs to release a version to npm and list it in the [MCP Registry](https://registry.modelcontextprotocol.io). The registry holds only metadata (`server.json`) and points at the npm package, so npm comes first.

## 1. Check

```
npm test                       # also run by prepublishOnly
npm pack --dry-run             # src/, bin/, demo/dashboard.js, README, LICENSE, CHANGELOG: no tests, no .env, no GIF
```

The version must be the same in three places: `version` in `package.json`, and `version` and `packages[0].version` in `server.json`. `test/package.test.js` fails when they differ, when `server.json` misses a variable the server reads, or when `engines.node` admits a Node that a runtime dependency refuses (a published version's `engines` can't be changed). Move the `Unreleased` section of the CHANGELOG to the version and date.

Publish from `main`, after the release branch is merged and pushed. The package leaves out `docs/img`, so npmjs.com loads the README's images from the GitHub repository's default branch, and shows them broken until they are there.

## 2. npm

```
npm login
npm publish                    # publishConfig makes the scoped package public
```

`package.json` carries `"mcpName": "io.github.vulinh1704/spend-guard"`. The registry reads it from the published package to check that the npm package and the registry entry belong together, so it must be in the version you publish.

## 3. MCP Registry

Install `mcp-publisher` as the registry's [quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx) shows, then, in the repository root:

```
mcp-publisher validate         # server.json against the registry's schema and rules
mcp-publisher login github     # device login as vulinh1704, which owns io.github.vulinh1704/*
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.vulinh1704/spend-guard"
```

The registry is in preview. A published version and its metadata can't be changed, only marked deprecated or deleted (`mcp-publisher status`). A fix is a new version on npm and in the registry.

## 4. After

- Update the README where it says the package is not on npm yet: the status line and the end of "Use it as a library".
- Try the `npx -y @vulinh1704/spend-guard mcp` config from the README in a fresh client.
