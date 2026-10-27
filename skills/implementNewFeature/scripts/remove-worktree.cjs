#!/usr/bin/env node
'use strict';

// Removes a finished task's worktree once its work is committed and pushed (SKILL.md, Final
// summary: "Shut down and create pull request"). Never with `--force`, and links first:
// `git worktree remove` deletes the folder recursively, and on Windows that walks through a
// junction - a `node_modules` linked in from the main checkout went with the worktree,
// real files and all. Every symbolic link and junction under the worktree is unlinked
// (the link only, never what it points at) before git is asked to remove it.
//
// Usage: node remove-worktree.cjs --project=<main checkout> --root=<worktree>
// Prints one line, a FIXED IDENTIFIER: `WORKTREE_REMOVED <root>` or `WORKTREE_KEPT <reason>`.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(dir, args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: String((err.stderr || err.message || '')).trim().split('\n')[0] };
  }
}

// One folder however it is spelled: git lists `C:/Users/name/...`, a caller may hold the 8.3
// short form `C:\Users\NAME~1\...` of the same one, and case does not count on Windows.
const same = (a, b) => {
  const k = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* gone already: compare as written */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return k(a) === k(b);
};

function parseArgs(argv) {
  const args = { project: '', root: '' };
  for (const arg of argv) {
    const m = arg.match(/^--(project|root)=(.+)$/);
    if (!m) throw new Error(`Unknown argument ${arg} (expected --project=<main checkout> --root=<worktree>)`);
    if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'root') args.root = m[2];
  }
  if (!args.project || !args.root) throw new Error('--project and --root are required');
  return args;
}

// Every link under `dir`, unlinked without following it; real folders are walked, `.git` is not.
function unlinkLinks(dir) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const p = path.join(dir, entry.name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        fs.unlinkSync(p);
      } catch {
        fs.rmdirSync(p);
      }
      removed.push(p);
    } else if (st.isDirectory()) {
      removed.push(...unlinkLinks(p));
    }
  }
  return removed;
}

function removeWorktree({ project, root }) {
  const main = path.resolve(project);
  const tree = path.resolve(root);
  if (same(main, tree)) return 'WORKTREE_KEPT the task worked in the main checkout itself - there is no worktree to remove';
  const list = git(main, ['worktree', 'list', '--porcelain']);
  if (!list.ok) return `WORKTREE_KEPT ${main} is not a git repository (${list.out})`;
  const listed = list.out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());
  if (!listed.some((p) => same(p, tree))) return `WORKTREE_KEPT ${tree} is not a worktree of ${main}`;
  const status = git(tree, ['status', '--porcelain']);
  if (!status.ok) return `WORKTREE_KEPT cannot read the status of ${tree} (${status.out})`;
  if (status.out.trim()) return `WORKTREE_KEPT ${tree} still has uncommitted changes - commit or move them first`;
  unlinkLinks(tree);
  const removed = git(main, ['worktree', 'remove', tree]);
  if (!removed.ok) return `WORKTREE_KEPT git refused: ${removed.out}`;
  git(main, ['worktree', 'prune']);
  return `WORKTREE_REMOVED ${tree}`;
}

if (require.main === module) {
  let line;
  try {
    line = removeWorktree(parseArgs(process.argv.slice(2)));
  } catch (err) {
    line = `WORKTREE_KEPT ${(err && err.message) || err}`;
  }
  process.stdout.write(`${line}\n`);
  process.exitCode = line.startsWith('WORKTREE_REMOVED') ? 0 : 1;
}

module.exports = { parseArgs, removeWorktree, unlinkLinks };
