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
