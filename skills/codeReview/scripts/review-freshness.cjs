#!/usr/bin/env node
'use strict';

// What of a branch no codeReview has read: the commits and files newer than its last review.
//
// On 2026-11-06, 9 of the 24 review threads on the DPXN-11967 pull requests sat on code the
// branch's review of 2026-11-02 never saw - the CR commits of 2026-11-05/06 were pushed and
// reviewed by people only. A review is only as good as its date; this names what is newer, and
// the command that reviews just that (`--since-last` skips every file whose content the last
// review already read).
//
// The last review is the branch's snapshot (review-context.cjs writes
// `<codeReview>/cache/<branch>/.last-review-branch.json` on every run): its `revision` - the
// commit it read - and, for a snapshot written before revisions were kept, the blob of every
// reviewed file and the time of the run.
//
// Usage: node review-freshness.cjs --project=<dir> --branches="a;b" [--bases="a=master;b=a"] [--root=<codeReview folder>]
// Prints one JSON object: { branches: [{ branch, reviewedAt, revision, unreviewedCommits,
// changedFiles, command }], warnings }. `reviewedAt` null: the branch was never reviewed here.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sanitizeBranchName } = require('./review-context.cjs');

function parseArgs(argv) {
  const args = { project: process.cwd(), branches: [], root: '' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'branches') args.branches = m[2].split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'bases') args.bases = Object.fromEntries(m[2].split(/[;,]/).map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1]));
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --project, --branches, --root, --bases).`);
  if (args.branches.length === 0) throw new Error('No branches given (expected --branches="a;b").');
  return args;
}

function git(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return res.status === 0 ? String(res.stdout).trim() : null;
}

// The codeReview folder of a project: `.claude/doh/codeReview` when the project keeps a
// `.claude/` folder (the skill's own convention), else nothing to read.
function defaultRoot(project) {
  return path.join(project, '.claude', 'doh', 'codeReview');
}

function freshnessOf(project, branch, root, base = '') {
  const out = { branch, reviewedAt: null, revision: null, unreviewedCommits: null, changedFiles: [], command: `/doh:codeReview ${branch} --since-last` };
  let snap = null;
  try {
    snap = JSON.parse(fs.readFileSync(path.join(root, 'cache', sanitizeBranchName(branch), '.last-review-branch.json'), 'utf8'));
  } catch {
    out.command = `/doh:codeReview ${branch}`;
    return out;
  }
  out.reviewedAt = snap.at || null;
  out.revision = snap.revision || null;
  const tip = git(project, ['rev-parse', '--verify', '--quiet', `origin/${branch}^{commit}`]) || git(project, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  if (!tip) return out;
  const ref = tip;
  if (snap.revision && git(project, ['merge-base', '--is-ancestor', snap.revision, ref]) !== null) {
    out.unreviewedCommits = Number(git(project, ['rev-list', '--count', `${snap.revision}..${ref}`]) || 0);
    out.changedFiles = (git(project, ['diff', '--name-only', snap.revision, ref]) || '').split(/\r?\n/).filter(Boolean);
    return out;
  }
  // A rebased branch, or a snapshot without its revision: the commits made after the review,
  // and every reviewed file whose content is not what the review read.
  // Commit times compared here, not by `--since`, which reads an ISO time with a zone loosely.
  const after = Date.parse(snap.at || '') / 1000;
  const later = [];
  if (Number.isFinite(after)) {
    // Only the branch's own commits: a rebase onto a newer base brings the base's commits, made
    // after the review too, and those are not this pull request's.
    const own = base && git(project, ['rev-parse', '--verify', '--quiet', `origin/${base}`]) ? [ref, `^origin/${base}`] : [ref];
    for (const block of (git(project, ['log', '--format=%x00%ct', '--name-only', '-n', '500', ...own]) || '').split('\0').filter((b) => b.trim())) {
      const [time, ...files] = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (Number(time) > after) later.push(files);
    }
    out.unreviewedCommits = later.length;
  }
  const now = new Map((git(project, ['ls-tree', '-r', ref]) || '').split(/\r?\n/).map((l) => l.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/)).filter(Boolean).map((m) => [m[2], m[1]]));
  const changed = new Set(Object.entries(snap.files || {}).filter(([p, blob]) => now.get(p) !== blob).map(([p]) => p));
  for (const files of later) for (const p of files) changed.add(p);
  if (base && git(project, ['rev-parse', '--verify', '--quiet', `origin/${base}`])) {
    const mine = new Set((git(project, ['diff', '--name-only', `origin/${base}...${ref}`]) || '').split(/\r?\n/).filter(Boolean));
    for (const p of [...changed]) if (!mine.has(p)) changed.delete(p);
  }
  out.changedFiles = [...changed].sort();
  return out;
}

function check(options) {
  const project = path.resolve(options.project);
  const root = options.root ? path.resolve(options.root) : defaultRoot(project);
  const bases = options.bases || {};
  const branches = options.branches.map((b) => freshnessOf(project, b, root, bases[b] || ''));
  const warnings = branches.filter((b) => b.reviewedAt === null || b.unreviewedCommits > 0 || b.changedFiles.length > 0).map((b) => (b.reviewedAt === null
    ? `${b.branch}: no codeReview of this branch on record - reviewers see code no review read (${b.command}).`
    : `${b.branch}: ${b.unreviewedCommits || 0} commit(s) and ${b.changedFiles.length} file(s) newer than its last codeReview (${b.reviewedAt}) - reviewed by nobody yet (${b.command}).`));
  return { branches, warnings };
}

function main() {
  let result;
  try {
    result = check(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { branches: [], warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors ? 1 : 0);
}

module.exports = { parseArgs, freshnessOf, check };

if (require.main === module) main();
