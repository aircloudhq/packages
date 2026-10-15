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
    throw new Error(`${pkg} is not installed: npm skipped this platform's binary package (an install with --omit=optional or --no-optional?). Reinstall: npm install -g @aircloudhq/cli`);
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

module.exports = { binaryPath, supported };

if (require.main === module) {
  main();
}
