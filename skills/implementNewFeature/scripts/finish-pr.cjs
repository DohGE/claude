#!/usr/bin/env node
'use strict';

// The "Create pull request" flow as one script (SKILL.md, Final summary): the pre-commit gate, the
// commit, proof that the commit happened, the push and the pull request - each one only after the
// one before it succeeded. Chained by hand in a shell, a refused commit once went unnoticed behind a
// pipe, the branch was pushed without it, and the commit tried again "to see the error" ran the
// project's lint-staged a second time, whose restore dropped every staged file of the task. Here a
// refused commit stops the flow, nothing is retried, and staged work that vanished is put back from
// a snapshot taken right before the commit.
//
// Usage: node finish-pr.cjs --root=<worktree> --task-dir=<SESSION>/tasks/<id> --branch=<branch> --base=<branch>
//          --message=<commit message> [--body-file=<path>] [--amend] [--push=<branch>,<branch>…] [--no-pr]
// `--amend` folds what is staged into HEAD with its own message (a split task's last part);
// `--push` names every branch to push (a split task's parts; default: --branch); `--no-pr` stops
// after the push (a split task opens one pull request per part with create-pr.cjs).
// Prints, one per line and stopping at the first failure (FIXED IDENTIFIERS):
//   PRECOMMIT_FAILED <errorsPath>; NOTHING_TO_COMMIT or COMMITTED <sha>;
//   COMMIT_REFUSED <log> then CHANGES_KEPT, CHANGES_RESTORED or CHANGES_LOST <snapshot>;
//   PUSHED <branch> or PUSH_FAILED <branch> <reason>; then create-pr.cjs's PR_CREATED / PR_EXISTS / PR_FAILED.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runChecks } = require('../../fixPr/scripts/checks.cjs');
const { createPr } = require('./create-pr.cjs');

function parseArgs(argv) {
  const args = { root: '', taskDir: '', branch: '', base: '', message: '', bodyFile: '', amend: false, push: [], pr: true };
  for (const arg of argv) {
    if (arg === '--amend') { args.amend = true; continue; }
    if (arg === '--no-pr') { args.pr = false; continue; }
    const m = arg.match(/^--([a-z-]+)=([\s\S]*)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'task-dir') args.taskDir = m[2];
    else if (m[1] === 'branch') args.branch = m[2];
    else if (m[1] === 'base') args.base = m[2];
    else if (m[1] === 'message') args.message = m[2];
    else if (m[1] === 'body-file') args.bodyFile = m[2];
    else if (m[1] === 'push') args.push = m[2].split(',').map((b) => b.trim()).filter(Boolean);
    else throw new Error(`Unknown argument ${arg}`);
  }
  for (const key of ['root', 'taskDir', 'branch']) if (!args[key].trim()) throw new Error(`--${key === 'taskDir' ? 'task-dir' : key} is required`);
  if (!args.amend && !args.message.trim()) throw new Error('--message is required (or --amend)');
  if (args.pr && !args.base.trim()) throw new Error('--base is required to open a pull request');
  if (!args.push.length) args.push = [args.branch];
  return args;
}

const gitIn = (root) => (args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: String(r.stdout || '').trim() };
};
const listOf = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
const firstLine = (text) => (listOf(text)[0] || '').slice(0, 300);

function finishPr(options, seams = {}) {
  const git = seams.git || gitIn(options.root);
  const lines = [];
  const say = (line) => { lines.push(line); if (seams.onLine) seams.onLine(line); };
  const taskId = path.basename(path.resolve(options.taskDir)).replace(/[^A-Za-z0-9_-]/g, '-') || 'task';

  git(['add', '-A']);
  const staged = listOf(git(['diff', '--cached', '--name-only']).stdout);
  if (!staged.length && !options.amend) {
    say('NOTHING_TO_COMMIT');
  } else {
    // What `git commit` would run, run first and without lint-staged's backup stash: a red gate
    // stops here, before the commit gets a chance to run it with one.
    const gate = (seams.checks || runChecks)({ root: options.root, outDir: path.join(options.taskDir, 'checks'), only: ['precommit'] });
    const step = (gate.steps || []).find((s) => s.step === 'precommit');
    if (step && step.status === 'failed') {
      say(`PRECOMMIT_FAILED ${step.errorsPath || step.logPath || ''}`.trim());
      return { lines, ok: false };
    }
    git(['add', '-A']);
    const before = listOf(git(['status', '--porcelain']).stdout);
    const head = git(['rev-parse', 'HEAD']).stdout;
    // The snapshot holds the index and the working tree without touching either.
    const snapshot = git(['stash', 'create']).stdout;
    if (snapshot) git(['update-ref', `refs/doh/${taskId}/before-commit`, snapshot]);
    const commit = git(options.amend ? ['commit', '--amend', '--no-edit'] : ['commit', '-m', options.message]);
    const logDir = path.join(options.taskDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, 'commit.log');
    fs.writeFileSync(log, commit.out);
    const after = git(['rev-parse', 'HEAD']).stdout;
    if (commit.status !== 0 || !after || after === head) {
      say(`COMMIT_REFUSED ${log.replace(/\\/g, '/')}`);
      const now = listOf(git(['status', '--porcelain']).stdout);
      if (now.length >= before.length) say('CHANGES_KEPT');
      else if (snapshot && git(['stash', 'apply', '--index', snapshot]).status === 0) say('CHANGES_RESTORED');
      else say(`CHANGES_LOST ${snapshot || 'no snapshot'}`);
      return { lines, ok: false };
    }
    say(`COMMITTED ${after.slice(0, 12)}`);
  }

  for (const branch of options.push) {
    const push = git(options.amend ? ['push', '--force-with-lease', '-u', 'origin', branch] : ['push', '-u', 'origin', branch]);
    if (push.status !== 0) {
      say(`PUSH_FAILED ${branch} ${firstLine(push.out.split('\n').filter((l) => /error|rejected|fatal|denied/i.test(l)).join('\n') || push.out)}`);
      return { lines, ok: false };
    }
    say(`PUSHED ${branch}`);
  }

  if (!options.pr) return { lines, ok: true };
  const pr = (seams.createPr || createPr)({ root: options.root, head: options.branch, base: options.base,
    title: firstLine(options.message) || options.branch, bodyFile: options.bodyFile });
  say(pr);
  return { lines, ok: !pr.startsWith('PR_FAILED') };
}

if (require.main === module) {
  let result;
  try {
    result = finishPr(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { lines: [`PR_FAILED ${(err && err.message) || err}`], ok: false };
  }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { parseArgs, finishPr };
