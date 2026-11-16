#!/usr/bin/env node
'use strict';

// The Playwright toolchain of the plugin's visual checks, installed once per machine: the
// `@playwright/test` package in skills/implementNewFeature and its Chromium.
//
// fixPr's fix agents look at a template or style fix in the running app (fix-agent step 5b). On
// 2026-11-16 one of them found the package missing, ran `npm install` and `playwright install
// chromium` itself in the middle of its run, and its check still gave no verdict. The fixPr
// orchestrator runs this in the background while the worktrees are made; an agent that still finds
// the CLI missing runs it once itself.
//
// Usage: node ensure-playwright.cjs [--dir=<skills/implementNewFeature>]
// Prints one JSON object: { ready, steps, errors }. Installing an already present browser is quick.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const args = { dir: path.resolve(__dirname, '..') };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'dir') args.dir = m[2];
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --dir).`);
  return args;
}

const defaultRun = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' && /npm/.test(cmd), maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60 * 1000 });

function ensure(options, { exists = fs.existsSync, run = defaultRun } = {}) {
  const dir = path.resolve(options.dir);
  const cli = path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js');
  const result = { ready: false, steps: [], errors: [] };
  const failed = (step, res) => `${step} failed: ${String((res && (res.stderr || res.stdout)) || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || `exit ${res && res.status}`}`;
  if (!exists(cli)) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = run(npm, ['--prefix', dir, 'install', '--no-audit', '--no-fund', '--silent']);
    result.steps.push('npm install');
    if (!res || res.status !== 0) {
      result.errors.push(failed('npm install', res));
      return result;
    }
  }
  const browser = run(process.execPath, [cli, 'install', 'chromium']);
  result.steps.push('chromium');
  if (!browser || browser.status !== 0) {
    result.errors.push(failed('playwright install chromium', browser));
    return result;
  }
  result.ready = true;
  return result;
}

function main() {
  let result;
  try {
    result = ensure(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { ready: false, steps: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ready ? 0 : 1);
}

module.exports = { parseArgs, ensure };

if (require.main === module) main();
