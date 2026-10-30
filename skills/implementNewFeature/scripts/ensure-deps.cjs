#!/usr/bin/env node
'use strict';

// The plugin's own Playwright and its Chromium, checked - and installed when missing - while the
// user is still filling in step 1. The plugin cache keeps one folder per version, so every
// upgrade arrives without `node_modules`: one run learned that at its first mockup screenshots,
// and the step waited for an install that could have run an hour earlier. The browser sits in
// the machine-wide Playwright cache and survives upgrades; the package does not.
//
// Usage: node ensure-deps.cjs [--skill-dir=<dir>]
// Prints ONE line (FIXED IDENTIFIERS): `DEPS_READY`, `DEPS_INSTALLED <what>[,<what>]` or
// `DEPS_FAILED <reason>` (exit code 1). The steps that need the runner still install it
// themselves when this failed.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliOf = (skillDir) => path.join(skillDir, 'node_modules', '@playwright', 'test', 'cli.js');

// Where the plugin's Playwright expects its Chromium; null while the package is not there. A fresh
// process each time: the answer must come from the package just installed, not from a cache.
function chromiumPath(skillDir) {
  const r = spawnSync(process.execPath, ['-e',
    'process.stdout.write(require(process.argv[1]).chromium.executablePath())',
    path.join(skillDir, 'node_modules', 'playwright-core')], { encoding: 'utf8' });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

// No path on the npm line: `shell` is what lets `npm` (npm.cmd) start on Windows, and a shell
// would split a path with a space in it.
function run(command, args, options) {
  const r = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { ok: r.status === 0, reason: String(r.stderr || r.error || `exit ${r.status}`).trim().split(/\r?\n/).pop() };
}

function ensureDeps({ skillDir, exists = fs.existsSync, browserPath = chromiumPath, exec = run }) {
  const installed = [];
  if (!exists(cliOf(skillDir))) {
    const npm = exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: skillDir, shell: true });
    if (!npm.ok || !exists(cliOf(skillDir))) return `DEPS_FAILED npm install: ${npm.reason || 'no @playwright/test after it'}`;
    installed.push('playwright');
  }
  const browser = browserPath(skillDir);
  if (!browser || !exists(browser)) {
    const chromium = exec(process.execPath, [cliOf(skillDir), 'install', 'chromium'], { cwd: skillDir });
    if (!chromium.ok) return `DEPS_FAILED chromium install: ${chromium.reason}`;
    installed.push('chromium');
  }
  return installed.length ? `DEPS_INSTALLED ${installed.join(',')}` : 'DEPS_READY';
}

if (require.main === module) {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--skill-dir='));
  const skillDir = path.resolve(arg ? arg.slice('--skill-dir='.length) : path.join(__dirname, '..'));
  const line = ensureDeps({ skillDir });
  process.stdout.write(`${line}\n`);
  if (line.startsWith('DEPS_FAILED')) process.exitCode = 1;
}

module.exports = { ensureDeps };
