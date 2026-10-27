#!/usr/bin/env node
'use strict';

// The implementation step's exit gate for the project's TDD rule: every changed file of a kind
// whose behaviour is tested has its spec in the same change. Measured on a run that skipped it:
// validation reported 100% compliance and the review that followed still found three missing
// unit tests - each one a review finding, a fix round and a re-run that a list printed by a
// script before the agent reported would have saved.
//
// It reports, it does not refuse: whether a component has behaviour, or a refactor of a service
// needs a new case, is the agent's call. `missing` is a new file with no spec anywhere - the
// agent writes it or says in `deviations` why the file needs none; `untested` is a modified file
// whose spec the change did not touch.
//
// Usage: node tdd-gate.cjs --root=<working directory> --base=<ref the branch started from>
// Prints one JSON object: { checked, missing: [{ file, specs }], untested: [{ file, specs }] }.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The kinds the project CLAUDE.md lists under "Applies to": services, NgRx effects, reducers and
// selectors, components, plus the other units that carry logic of their own.
const tested = /\.(service|effects|reducer|selectors|facade|guard|interceptor|resolver|pipe|directive|component|validator|validators|util|utils|helper|helpers|store)\.(ts|js|mjs|cjs)$/;
const isSpec = (p) => /\.(spec|test)\.(ts|js|mjs|cjs)$/.test(p);

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const args = { root: '', base: '' };
  for (const arg of argv) {
    const m = arg.match(/^--(root|base)=(.+)$/);
    if (!m) throw new Error(`Unknown argument ${arg} (expected --root=<dir> --base=<ref>)`);
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'base') args.base = m[2];
  }
  if (!args.root || !args.base) throw new Error('--root and --base are required');
  return args;
}

// The change as it stands - commits since the base, staged and unstaged edits, new files - as
// { path: 'A' | 'M' }. A rename counts as added: its spec has to follow it.
function changedFiles(root, base) {
  const files = new Map();
  for (const line of git(root, ['diff', '--name-status', '--find-renames', base]).split('\n')) {
    const [status, ...paths] = line.trim().split('\t');
    if (!status || status.startsWith('D')) continue;
    files.set(paths[paths.length - 1], status.startsWith('M') ? 'M' : 'A');
  }
  for (const p of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').map((l) => l.trim()).filter(Boolean)) {
    files.set(p, 'A');
  }
  return files;
}

// Where a file's spec may live: beside it, or in a `tests`/`__tests__`/`spec` folder next to it.
function specCandidates(file) {
  const dir = path.posix.dirname(file);
  const stem = path.posix.basename(file).replace(/\.(ts|js|mjs|cjs)$/, '');
  const ext = path.posix.extname(file);
  return ['', 'tests', '__tests__', 'spec'].flatMap((sub) => ['spec', 'test']
    .map((kind) => path.posix.join(dir, sub, `${stem}.${kind}${ext}`)));
}

function gate({ root, base }, { exists = (p) => fs.existsSync(path.join(root, p)), changed = changedFiles(root, base) } = {}) {
  const specsChanged = new Set([...changed.keys()].filter(isSpec).map((p) => path.posix.basename(p)));
  const missing = [];
  const untested = [];
  let checked = 0;
  for (const [file, status] of changed) {
    if (isSpec(file) || !tested.test(file) || /\.d\.ts$/.test(file)) continue;
    checked++;
    const candidates = specCandidates(file);
    const names = new Set(candidates.map((c) => path.posix.basename(c)));
    if ([...names].some((n) => specsChanged.has(n))) continue;
    const present = candidates.filter(exists);
    if (status === 'A' && present.length === 0) missing.push({ file, specs: candidates.slice(0, 2) });
    else untested.push({ file, specs: present.length ? present : candidates.slice(0, 2) });
  }
  return { checked, missing, untested };
}

if (require.main === module) {
  let out;
  try {
    out = gate(parseArgs(process.argv.slice(2)));
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = out.error ? 1 : 0;
}

module.exports = { parseArgs, gate, specCandidates, changedFiles };
