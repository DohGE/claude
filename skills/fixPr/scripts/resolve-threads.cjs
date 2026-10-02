#!/usr/bin/env node
'use strict';

// Closes the review threads a run actually fixed.
//
// Only the ids the caller names are touched, and the caller names exactly the
// threads its fixing agent reported as `fixed` after the commit was pushed.
// Resolving a thread is a claim to every reviewer on the pull request that their
// comment was addressed - so a thread whose fix was rejected, deferred or never
// pushed must never appear in `--threads`, and nothing in this script infers an
// id on its own.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const prApi = require('./pr-api.cjs');

function parseArgs(argv) {
  const args = { project: process.cwd(), threads: [], dryRun: false, comments: null, root: null, commit: null };
  const unknown = [];
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=([\s\S]*)$/);
    // A mistyped flag stops the run: this writes to a real pull request, and a
    // dropped `--dry-run` would resolve threads that were meant to be rehearsed.
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'threads') args.threads = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'comments' || m[1] === 'root' || m[1] === 'commit') args[m[1]] = m[2];
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --project, --threads, --comments, --root, --commit, --dry-run).`);
  }
  if (args.threads.length === 0) throw new Error('No threads given (expected --threads="<id>,<id>").');
  const proof = ['comments', 'root', 'commit'].filter((k) => args[k]);
  if (proof.length > 0 && proof.length < 3) throw new Error('--comments, --root and --commit go together: the commit is checked against the files of the threads.');
  return args;
}

// GitHub's secondary rate limit fires on mutative requests sent back to back, so
// a run closing twenty threads could trip it half way and leave the pull request
// in a state nobody asked for. One second between calls is what their guidance
// asks for, and it costs nothing when there is only one thread.
function pause() {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, 1000);
}

// The files a commit changed, both sides of a rename, as `git show` names them.
function changedFiles(root, commit) {
  const out = execFileSync('git', ['-C', root, 'show', '--name-status', '--format=', commit], { encoding: 'utf8' });
  const files = new Set();
  for (const line of out.split(/\r?\n/)) {
    for (const file of line.split('\t').slice(1)) if (file) files.add(file.replace(/\\/g, '/'));
  }
  return files;
}

// A thread is closed only when the commit touches the file it was left on: the agent's word that
// it fixed the comment is not proof enough for a public "addressed". The others come back as
// `unverified`, left open for the user.
function verifiedThreads(options, files = null) {
  if (!options.commit) return { ids: [...options.threads], unverified: [] };
  const threads = (JSON.parse(fs.readFileSync(options.comments, 'utf8')).threads || []);
  const pathOf = new Map(threads.map((t) => [t.id, t.path ? String(t.path).replace(/\\/g, '/') : null]));
  const changed = files || changedFiles(options.root, options.commit);
  const ids = [];
  const unverified = [];
  for (const id of options.threads) {
    const file = pathOf.get(id);
    if (file && changed.has(file)) ids.push(id);
    else unverified.push({ id, path: file || null, reason: file ? `commit ${options.commit} does not change ${file}` : 'no such thread in the comments file' });
  }
  return { ids, unverified };
}

function resolveAll(options, api = prApi, wait = pause, files = null) {
  const project = path.resolve(options.project || process.cwd());
  const result = {
    project, resolved: [], failed: [], unverified: [], errors: [], dryRun: Boolean(options.dryRun),
  };
  const { ids, unverified } = verifiedThreads(options, files);
  result.unverified = unverified;
  if (options.dryRun) {
    result.resolved = ids;
    return result;
  }
  ids.forEach((id, index) => {
    if (index > 0) wait();
    const { resolved, error } = api.resolveThread(project, id);
    if (resolved) result.resolved.push(id);
    else result.failed.push({ id, error: error || 'unknown failure' });
  });
  // A failed resolve is never fatal to the run: the fix is committed and pushed,
  // and an unresolved thread is a cosmetic leftover the user can close by hand.
  // It is reported, not raised.
  return result;
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    // A run on a replayed review (pr-comments.cjs --replay) has no pull request to write to.
    if (process.env.DOH_FIXPR_REPLAY) args.dryRun = true;
    result = resolveAll(args);
  } catch (err) {
    result = { resolved: [], failed: [], unverified: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, resolveAll, verifiedThreads };

if (require.main === module) main();
