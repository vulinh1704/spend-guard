import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Whether `file` (relative to the root, with forward slashes) is in the package's `files`. */
const ships = (file) => pkg.files.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));

/** Every local module `entry` loads, statically or with import(), followed through the tree. */
function localImports(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(path.join(root, entry), 'utf8');
  for (const [, spec] of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)'(\.{1,2}\/[^']+)'/g)) {
    localImports(path.posix.normalize(path.posix.join(path.posix.dirname(entry), spec)), seen);
  }
  return seen;
}

describe('npm package', () => {
  test('ships every module the command and the entry points load, and nothing from test/ or demo paywalls', () => {
    const entries = [pkg.bin['spend-guard'], pkg.exports['.'], ...['arc', 'circle-wallet', 'eip3009', 'gateway', 'mock', 'near'].map((r) => pkg.exports['./rails/*'].replace('*', r))];
    const loaded = new Set(entries.flatMap((e) => [...localImports(path.posix.normalize(e))]));
    assert.ok(loaded.has('demo/dashboard.js'), 'the command serves the dashboard');
    for (const file of loaded) assert.ok(ships(file), `${file} is loaded but not in "files"`);
    for (const file of ['test/guard.test.js', 'demo/paid-api.js', 'demo/agent.js', 'scripts/mcp-demo.js', 'docs/img/demo.gif', '.env']) assert.ok(!ships(file), `${file} should not ship`);
  });
});

describe('MCP registry entry (server.json)', () => {
  const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8'));
  const [npm] = server.packages;

  // The registry refuses a publish whose package does not carry the same name and version.
  test('names the npm package and version this package.json is', () => {
    assert.equal(server.name, pkg.mcpName);
    assert.match(server.name, /^io\.github\.vulinh1704\//, 'GitHub login to the registry owns io.github.<user>/ only');
    assert.equal(server.version, pkg.version);
    assert.deepEqual([npm.registryType, npm.identifier, npm.version], ['npm', pkg.name, pkg.version]);
    assert.ok(server.description.length <= 100, `the registry takes 100 characters at most, not ${server.description.length}`);
  });

  test('starts the stdio server the way the README does: npx @vulinh1704/spend-guard mcp', () => {
    assert.equal(npm.transport.type, 'stdio');
    assert.equal(npm.runtimeHint, 'npx');
    assert.deepEqual(npm.packageArguments, [{ type: 'positional', value: 'mcp' }]);
  });

  test('lists every variable the server reads, none required, keys marked secret', () => {
    const code = ['src/mcp.js', 'bin/spend-guard.js'].map((f) => readFileSync(path.join(root, f), 'utf8')).join('\n');
    const read = new Set(code.match(/\b(?:SPEND_GUARD_[A-Z_]+|ARC_PRIVATE_KEY|NEAR_ACCOUNT_ID|NEAR_PRIVATE_KEY)\b/g));
    const listed = npm.environmentVariables;
    assert.deepEqual(listed.map((v) => v.name).sort(), [...read].sort());
    // With no variables at all the server runs on the mock rail, so a registry client can start it as is.
    assert.ok(listed.every((v) => v.isRequired === false), 'the mock rail needs nothing');
    assert.deepEqual(listed.filter((v) => v.isSecret).map((v) => v.name), ['ARC_PRIVATE_KEY', 'NEAR_PRIVATE_KEY']);
  });
});
