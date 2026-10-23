#!/usr/bin/env node
'use strict';
// @aircloudhq/cli — the npm channel of the aircloud CLI (#250 H10; ADR-252 decision 5; the esbuild
// pattern). npm installs exactly one of this package's optionalDependencies, the one whose `os` and `cpu`
// match the machine: @aircloudhq/cli-<platform>-<arch>, which carries the signed release's native binary
// (built only from the verified release archives — scripts/release/stage-npm-cli.sh). This shim finds it and
// execs it: the arguments, stdio and exit status pass through.
//
// The supported platforms are derived from this package's own optionalDependencies — never a second list.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCOPE_PREFIX = '@aircloudhq/cli-';
const manifest = require(path.join(__dirname, '..', 'package.json'));

// supported is the set of `<platform>-<arch>` this package has a binary for.
function supported() {
  return new Set(Object.keys(manifest.optionalDependencies || {})
    .filter((n) => n.startsWith(SCOPE_PREFIX))
    .map((n) => n.slice(SCOPE_PREFIX.length)));
}

// The Node range evaluation below is deliberately a SUBSET of npm's semver grammar: `||` unions of
// space-separated comparators, each `^V`, `~V`, `>=V`, `>V`, `<=V`, `<V`, `=V` or a bare `V`, where V is
// MAJOR[.MINOR[.PATCH]] in digits. That covers every form this package declares; anything else (x-ranges,
// hyphen ranges, prereleases, `*`) is refused naming the range, because a guessed answer would put the
// wrong cause in front of the Builder — which is the defect this check exists to remove (#755 B2a).
const VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function unsupportedRange(range) {
  return new Error(`cannot evaluate the declared engines.node range ${JSON.stringify(range)}`);
}

// parseVersion reads MAJOR[.MINOR[.PATCH]] into a triple, missing parts 0, and how many parts were given.
function parseVersion(text) {
  const m = VERSION.exec(text);
  if (!m) return null;
  return { v: [m[1], m[2], m[3]].map((p) => (p === undefined ? 0 : Number(p))), parts: m.slice(1).filter((p) => p !== undefined).length };
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// comparator turns one comparator into the predicate it states, or throws for a form outside the subset.
function comparator(token, range) {
  const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(token);
  const parsed = parseVersion(m[2]);
  if (!parsed) throw unsupportedRange(range);
  const { v } = parsed;
  switch (m[1]) {
    case '^': {
      // npm's caret: below the next increment of the left-most non-zero part.
      const i = v[0] !== 0 ? 0 : v[1] !== 0 || parsed.parts < 3 ? 1 : 2;
      const upper = v.map((p, j) => (j < i ? p : j === i ? p + 1 : 0));
      return (n) => compare(n, v) >= 0 && compare(n, upper) < 0;
    }
    case '~': {
      const upper = parsed.parts === 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0];
      return (n) => compare(n, v) >= 0 && compare(n, upper) < 0;
    }
    case '>=': return (n) => compare(n, v) >= 0;
    case '<=': return (n) => compare(n, v) <= 0;
    case '>': return (n) => compare(n, v) > 0;
    case '<': return (n) => compare(n, v) < 0;
    default: return (n) => compare(n, v) === 0;
  }
}

// nodeSatisfies reports whether the Node `version` (process.version's `vX.Y.Z`) is inside `range`, or
// throws when either cannot be read — never a guessed answer.
function nodeSatisfies(version, range) {
  const running = typeof version === 'string' ? parseVersion(version.replace(/^v/, '')) : null;
  if (!running || running.parts !== 3) {
    throw new Error(`cannot read the running Node.js version ${JSON.stringify(version)}`);
  }
  if (typeof range !== 'string' || range.trim() === '') throw unsupportedRange(range);
  const sets = range.split('||').map((set) => set.trim().split(/\s+/).filter(Boolean));
  if (sets.some((set) => set.length === 0)) throw unsupportedRange(range);
  const predicates = sets.map((set) => set.map((token) => comparator(token, range)));
  return predicates.some((set) => set.every((p) => p(running.v)));
}

// notInstalled is the error for a platform package npm did not install. Under a Node outside the range this
// package declares, that range is the cause — npm skips an optional dependency whose engines do not match —
// so the message names it and the remedy; only inside the range is --omit=optional the likely cause.
function notInstalled(pkg, version = process.version, range = (manifest.engines || {}).node) {
  let inside;
  try {
    inside = nodeSatisfies(version, range);
  } catch (err) {
    return new Error(`${pkg} is not installed, and the shim ${err.message}, so it cannot tell whether this Node.js is the cause. Reinstall: npm install -g @aircloudhq/cli`);
  }
  if (!inside) {
    return new Error(`${pkg} is not installed: Node.js ${version} is outside ${range}, the range @aircloudhq/cli declares in engines.node. Install a Node.js inside ${range}, then reinstall: npm install -g @aircloudhq/cli`);
  }
  return new Error(`${pkg} is not installed: npm skipped this platform's binary package (an install with --omit=optional or --no-optional?). Reinstall: npm install -g @aircloudhq/cli`);
}

// binaryPath is the installed platform package's binary for platform/arch (default: this machine).
function binaryPath(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  const known = supported();
  if (!known.has(key)) {
    throw new Error(`@aircloudhq/cli has no aircloud binary for ${platform}/${arch} (supported: ${[...known].sort().join(', ')})`);
  }
  const pkg = `${SCOPE_PREFIX}${key}`;
  let pj;
  try {
    pj = require.resolve(`${pkg}/package.json`);
  } catch {
    throw notInstalled(pkg);
  }
  return path.join(path.dirname(pj), 'bin', 'aircloud');
}

function main() {
  let bin;
  try {
    bin = binaryPath();
  } catch (err) {
    process.stderr.write(`aircloud: ${err.message}\n`);
    process.exit(1);
  }
  const r = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`aircloud: could not run ${bin}: ${r.error.message}\n`);
    process.exit(1);
  }
  if (r.signal) {
    process.kill(process.pid, r.signal);
    return;
  }
  process.exit(r.status === null ? 1 : r.status);
}

module.exports = { binaryPath, supported, nodeSatisfies };

if (require.main === module) {
  main();
}
