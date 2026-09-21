#!/usr/bin/env node
'use strict';

// Brings a freshly created git worktree to the state the pipeline's later steps
// assume: the project's dependency tree installed, and the gitignored `.env*`
// files copied across.
//
// It is a script rather than a paragraph in SKILL.md for the reason checks.cjs
// gives for the gate: command discovery stops being re-derived, and differently,
// on every run. The two halves already existed, tested, inside fixPr's
// worktree.cjs - which creates its worktrees for a different lifecycle (an
// existing branch with an origin to push to) but bootstraps them identically -
// so this reuses those exports instead of restating them in prose. The prose
// restatement had already drifted: it named neither the install timeout nor the
// folders the copier refuses to walk, so an orchestrator following it literally
// recursed through `node_modules` looking for `.env` files.

const fs = require('node:fs');
const path = require('node:path');

const { detectPackageManager, installDependencies, copyEnvFiles } = require('../../fixPr/scripts/worktree.cjs');

function parseArgs(argv) {
  const args = { project: process.cwd(), root: '' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    // Refused, not skipped: a dropped `--root` would install into the user's own
    // checkout instead of the task's worktree.
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'root') args.root = m[2];
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --project, --root).`);
  }
  if (!args.root) throw new Error('No worktree given (expected --root=<path>).');
  return args;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function bootstrap(options) {
  const project = path.resolve(options.project || process.cwd());
  const root = path.resolve(options.root);
  const result = {
    project, root, installed: false, manager: null, envFiles: [], warnings: [], errors: [],
  };
  if (!isDirectory(root)) {
    result.errors.push(`Not a directory: ${root}`);
    return result;
  }
  // `ROOT === PROJECT` is the first task of a run: it works in the user's own
  // checkout, which already has its dependencies and its `.env*` files. Installing
  // over them would be a long no-op at best and a `npm ci` wiping a locally patched
  // `node_modules` at worst, and copying a file onto itself is nothing at all.
  if (root === project) {
    result.installed = fs.existsSync(path.join(root, 'node_modules'));
    result.manager = detectPackageManager(root);
    result.warnings.push('The task works in the project checkout itself, so nothing was installed or copied.');
    return result;
  }

  result.envFiles = copyEnvFiles(project, root);
  const deps = installDependencies(root);
  result.manager = deps.manager;
  result.installed = Boolean(deps.manager) && !deps.error;
  if (deps.error) {
    // Not fatal here either: the implementation agent writes code without a
    // dependency tree, and step 5 is the one that needs it. Saying so is what keeps
    // a failed install from reading as "the feature broke the build".
    result.warnings.push(`${deps.manager} install failed in the worktree, so the suites of step 5 will not run: ${deps.error}`);
  } else if (!deps.manager && fs.existsSync(path.join(root, 'package.json'))) {
    result.warnings.push('No lockfile in the worktree, so no dependencies were installed. Commit a lockfile to have step 5 run the suites.');
  }
  return result;
}

function main() {
  let result;
  try {
    result = bootstrap(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { installed: false, envFiles: [], warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, bootstrap };

if (require.main === module) main();
