#!/usr/bin/env node
'use strict';

// The gate of a split task, part by part: every part branch must pass the project's own lint,
// typecheck, unit tests and build ON ITS OWN, because every part is a pull request of its own and
// CI runs on each.
//
// The parts are built one after another, so part n is green when it is committed. What breaks
// one later is a fix: the reviews and validation fix on top of the LAST part, and split-fixups.cjs
// folds each fix into the part that wrote the lines it touches - a fix in part 2's file that
// calls a helper part 4 adds leaves parts 2 and 3 unable to compile, while the whole feature,
// which is all the pipeline ever built, stays green. This checks what the pipeline never did:
// each part's tree, checked out by itself in a throwaway worktree, through the same gate
// (fixPr's checks.cjs: `.claude/doh/checks.json` when the project has one, scoped to the files
// THAT part changed; its package.json scripts otherwise).
//
// Usage: node verify-parts.cjs --root=<the task's worktree> --project=<main checkout> --base=<base branch>
//          --branch=<the form's branch> --parts=<N> --task-dir=<SESSION>/tasks/<id>
//          [--only=lint,typecheck,test,build] [--part=<n>]
// A part whose tree was verified green before (the same tree on the same parent) is not run
// again, so the call before "Create pull request" costs nothing when nothing moved since.
// Prints, per part and then once (FIXED IDENTIFIERS), and writes results/parts.json:
//   PART <n> GREEN [verified before] | PART <n> RED <step>=<errorsPath>[, …] | PART <n> BLOCKED <reason>
//   PARTS_GREEN | PARTS_RED <n>[,<n>…] | PARTS_BLOCKED <reason>          exit 0 | 1 | 3

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runChecks, gateSteps } = require('../../fixPr/scripts/checks.cjs');
const { provideDependencies, copyEnvFiles, copyLocalFiles, copyDohConfig } = require('../../fixPr/scripts/worktree.cjs');
const { unlinkLinks } = require('./remove-worktree.cjs');

const STEPS = gateSteps.map((s) => s.step);

function parseArgs(argv) {
  const args = { root: '', project: '', base: '', branch: '', parts: 0, taskDir: '', only: [...STEPS], part: 0 };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'base') args.base = m[2].trim();
    else if (m[1] === 'branch') args.branch = m[2].trim();
    else if (m[1] === 'parts') args.parts = Number(m[2]);
    else if (m[1] === 'task-dir') args.taskDir = m[2];
    else if (m[1] === 'only') args.only = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'part') args.part = Number(m[2]);
    else throw new Error(`Unknown argument ${arg}`);
  }
  for (const key of ['root', 'base', 'branch', 'taskDir']) if (!args[key]) throw new Error(`--${key === 'taskDir' ? 'task-dir' : key} is required`);
  if (!(Number.isInteger(args.parts) && args.parts >= 1)) throw new Error('--parts=<N> is required');
  if (args.part && !(Number.isInteger(args.part) && args.part >= 1 && args.part <= args.parts)) throw new Error(`--part is 1..${args.parts}`);
  const unknown = args.only.filter((s) => !STEPS.includes(s));
  if (unknown.length || !args.only.length) throw new Error(`--only takes ${STEPS.join(', ')}${unknown.length ? ` (not ${unknown.join(', ')})` : ''}`);
  if (!args.project) args.project = args.root;
  return args;
}

const gitIn = (root) => (args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { status: r.status, stdout: String(r.stdout || '').trim(), out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
};
const slash = (p) => String(p || '').replace(/\\/g, '/');
const first = (text) => (String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '').slice(0, 300);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

// A part's tree checked out by itself, with what a checkout lacks: the dependencies (linked from
// the main checkout when the lockfile is the same one, installed otherwise) and the gitignored
// local config. Detached, so the part's branch stays free for split-fixups to move.
function checkoutPart({ root, project, dir, commit }, git) {
  fs.rmSync(dir, { recursive: true, force: true });
  git(['worktree', 'prune']);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const add = git(['worktree', 'add', '--detach', dir, commit]);
  if (add.status !== 0) return `the part could not be checked out: ${first(add.out)}`;
  copyEnvFiles(project, dir);
  copyLocalFiles(project, dir);
  copyDohConfig(project, dir);
  const deps = provideDependencies(project, dir);
  return deps.error ? `its dependencies could not be provided: ${first(deps.error)}` : null;
}

// The links go first: `git worktree remove --force` follows a node_modules junction and deletes
// the main checkout's dependencies through it.
function removePart(dir, git) {
  try {
    unlinkLinks(dir);
  } catch { /* nothing linked */ }
  git(['worktree', 'remove', '--force', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  git(['worktree', 'prune']);
}

function verifyParts(args, seams = {}) {
  const git = seams.git || gitIn(args.root);
  const checks = seams.checks || runChecks;
  const checkout = seams.checkout || checkoutPart;
  const remove = seams.remove || removePart;
  const lines = [];
  const finish = (verdict) => {
    lines.push(verdict);
    const result = { verdict: verdict.split(' ')[0], lines, at: new Date().toISOString() };
    try {
      fs.mkdirSync(path.join(args.taskDir, 'results'), { recursive: true });
      fs.writeFileSync(path.join(args.taskDir, 'results', 'parts.json'), `${JSON.stringify(result, null, 2)}\n`);
    } catch { /* stdout is the record then */ }
    return result;
  };

  const tips = [];
  for (let n = 1; n <= args.parts; n++) {
    const sha = git(['rev-parse', '--verify', '--quiet', `refs/heads/${args.branch}-part-${n}^{commit}`]);
    if (sha.status !== 0 || !sha.stdout) return finish(`PARTS_BLOCKED no branch ${args.branch}-part-${n}`);
    tips.push(sha.stdout);
  }
  const start = git(['merge-base', args.base, tips[0]]).stdout;
  if (!start) return finish(`PARTS_BLOCKED ${args.branch}-part-1 does not start from ${args.base}`);

  const cacheFile = path.join(args.taskDir, 'checks', 'parts-verified.json');
  const cache = readJson(cacheFile);
  const red = [];
  const blocked = [];
  for (let n = 1; n <= args.parts; n++) {
    if (args.part && args.part !== n) continue;
    const commit = tips[n - 1];
    const parent = n === 1 ? start : tips[n - 2];
    const key = `${git(['rev-parse', `${commit}^{tree}`]).stdout}:${git(['rev-parse', `${parent}^{tree}`]).stdout}:${args.only.join(',')}`;
    if (cache[key] === 'green') {
      lines.push(`PART ${n} GREEN verified before`);
      continue;
    }
    const files = git(['diff', '--name-only', '--diff-filter=d', parent, commit]).stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Beside the task's worktree, on the same drive, and short: long paths break tools on Windows.
    const dir = path.join(path.dirname(path.resolve(args.root)), '.doh-parts', `${path.basename(path.resolve(args.taskDir))}-part-${n}`);
    let why = null;
    let result = null;
    try {
      why = checkout({ root: args.root, project: args.project, dir, commit }, git);
      if (!why) result = checks({ root: dir, outDir: path.join(args.taskDir, 'checks', `part-${n}`), only: args.only, changedFiles: files });
    } catch (err) {
      why = first((err && err.message) || err);
    } finally {
      remove(dir, git);
    }
    if (!why && (result.errors || []).length) why = first(result.errors[0]);
    if (why) {
      blocked.push(n);
      lines.push(`PART ${n} BLOCKED ${why}`);
      continue;
    }
    const failed = (result.steps || []).filter((s) => s.status === 'failed');
    if (failed.length) {
      red.push(n);
      lines.push(`PART ${n} RED ${failed.map((s) => `${s.step}=${slash(s.errorsPath || s.logPath || 'no excerpt')}`).join(', ')}`);
      continue;
    }
    lines.push(`PART ${n} GREEN`);
    cache[key] = 'green';
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    } catch { /* the next call verifies it again */ }
  }
  if (red.length) return finish(`PARTS_RED ${red.join(',')}`);
  if (blocked.length) return finish(`PARTS_BLOCKED part ${blocked.join(',')} could not be verified`);
  return finish('PARTS_GREEN');
}

if (require.main === module) {
  let result;
  try {
    result = verifyParts(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { verdict: 'PARTS_BLOCKED', lines: [`PARTS_BLOCKED ${(err && err.message) || err}`] };
  }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exitCode = result.verdict === 'PARTS_GREEN' ? 0 : result.verdict === 'PARTS_RED' ? 1 : 3;
}

module.exports = { parseArgs, verifyParts, checkoutPart, removePart };
