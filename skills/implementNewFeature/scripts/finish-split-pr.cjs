#!/usr/bin/env node
'use strict';

// "Create pull request" for a split task, as one script: the fix-ups folded into their parts,
// every part proven green on its own, every part branch pushed, and one pull request per part -
// part 1 into the base, part n into part n-1, so each shows only its own diff.
//
// It was four calls and a shell loop the orchestrator wrote by hand from two reference files, and
// nothing in it checked a part by itself: five pull requests were opened on a stack whose only
// tested tree was the last part's. Now a part that does not pass the project's lint, typecheck,
// unit tests and build stops the flow before anything is pushed (verify-parts.cjs).
//
// Usage: node finish-split-pr.cjs --root=<the task's worktree> --project=<main checkout> --task-dir=<SESSION>/tasks/<id>
//          --branch=<the form's branch> --base=<base branch> --parts=<N> --message=<commit message>
// Each part's description is <task-dir>/pr-body-<n>.md (pr-body.md when a part has none).
// Prints as it goes, stopping at the first failure (FIXED IDENTIFIERS):
//   split-fixups.cjs's line: FIXUPS_APPLIED {…} | NOTHING_STAGED | FIXUPS_KEPT <reason>
//   after FIXUPS_KEPT, finish-pr.cjs's lines for the amend of the last part: PRECOMMIT_FAILED <errorsPath> |
//     COMMITTED <sha> | COMMIT_REFUSED <log> + CHANGES_KEPT / CHANGES_RESTORED / CHANGES_LOST <snapshot>
//   verify-parts.cjs's lines: PART <n> GREEN | RED … | BLOCKED …, then PARTS_GREEN | PARTS_RED <n,…> | PARTS_BLOCKED <reason>
//   PUSHED <branch> per part | PUSH_FAILED <branch> <reason>
//   PR_CREATED <url> | PR_EXISTS <url> | PR_FAILED <reason>, one per part, in order
// Exit 0 when every part has its pull request.

const fs = require('node:fs');
const path = require('node:path');

const { splitFixups } = require('./split-fixups.cjs');
const { verifyParts } = require('./verify-parts.cjs');
const { finishPr, pushBranches, gitIn, firstLine } = require('./finish-pr.cjs');
const { createPr } = require('./create-pr.cjs');

function parseArgs(argv) {
  const args = { root: '', project: '', taskDir: '', branch: '', base: '', parts: 0, message: '' };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=([\s\S]*)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'task-dir') args.taskDir = m[2];
    else if (m[1] === 'branch') args.branch = m[2].trim();
    else if (m[1] === 'base') args.base = m[2].trim();
    else if (m[1] === 'parts') args.parts = Number(m[2]);
    else if (m[1] === 'message') args.message = m[2];
    else throw new Error(`Unknown argument ${arg}`);
  }
  for (const key of ['root', 'taskDir', 'branch', 'base']) if (!args[key]) throw new Error(`--${key === 'taskDir' ? 'task-dir' : key} is required`);
  if (!(Number.isInteger(args.parts) && args.parts >= 2)) throw new Error('--parts=<N> is required (a split task has at least two)');
  if (!args.message.trim()) throw new Error('--message is required: every pull request is titled after it');
  if (!args.project) args.project = args.root;
  return args;
}

function finishSplitPr(options, seams = {}) {
  const lines = [];
  const say = (line) => { lines.push(line); if (seams.onLine) seams.onLine(line); };
  const git = seams.git || gitIn(options.root);
  const partBranch = (n) => `${options.branch}-part-${n}`;
  const stack = { root: options.root, base: options.base, branch: options.branch, parts: options.parts };

  // 1. Whatever the last step left staged goes into the part that wrote the lines it changes.
  const fixups = (seams.splitFixups || splitFixups)(stack);
  say(fixups);
  if (fixups.startsWith('FIXUPS_KEPT')) {
    // What could not be placed stays staged on the last part: it is amended into it, through the
    // project's own pre-commit gate.
    const amend = (seams.finishPr || finishPr)({ root: options.root, taskDir: options.taskDir, branch: partBranch(options.parts),
      base: options.base, message: '', amend: true, push: [], pr: false }, { onLine: say });
    if (!amend.ok) return { lines, ok: false };
  }

  // 2. Every part on its own: lint, typecheck, unit tests, build.
  const verified = (seams.verifyParts || verifyParts)({ ...stack, project: options.project, taskDir: options.taskDir,
    only: ['lint', 'typecheck', 'test', 'build'], part: 0 });
  for (const line of verified.lines) say(line);
  if (verified.verdict !== 'PARTS_GREEN') return { lines, ok: false };

  // 3. The parts were rebuilt by the fix-ups, so they go with a lease.
  const branches = Array.from({ length: options.parts }, (_, i) => partBranch(i + 1));
  if (!pushBranches(git, branches, true, say)) return { lines, ok: false };

  // 4. One pull request per part, each on the part before it.
  const title = firstLine(options.message) || options.branch;
  let ok = true;
  for (let n = 1; n <= options.parts; n++) {
    const own = path.join(options.taskDir, `pr-body-${n}.md`);
    const shared = path.join(options.taskDir, 'pr-body.md');
    const bodyFile = fs.existsSync(own) ? own : fs.existsSync(shared) ? shared : '';
    const line = (seams.createPr || createPr)({ root: options.root, head: partBranch(n), base: n === 1 ? options.base : partBranch(n - 1),
      title: `${title} (part ${n}/${options.parts})`, bodyFile });
    say(line);
    if (line.startsWith('PR_FAILED')) ok = false;
  }
  return { lines, ok };
}

if (require.main === module) {
  let result;
  try {
    result = finishSplitPr(parseArgs(process.argv.slice(2)), { onLine: (line) => process.stdout.write(`${line}\n`) });
  } catch (err) {
    process.stdout.write(`PR_FAILED ${(err && err.message) || err}\n`);
    result = { ok: false };
  }
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { parseArgs, finishSplitPr };
