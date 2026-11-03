#!/usr/bin/env node
'use strict';

// Lands a part of a stack - a pull request whose base is another branch of the same run - once
// its parent has landed: moves its held commit onto where the parent stands now, runs the gate
// when the move brought new code under it, and pushes with a lease pinned to where the branch
// stood when the run began.
//
// Why a script and not each fixing agent's own rebase: on 2026-11-03 five parts of one stack
// were fixed side by side and each rebased at its own finish. part-1 rebased onto master
// rewrote the commits part-2 sat on, and part-2's plain `git rebase origin/part-1` then replayed
// the old part-1 commits against the new ones and conflicted; part-4 finished before part-3
// pushed, rebased onto nothing and stayed on the old part-3. `--onto <parent now> <parent at
// start>` moves only the part's own commits, and landing bottom-up is what makes "the parent
// now" final. The parts were moved this way by hand afterwards, without a conflict past part-2.
//
// Usage:
//   node restack.cjs --action=land --worktree=<dir> --branch=<part> --parent=<branch>
//        [--parent-tip-at-start=<sha>] [--remote-tip-at-start=<sha>] [--checks-dir=<dir>]
//        [--push=yes|no] [--gate=yes|no]
//   node restack.cjs --action=verify --project=<dir> --pairs="<parent>><child>[@<old tip>],..."
// Prints one JSON object. land: `status` is landed | conflict | gate-red | push-rejected | error.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checksScript = path.join(__dirname, 'checks.cjs');

function parseArgs(argv) {
  const args = { action: 'land', push: 'yes', gate: 'yes', parentTipAtStart: '', remoteTipAtStart: '', checksDir: '', pairs: [] };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    const value = m[2].trim();
    if (m[1] === 'action') args.action = value;
    else if (m[1] === 'worktree') args.worktree = value;
    else if (m[1] === 'branch') args.branch = value;
    else if (m[1] === 'parent') args.parent = value;
    else if (m[1] === 'parent-tip-at-start') args.parentTipAtStart = value;
    else if (m[1] === 'remote-tip-at-start') args.remoteTipAtStart = value;
    else if (m[1] === 'checks-dir') args.checksDir = value;
    else if (m[1] === 'push') args.push = value;
    else if (m[1] === 'gate') args.gate = value;
    else if (m[1] === 'project') args.project = value;
    else if (m[1] === 'pairs') args.pairs = parsePairs(value);
    else unknown.push(arg);
  }
  // This script rewrites and pushes a branch: a mistyped flag stops it.
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --action, --worktree, --branch, --parent, --parent-tip-at-start, --remote-tip-at-start, --checks-dir, --push, --gate, --project, --pairs).`);
  if (!['land', 'verify'].includes(args.action)) throw new Error(`Unknown --action=${args.action} (expected land|verify).`);
  if (!['yes', 'no'].includes(args.push) || !['yes', 'no'].includes(args.gate)) throw new Error('--push and --gate take yes or no.');
  if (args.action === 'land' && (!args.worktree || !args.branch || !args.parent)) throw new Error('land needs --worktree, --branch and --parent.');
  if (args.action === 'verify' && (!args.project || args.pairs.length === 0)) throw new Error('verify needs --project and --pairs.');
  return args;
}

function parsePairs(text) {
  return String(text).split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const m = pair.match(/^([^>@\s]+)>([^>@\s]+)(?:@([0-9a-fA-F]{4,40}))?$/);
    if (!m) throw new Error(`Not a pair: ${pair} (expected <parent>><child>[@<old tip>]).`);
    return { parent: m[1], child: m[2], oldTip: m[3] || null };
  });
}

function git(dir, args, env) {
  const res = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', windowsHide: true, env: env ? { ...process.env, ...env } : process.env,
  });
  return { ok: res.status === 0, out: String(res.stdout || '').trim(), err: String(res.stderr || res.error || '').trim() };
}

const firstLine = (text) => String(text || '').split(/\r?\n/).find((l) => l.trim()) || '';

// The gate after a move, the fixing agent's own: checks.cjs on what the pull request changes.
function defaultGate({ worktree, checksDir, parent }) {
  const res = spawnSync(process.execPath, [checksScript, `--root=${worktree}`, `--out-dir=${checksDir}`, `--changed-since=origin/${parent}`], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  try {
    return JSON.parse(String(res.stdout || '').trim().split(/\r?\n/).pop());
  } catch {
    return { gate: 'error', steps: [], errors: [firstLine(res.stderr) || 'checks.cjs printed no result'] };
  }
}

const gateSummary = (gate) => ({
  gate: gate.gate,
  steps: (gate.steps || []).map((s) => ({ label: s.label, status: s.status, reason: s.reason || '', errorsPath: s.errorsPath || null, logPath: s.logPath || null })),
  errors: gate.errors || [],
});

function land(options, { runGate = defaultGate } = {}) {
  const tree = path.resolve(options.worktree);
  const { branch, parent } = options;
  const result = {
    action: 'land', branch, parent, status: 'error', rebased: false, pushed: false, commit: null,
    oldParentTip: null, newParentTip: null, conflictFiles: [], gate: null, warnings: [], errors: [],
  };
  const fail = (message) => {
    result.errors.push(message);
    return result;
  };
  if (!git(tree, ['rev-parse', '--git-dir']).ok) return fail(`Not a git worktree: ${tree}`);
  // A tracked file the install touched (husky's line endings, 2026-11-03) is no reason to leave a
  // part behind: the rebase stashes it and puts it back, and only commits are pushed.
  if (git(tree, ['status', '--porcelain', '--untracked-files=no']).out) result.warnings.push(`${tree} holds uncommitted changes; they stay uncommitted (rebase --autostash).`);

  // Where the branch stood on origin when the run began: the lease. The remote-tracking ref of
  // the worktree is that too, as long as nothing fetched the branch since the worktree was made.
  const lease = options.remoteTipAtStart || git(tree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).out;
  if (!git(tree, ['fetch', '--quiet', 'origin', parent]).ok) result.warnings.push(`Could not fetch origin/${parent}; moving onto the ref the repository already has.`);
  const upstream = `origin/${parent}`;
  const now = git(tree, ['rev-parse', '--verify', '--quiet', upstream]);
  if (!now.ok) return fail(`${upstream} does not exist.`);
  result.newParentTip = now.out;
  const before = git(tree, ['rev-parse', 'HEAD']).out;

  if (!git(tree, ['merge-base', '--is-ancestor', upstream, 'HEAD']).ok) {
    const forkPoint = options.parentTipAtStart || git(tree, ['merge-base', '--fork-point', upstream, 'HEAD']).out || git(tree, ['merge-base', upstream, 'HEAD']).out;
    if (!forkPoint) return fail(`No old tip of ${parent} to move ${branch} off: give --parent-tip-at-start.`);
    result.oldParentTip = forkPoint;
    // rerere: a conflict resolved once (by hand, or by the conflict agent of an earlier run) is
    // resolved the same way the next time this part moves.
    const rebase = git(tree, ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true', 'rebase', '--autostash', '--onto', upstream, forkPoint], { GIT_EDITOR: 'true' });
    if (!rebase.ok) {
      for (let round = 0; round < 50; round += 1) {
        const unmerged = git(tree, ['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean);
        if (unmerged.length > 0 || !inRebase(tree)) {
          result.conflictFiles = unmerged;
          break;
        }
        // Every conflict of this commit was resolved from rerere's record: go on.
        if (git(tree, ['-c', 'rerere.enabled=true', 'rebase', '--continue'], { GIT_EDITOR: 'true' }).ok) break;
      }
      if (inRebase(tree)) {
        git(tree, ['rebase', '--abort']);
        result.status = 'conflict';
        return result;
      }
    }
    result.rebased = true;
  }

  if (result.rebased && options.gate !== 'no') {
    const checksDir = options.checksDir ? path.resolve(options.checksDir) : path.join(tree, '..', `${path.basename(tree)}-restack-checks`);
    const gate = runGate({ worktree: tree, checksDir, parent });
    result.gate = gateSummary(gate);
    if (gate.gate !== 'green' && gate.gate !== 'skipped') {
      // `--keep`, not `--hard`: an uncommitted file the move did not touch stays as it was.
      if (!git(tree, ['reset', '--keep', before]).ok) result.warnings.push(`Could not take ${branch} back to ${before}; it holds the moved commits.`);
      result.status = 'gate-red';
      return result;
    }
  }

  result.commit = git(tree, ['rev-parse', 'HEAD']).out;
  if (options.push === 'no') {
    result.status = 'landed';
    return result;
  }
  const remote = git(tree, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).out;
  if (!result.rebased && remote === result.commit) {
    result.warnings.push('Nothing to push: the branch is where origin has it.');
    result.status = 'landed';
    return result;
  }
  // A rewritten branch replaces the remote one only where it still stands where the run began.
  const pushArgs = result.rebased
    ? (lease ? ['push', `--force-with-lease=${branch}:${lease}`, 'origin', branch] : null)
    : ['push', 'origin', branch];
  if (!pushArgs) return fail(`No remote tip to pin the lease to for ${branch}; push it yourself once checked.`);
  const pushed = git(tree, pushArgs);
  if (!pushed.ok) {
    result.status = 'push-rejected';
    result.errors.push(firstLine(pushed.err.split(/\r?\n/).find((l) => /rejected|stale|error/i.test(l)) || pushed.err));
    return result;
  }
  result.pushed = true;
  result.status = 'landed';
  return result;
}

function inRebase(tree) {
  const dir = git(tree, ['rev-parse', '--absolute-git-dir']).out;
  return Boolean(dir) && (fs.existsSync(path.join(dir, 'rebase-merge')) || fs.existsSync(path.join(dir, 'rebase-apply')));
}

// After a run: every part that does not sit on its parent, with the command that moves it.
function verify(options) {
  const project = path.resolve(options.project);
  const result = { action: 'verify', ok: [], broken: [], warnings: [], errors: [] };
  const branches = [...new Set(options.pairs.flatMap((p) => [p.parent, p.child]))];
  if (!git(project, ['fetch', '--quiet', 'origin', ...branches]).ok) result.warnings.push('Could not fetch every branch; compared the refs the repository already has.');
  for (const { parent, child, oldTip } of options.pairs) {
    const name = `${parent}>${child}`;
    if (git(project, ['merge-base', '--is-ancestor', `origin/${parent}`, `origin/${child}`]).ok) {
      result.ok.push(name);
      continue;
    }
    const from = oldTip || git(project, ['merge-base', `origin/${parent}`, `origin/${child}`]).out || `<old ${parent} tip>`;
    result.broken.push({ parent, child, command: `git rebase --onto origin/${parent} ${from} ${child}` });
  }
  return result;
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    result = args.action === 'verify' ? verify(args) : land(args);
  } catch (err) {
    result = { status: 'error', errors: [String((err && err.message) || err)], warnings: [] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors && result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, parsePairs, land, verify };

if (require.main === module) main();
