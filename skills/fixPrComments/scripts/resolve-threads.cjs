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

const path = require('node:path');

const prApi = require('./pr-api.cjs');

function parseArgs(argv) {
  const args = { project: process.cwd(), threads: [], dryRun: false };
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
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --project, --threads, --dry-run).`);
  }
  if (args.threads.length === 0) throw new Error('No threads given (expected --threads="<id>,<id>").');
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

function resolveAll(options, api = prApi, wait = pause) {
  const project = path.resolve(options.project || process.cwd());
  const result = {
    project, resolved: [], failed: [], errors: [], dryRun: Boolean(options.dryRun),
  };
  if (options.dryRun) {
    result.resolved = [...options.threads];
    return result;
  }
  options.threads.forEach((id, index) => {
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
    result = resolveAll(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { resolved: [], failed: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, resolveAll };

if (require.main === module) main();
