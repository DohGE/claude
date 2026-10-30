#!/usr/bin/env node
'use strict';

// A restore point of a task's worktree at the end of a step: everything staged and changed, kept
// as a commit object under refs/doh/<task>/step-<n> - not on any branch, never pushed, and the
// working tree and the index are left exactly as they were. The pipeline never commits until the
// pull request, so a step that broke or lost files - a spec rebuilt from Jest's cache, a refused
// commit's hook dropping every staged file - had nothing in git to go back to.
//
// Restore one file:   git -C <root> checkout refs/doh/<task>/step-<n> -- <path>
// Restore everything: git -C <root> stash apply --index refs/doh/<task>/step-<n>
//
// Usage: node checkpoint.cjs --root=<worktree> --task=<taskId> --step=<n>
// Prints `CHECKPOINT <ref> <sha>`, or `CHECKPOINT_NONE` when nothing differs from HEAD (FIXED IDENTIFIERS).

const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const args = { root: '', task: '', step: 0 };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'task') args.task = m[2];
    else if (m[1] === 'step') args.step = Number(m[2]);
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!args.root) throw new Error('--root=<worktree> is required');
  if (!/^[A-Za-z0-9_-]+$/.test(args.task)) throw new Error('--task=<id> is required');
  if (!(args.step >= 1 && args.step <= 9)) throw new Error('--step=<1-9> is required');
  return args;
}

function checkpoint({ root, task, step }) {
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  // Untracked files are not in a stash commit; the pipeline stages everything anyway.
  const add = git('add', '-A');
  if (add.status !== 0) throw new Error(`git add failed: ${String(add.stderr).trim()}`);
  const sha = String(git('stash', 'create', `doh ${task} step ${step}`).stdout || '').trim();
  if (!sha) return 'CHECKPOINT_NONE';
  const ref = `refs/doh/${task}/step-${step}`;
  const update = git('update-ref', ref, sha);
  if (update.status !== 0) throw new Error(`git update-ref failed: ${String(update.stderr).trim()}`);
  return `CHECKPOINT ${ref} ${sha.slice(0, 12)}`;
}

if (require.main === module) {
  try {
    process.stdout.write(`${checkpoint(parseArgs(process.argv.slice(2)))}\n`);
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, checkpoint };
