#!/usr/bin/env node
'use strict';

// What follows the landing of one fixPr target, in one call: its threads closed on GitHub, every
// comment checked against the agent's verdicts, the app its visual check left running stopped, its
// worktree taken down, what happened kept in the run file for the summary - and, with
// --land-next=yes, the next part of its stack moved onto it (restack.cjs land).
//
// On 2026-11-16 these were five hand-written calls per part, chained by the orchestrator through
// eight landings, each a place to drop a flag or a step. They read everything from the run file and
// the agent's `<reportPath>.result.json`; a held part landed by restack.cjs or a conflict agent
// passes that landing's commit with --commit and --pushed.
//
// --resolve-only=yes runs the thread step alone again, for a target that landed and pushed but
// whose threads stayed open (a 401 on every resolve and reply, 2026-11-18): it works with the
// worktree gone (the commit is read from the main repository's object store, after a fetch),
// skips the threads GitHub already shows resolved, posts no second reply naming the same commit,
// and keeps the new state in the target's `outcome`, which fixpr-summary.cjs prints.
//
// Usage: node fixpr-after.cjs --run=<fixpr-run-*.json> --branch=<branch> [--commit=<sha>] [--pushed=yes|no]
//        [--reply=yes|no] [--keep-worktree=yes|no] [--land-next=yes|no] [--push=yes|no] [--resolve-only=yes|no]
// Prints one JSON object: { branch, resolve, verify, removed, keptReports, keptWorktree, cascade,
// next, warnings, errors }. `resolve.failed` and `resolve.replyFailed` hold one `{ error, count,
// ids }` per distinct error. `next` is the next part's landing (restack.cjs --summary=yes), or
// `{ branch, waiting: true }` while that part's agent still works. --resolve-only prints
// { branch, resolveOnly, resolve, warnings, errors }.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript } = require('./fixpr-launch.cjs');
const { updateRunFile } = require('./run-file.cjs');

function parseArgs(argv) {
  const args = { run: '', branch: '', commit: '', pushed: '', reply: 'yes', keepWorktree: 'no', landNext: 'no', push: 'yes', resolveOnly: 'no' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'run') args.run = m[2];
    else if (m[1] === 'branch') args.branch = m[2];
    else if (m[1] === 'commit') args.commit = m[2].trim();
    else if (m[1] === 'pushed') args.pushed = m[2].trim();
    else if (m[1] === 'reply') args.reply = m[2].trim();
    else if (m[1] === 'keep-worktree') args.keepWorktree = m[2].trim();
    else if (m[1] === 'land-next') args.landNext = m[2].trim();
    else if (m[1] === 'push') args.push = m[2].trim();
    else if (m[1] === 'resolve-only') args.resolveOnly = m[2].trim();
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --run, --branch, --commit, --pushed, --reply, --keep-worktree, --land-next, --push, --resolve-only).`);
  if (!args.run || !args.branch) throw new Error('--run and --branch are required.');
  if (!['yes', 'no'].includes(args.resolveOnly)) throw new Error('--resolve-only takes yes or no.');
  return args;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const git = (dir, args) => {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: res.status === 0, out: String(res.stdout || '').trim(), err: String(res.stderr || res.error || '').trim() };
};

const fetchFailed = (target) => `Could not fetch origin/${target.branch}; reading the commit from the objects the repository already has.`;

// Where the commit is read for the threads' files: the worktree, or - once it is gone (removed
// after the landing, or a crash) - the main checkout, whose object store every worktree shares.
// The commit may have been pushed from another checkout since: fetch first.
function threadRoot(target, project, runGit, warnings, fetched = false) {
  if (target.worktree && fs.existsSync(target.worktree) && runGit(target.worktree, ['rev-parse', '--git-dir']).ok) return target.worktree;
  if (!fetched && !runGit(project, ['fetch', '--quiet', 'origin', target.branch]).ok) warnings.push(fetchFailed(target));
  return project;
}

const resolveArgs = (project, target, ids, result, root, commit, reply, extra = []) => {
  const via = Object.entries((result && result.fixedVia) || {}).map(([id, paths]) => `${id}:${[].concat(paths).join('|')}`).join(';');
  return [`--project=${project}`, `--threads=${ids.join(',')}`, `--comments=${target.commentsPath}`, `--root=${root}`, `--commit=${commit}`, ...(via ? [`--via=${via}`] : []), ...(reply === 'no' ? ['--no-reply'] : []), ...extra];
};

// Tracked changes that are someone's work: what an install rewrote (husky's helpers, worktree.cjs
// installArtefacts) is not, and kept every worktree of 2026-11-18 as "it holds uncommitted work".
const gitDirty = (worktree) => {
  const own = require('./worktree.cjs').ownChanges(worktree);
  return own !== null && own.length > 0;
};

// `[{ id, error }]` → `[{ error, count, ids }]`, one entry per distinct error. On 2026-11-18 a
// refused token failed all 26 resolves and all 26 replies of one part with the same sentence, and
// the answer repeated it 52 times; every id is still here, under the error it got.
function groupFailures(list) {
  const byError = new Map();
  for (const f of list || []) {
    const error = (f && f.error) || 'unknown failure';
    if (!byError.has(error)) byError.set(error, { error, count: 0, ids: [] });
    const g = byError.get(error);
    g.count += 1;
    g.ids.push(f && f.id);
  }
  return [...byError.values()];
}

// How many items a grouped (or a plain, older) failure list stands for.
const failureCount = (list) => (list || []).reduce((n, f) => n + (f && typeof f.count === 'number' ? f.count : 1), 0);

function after(options, deps = {}) {
  if (options.resolveOnly === 'yes') return resolveOnly(options, deps);
  const run = deps.run || runScript;
  const dirty = deps.dirty || gitDirty;
  const runGit = deps.git || git;
  const scripts = { resolve: path.join(__dirname, 'resolve-threads.cjs'), verify: path.join(__dirname, 'verify-fix.cjs'), worktree: path.join(__dirname, 'worktree.cjs'), restack: path.join(__dirname, 'restack.cjs'), processes: path.join(__dirname, '..', '..', 'implementNewFeature', 'scripts', 'task-processes.cjs') };
  const data = JSON.parse(fs.readFileSync(options.run, 'utf8'));
  const target = (data.targets || []).find((t) => t.branch === options.branch);
  if (!target) throw new Error(`${options.branch} is not a target of ${options.run}.`);
  const project = data.project || path.dirname(options.run);
  const resultFile = `${target.reportPath}.result.json`;
  const result = readJson(resultFile);
  const out = { branch: target.branch, resolve: null, verify: null, removed: false, keptReports: [], warnings: [], errors: [] };
  const committed = Boolean(options.commit) || Boolean(result && result.committed);
  const commit = options.commit || (result && result.commit) || null;
  const pushed = options.pushed ? options.pushed === 'yes' : Boolean(result && result.pushed);

  // The threads its agent fixed, closed only once the fix is pushed.
  const ids = (result && result.type === 'result' && result.fixedThreadIds) || [];
  if (target.local) out.resolve = { skipped: 'a --local run has no thread' };
  else if (ids.length === 0) out.resolve = { skipped: 'no thread fixed' };
  else if (!committed || !pushed) out.resolve = { skipped: committed ? 'not pushed' : 'nothing committed' };
  else {
    const root = threadRoot(target, project, runGit, out.warnings);
    const res = run(scripts.resolve, resolveArgs(project, target, ids, result, root, commit, options.reply)) || {};
    out.resolve = { resolved: (res.resolved || []).length, failed: groupFailures(res.failed), unverified: res.unverified || [], replyFailed: groupFailures(res.replyFailed), ...((res.errors || []).length ? { errors: res.errors } : {}) };
  }

  // Every item of the comments file held against the agent's verdicts.
  if (result) {
    const verified = run(scripts.verify, [`--comments=${target.commentsPath}`, `--result=${resultFile}`, `--project=${project}`, `--remote=${pushed ? 'yes' : 'no'}`]) || {};
    try {
      fs.writeFileSync(`${target.reportPath}.verify.json`, `${JSON.stringify(verified, null, 1)}\n`, 'utf8');
    } catch (err) {
      out.warnings.push(`Could not write ${target.reportPath}.verify.json: ${(err && err.message) || err}`);
    }
    out.verify = { ok: Boolean(verified.ok), total: verified.total || 0, gaps: Object.fromEntries(['unaccounted', 'noGround', 'inconsistent', 'mediaNotSeen', 'stillOpen', 'newSinceRun'].map((k) => [k, (verified[k] || []).length]).filter(([, n]) => n > 0)) };
  } else out.verify = { ok: false, missing: `${resultFile} - the agent left no verdicts` };

  // The worktree, unless it holds work or the run must keep it.
  const keep = options.keepWorktree === 'yes' ? 'kept on request (--keep-worktree)'
    : !result || result.type === 'error' ? 'the agent ended without a result: its work is for the user to inspect'
      : target.worktree && dirty(target.worktree) ? 'it holds uncommitted work' : null;
  if (keep) out.keptWorktree = { path: target.worktree, reason: keep };
  else {
    run(scripts.processes, ['cleanup', `--task-dir=${path.join(target.checksDir, 'visual')}`]);
    const removed = run(scripts.worktree, ['--action=remove', `--branch=${target.branch}`, `--project=${project}`]) || {};
    out.removed = Boolean(removed.removed);
    out.keptReports = removed.keptReports || [];
    out.warnings.push(...(removed.warnings || []));
    if ((removed.errors || []).length && !removed.removed) out.keptWorktree = { path: target.worktree, reason: removed.errors[0] };
    // The main checkout's node_modules gone or emptied during the remove: every later worktree
    // would install instead of linking, and the user's own checkout cannot build. Said as an error.
    if (removed.mainModulesLost) {
      out.errors.push(...(removed.errors || []));
      out.mainModulesLost = (removed.errors || [])[0] || 'the node_modules of the main checkout was lost';
    }
  }

  // A new commit under the open parts above that no run names: they move after it (restack cascade).
  const above = (target.stack && target.stack.above) || [];
  if (pushed && above.length > 0) out.cascade = { stack: [target.branch, ...above].join(';'), from: target.branch, fromOldTip: target.remoteTipAtStart || null };

  target.outcome = {
    commit, commitMessage: (result && result.commitMessage) || null, committed, pushed, landedBy: options.commit ? 'landing' : 'agent', reply: options.reply === 'no' ? 'no' : 'yes',
    resolve: out.resolve, verify: out.verify, removed: out.removed, keptReports: out.keptReports, keptWorktree: out.keptWorktree || null,
    ...(out.mainModulesLost ? { mainModulesLost: out.mainModulesLost } : {}),
  };

  // The next part of the stack, moved onto this one now that it has landed.
  let landedChild = null;
  if (options.landNext === 'yes') {
    const child = (data.targets || []).find((t) => t.stack && t.stack.parent === target.branch && t.landing === 'hold');
    if (child) {
      const childResult = readJson(`${child.reportPath}.result.json`);
      // No landing on a main checkout whose node_modules is gone: its gate would run without
      // dependencies, and the next worktree would install instead of linking. The user installs
      // first; --resume (fixpr-resume.cjs) then names this landing again.
      if (out.mainModulesLost) out.next = { branch: child.branch, held: true, reason: 'the node_modules of the main checkout was lost: install it there first' };
      else if (!childResult) out.next = { branch: child.branch, waiting: true };
      else if (childResult.type === 'error') out.next = { branch: child.branch, agentError: true };
      else {
        const landed = run(scripts.restack, ['--action=land', `--run=${options.run}`, `--branch=${child.branch}`, `--push=${options.push || 'yes'}`, '--summary=yes', ...(childResult.committed ? ['--pending-steps=build'] : [])]) || {};
        out.next = landed;
        child.landingResult = landed;
        landedChild = child;
      }
    }
  }
  // Read again right before the write: the landing above and the other targets' scripts write
  // the same file while this one runs (a launch of the resume, a parallel fixpr-after).
  updateRunFile(options.run, (fresh) => {
    for (const t of fresh.targets || []) {
      if (t.branch === target.branch) t.outcome = target.outcome;
      if (landedChild && t.branch === landedChild.branch) t.landingResult = landedChild.landingResult;
    }
  });
  return out;
}

// The thread step alone, again: for a target fixpr-after already handled whose threads stayed open.
function resolveOnly(options, deps = {}) {
  const run = deps.run || runScript;
  const runGit = deps.git || git;
  const data = JSON.parse(fs.readFileSync(options.run, 'utf8'));
  const target = (data.targets || []).find((t) => t.branch === options.branch);
  if (!target) throw new Error(`${options.branch} is not a target of ${options.run}.`);
  const project = data.project || path.dirname(options.run);
  const out = { branch: target.branch, resolveOnly: true, resolve: null, warnings: [], errors: [] };
  const o = target.outcome;
  if (!o) {
    out.errors.push(`${target.branch} has no outcome in ${options.run} yet: run fixpr-after.cjs without --resolve-only first.`);
    return out;
  }
  const result = readJson(`${target.reportPath}.result.json`);
  const ids = (result && result.type === 'result' && result.fixedThreadIds) || [];
  const commit = options.commit || o.commit || null;
  const reply = options.reply === 'no' || o.reply === 'no' ? 'no' : 'yes';
  // Pushed is what origin holds now, not what the run once wrote: a push made after the crash
  // counts, and a commit origin does not have is never claimed as addressed.
  let pushed = Boolean(o.pushed);
  if (commit) {
    if (!runGit(project, ['fetch', '--quiet', 'origin', target.branch]).ok) out.warnings.push(fetchFailed(target));
    pushed = runGit(project, ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${target.branch}`]).ok;
  }
  if (target.local) out.resolve = { skipped: 'a --local run has no thread' };
  else if (ids.length === 0) out.resolve = { skipped: 'no thread fixed' };
  else if (!commit) out.resolve = { skipped: 'nothing committed' };
  else if (!pushed) out.resolve = { skipped: `not pushed: origin/${target.branch} does not hold ${String(commit).slice(0, 12)}` };
  else {
    const root = threadRoot(target, project, runGit, out.warnings, true);
    const res = run(path.join(__dirname, 'resolve-threads.cjs'), resolveArgs(project, target, ids, result, root, commit, reply, ['--skip-resolved'])) || {};
    const already = (res.alreadyResolved || []).length;
    out.resolve = {
      resolved: (res.resolved || []).length + already, alreadyResolved: already, failed: groupFailures(res.failed), unverified: res.unverified || [],
      replyFailed: groupFailures(res.replyFailed), ...((res.errors || []).length ? { errors: res.errors } : {}), resolveOnly: new Date().toISOString(),
    };
    out.warnings.push(...(res.errors || []));
  }
  // Read again right before the write: another target's fixpr-after may have written meanwhile. A
  // skip keeps the earlier answer, which says more.
  updateRunFile(options.run, (fresh) => {
    const t = (fresh.targets || []).find((x) => x.branch === target.branch);
    t.outcome = { ...t.outcome, commit, pushed, resolve: out.resolve.skipped && t.outcome.resolve && !t.outcome.resolve.skipped ? t.outcome.resolve : out.resolve };
  });
  return out;
}

function main() {
  let result;
  try {
    result = after(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, after, resolveOnly, threadRoot, groupFailures, failureCount };

if (require.main === module) main();
