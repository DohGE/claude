#!/usr/bin/env node
'use strict';

// The isolated checkout each branch is fixed in, created and torn down here so
// the user's own working tree is never touched by a run.
//
// The refusals below are the point of this file. A worktree that quietly starts
// from a stale local branch produces a commit built on code the reviewer never
// saw and a push that either fails or overwrites someone else's work - so every
// state that cannot end in a clean fast-forward push is refused by name, with
// the command that fixes it, instead of being forced through.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { sanitizeBranchName, countOf } = require('../../codeReview/scripts/review-context.cjs');

const bootstrapTimeoutMs = 10 * 60 * 1000;

function parseArgs(argv) {
  const args = { action: 'add', branch: '', project: process.cwd(), worktree: '', bootstrap: true };
  const unknown = [];
  for (const arg of argv) {
    if (arg === '--no-bootstrap') {
      args.bootstrap = false;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    // This script removes directories, so a mistyped flag must stop it rather
    // than fall back to a default: a dropped `--worktree=` on a remove would
    // otherwise aim the removal at whatever the default formula computes.
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'action') args.action = m[2];
    else if (m[1] === 'branch') args.branch = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'worktree') args.worktree = m[2];
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --action, --branch, --project, --worktree, --no-bootstrap).`);
  }
  if (!['add', 'remove'].includes(args.action)) {
    throw new Error(`Unknown --action=${args.action} (expected add|remove).`);
  }
  if (!args.branch && args.action === 'add') throw new Error('No branch given (expected --branch=<name>).');
  // A remove with neither of them has nothing to aim at: the default formula
  // would compute `fixpr-` from an empty branch name and then report that path
  // as "nothing to remove", which reads as a successful cleanup of a worktree
  // that is in fact still sitting on disk.
  if (!args.branch && !args.worktree && args.action === 'remove') {
    throw new Error('No branch or worktree given (expected --branch=<name> or --worktree=<path>).');
  }
  return args;
}

function git(project, gitArgs, options = {}) {
  return execFileSync('git', ['-C', project, ...gitArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function tryGit(project, gitArgs, options = {}) {
  try {
    return git(project, gitArgs, options);
  } catch {
    return null;
  }
}

// `<parent of project>/<project name>-worktrees/fixpr-<slug>`, the same shape
// implementNewFeature uses - worktrees sit NEXT TO the repository, never inside
// it, so nothing a run creates can ever be picked up as a project file, staged
// by a `git add -A`, or walked by a test runner.
function worktreesDirFor(project) {
  const root = path.resolve(project);
  return path.join(path.dirname(root), `${path.basename(root)}-worktrees`);
}

function worktreePathFor(project, branch) {
  return path.join(worktreesDirFor(project), `fixpr-${sanitizeBranchName(branch)}`);
}

// The parent is tidied away only when it is the one this skill invents. With an
// explicit `--worktree=<path>` the parent belongs to the caller - an empty
// directory of theirs is still theirs, and removing it is not part of taking a
// worktree down.
function removeOwnParent(project, worktree) {
  const parent = path.dirname(path.resolve(worktree));
  if (parent !== worktreesDirFor(project)) return;
  try {
    fs.rmdirSync(parent);
  } catch {
    // another branch still has a worktree here
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Which worktree, if any, already holds this branch. `git worktree list
// --porcelain` prints a `worktree <path>` line followed by the `branch
// refs/heads/<name>` it has checked out, and the main checkout is one of them -
// which is exactly the case a user hits by running the skill on the branch they
// are standing on.
// git prints POSIX separators on every platform, so the answer is resolved back
// to a native path: a caller comparing it with one of ours would otherwise never
// match on Windows and read "held by nobody" off a branch that is held.
function worktreeHolding(project, branch) {
  const out = tryGit(project, ['worktree', 'list', '--porcelain']);
  if (!out) return null;
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    const at = line.match(/^worktree (.*)$/);
    if (at) { current = at[1].trim(); continue; }
    const on = line.match(/^branch refs\/heads\/(.*)$/);
    if (on && on[1].trim() === branch) return current ? path.resolve(current) : null;
  }
  return null;
}

function refExists(project, ref) {
  return tryGit(project, ['rev-parse', '--verify', '--quiet', ref]) !== null;
}

// Where the branch stands against its remote, which decides whether a fix can
// end in a plain `git push`:
// - `remote-only`  - nothing local yet; the worktree is created from origin.
// - `in-sync`      - identical; nothing to reconcile.
// - `behind`       - the worktree fast-forwards onto origin before any fixing.
// - `ahead`        - local commits not pushed yet; they ride along, push works.
// - `diverged`     - both moved; no push can succeed without a decision this
//                    script has no business making, so the branch is refused.
// - `local-only`   - no remote branch at all; the push would need `-u`, and a
//                    pull request always has a remote branch, so this means the
//                    branch was never the one the PR was opened from.
function branchState(project, branch) {
  const local = refExists(project, `refs/heads/${branch}`);
  const remote = refExists(project, `refs/remotes/origin/${branch}`);
  if (!local && !remote) return { state: 'missing' };
  if (!local) return { state: 'remote-only' };
  if (!remote) return { state: 'local-only' };
  // Through `countOf`, never `Number()`: `tryGit` answers null on a failed call and
  // `Number(null)` is 0, so a rev-list that never ran would report the branch as
  // in-sync with origin and the run would fix on top of code the reviewer never saw.
  const ahead = countOf(tryGit(project, ['rev-list', '--count', `origin/${branch}..${branch}`]));
  const behind = countOf(tryGit(project, ['rev-list', '--count', `${branch}..origin/${branch}`]));
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return { state: 'unknown' };
  if (ahead === 0 && behind === 0) return { state: 'in-sync', ahead, behind };
  if (ahead === 0) return { state: 'behind', ahead, behind };
  if (behind === 0) return { state: 'ahead', ahead, behind };
  return { state: 'diverged', ahead, behind };
}

// Which package manager the project is pinned to, decided by the lockfile it
// committed. `null` means there is no lockfile at all: nothing to install from,
// and a caller that only needs to RUN a script (checks.cjs) supplies its own
// fallback rather than having one guessed here.
function detectPackageManager(root) {
  const has = (name) => fs.existsSync(path.join(root, name));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('package-lock.json')) return 'npm';
  return null;
}

const installCommands = {
  pnpm: ['install', '--frozen-lockfile'],
  yarn: ['install', '--immutable'],
  npm: ['ci'],
};

// Why the HEAD of a failed install and not its tail: every package manager prints its
// diagnosis first and its usage help last. `npm ci` on a lockfile out of sync names the
// missing package in its third line and then forty lines of flag documentation, so the
// last five lines handed the reader "aliases: clean-install, ic, install-clean" as the
// reason their gate cannot run. The prefix-only lines every manager emits between
// paragraphs carry nothing, so dropping them keeps the five that travel real ones.
function installFailure(err) {
  const text = String((err && err.stderr) || (err && err.message) || err);
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(npm|pnpm|yarn)?\s*(error|warn|ERR!)?\s*$/i.test(line))
    .slice(0, 5)
    .join(' ')
    .trim();
}

// A worktree is created from HEAD of the branch, so it carries neither
// `node_modules` nor the gitignored local config the project needs - and the
// gate before the commit runs the project's own lint, tests and build.
// Without this the gate would fail on every branch for want of a dependency
// tree, which reads as "the fixes broke the build".
function installDependencies(root) {
  const manager = detectPackageManager(root);
  if (!manager) return { manager: null, error: null };
  try {
    // A shell is needed on Windows, where every package manager is a `.cmd` shim - and
    // with one, the finished command line is the documented form: Node deprecates
    // concatenating a separate args array into it without escaping (DEP0190). Joining is
    // lossless here because both halves are literals of this file: the manager name and
    // its entry in `installCommands`, neither of which holds a space.
    const useShell = process.platform === 'win32';
    const argv = installCommands[manager];
    execFileSync(useShell ? [manager, ...argv].join(' ') : manager, useShell ? [] : argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: bootstrapTimeoutMs, shell: useShell });
    return { manager, error: null };
  } catch (err) {
    return { manager, error: installFailure(err) };
  }
}

// Folders that never hold a hand-written `.env` and are the ones big enough to
// make a full recursive walk cost real time.
const notWalked = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.angular', '.next', '.nuxt', '.cache', '.turbo', '.idea', '.vscode',
]);

// Every `.env*` file of the project, at the same path relative to the root. They
// are gitignored, so a fresh worktree has none of them, and the one nested in a
// workspace package is the one whose absence looks like an application bug
// rather than a missing file.
function copyEnvFiles(project, root, dir = '') {
  const from = path.join(project, dir);
  let entries;
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return [];
  }
  const copied = [];
  for (const entry of entries) {
    const rel = dir ? path.join(dir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (notWalked.has(entry.name) || entry.name.startsWith('.claude')) continue;
      copied.push(...copyEnvFiles(project, root, rel));
      continue;
    }
    if (!entry.name.startsWith('.env')) continue;
    const target = path.join(root, rel);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(project, rel), target);
      copied.push(rel);
    } catch {
      // best-effort: a file that cannot be copied is reported by its absence
    }
  }
  return copied;
}

function add(options) {
  const project = path.resolve(options.project || process.cwd());
  // The git seam. It exists for the one failure this function has to clean up
  // after - a fast-forward that does not take - which no arrangement of a real
  // repository produces: a branch that is strictly behind always fast-forwards.
  // Everything outside `add` runs the real command.
  const run = options.git || tryGit;
  const branch = options.branch;
  // `installed` answers the one question the gate depends on: does this worktree
  // have a dependency tree it can run lint/test/build against? Every early
  // return below leaves it false, which is the truth for a worktree that was
  // never created.
  const result = { action: 'add', branch, project, worktree: null, created: false, installed: false, warnings: [], errors: [] };

  if (run(project, ['rev-parse', '--git-dir']) === null) {
    result.errors.push(`Not a git repository: ${project}`);
    return result;
  }
  // The pull request's branch as GitHub has it is the only correct starting
  // point, and a repository that has not fetched in a week does not have it.
  if (run(project, ['fetch', 'origin', branch, '--quiet']) === null) {
    result.warnings.push(`Could not fetch origin/${branch}; working from the refs already in the repository.`);
  }

  const held = worktreeHolding(project, branch);
  if (held) {
    result.errors.push(`Branch ${branch} is already checked out in ${held}. Switch that checkout to another branch and re-run; this skill never forces a second worktree onto one branch, because two working copies of one branch diverge silently.`);
    return result;
  }

  const { state, ahead, behind } = branchState(project, branch);
  if (state === 'missing') {
    result.errors.push(`Branch ${branch} exists neither locally nor on origin.`);
    return result;
  }
  if (state === 'local-only') {
    result.errors.push(`Branch ${branch} has no origin/${branch}, so its fixes could never be pushed to the pull request. Push the branch first.`);
    return result;
  }
  if (state === 'diverged') {
    result.errors.push(`Branch ${branch} and origin/${branch} have diverged (${ahead} local, ${behind} remote commit(s)). Reconcile them yourself - rebasing or merging on your behalf is not this skill's call.`);
    return result;
  }
  if (state === 'unknown') {
    result.errors.push(`Could not compare ${branch} with origin/${branch}.`);
    return result;
  }

  const worktree = path.resolve(options.worktree || worktreePathFor(project, branch));
  result.worktree = worktree;
  if (isDirectory(worktree)) {
    result.errors.push(`${worktree} already exists. Remove it (git worktree remove) before starting a new run for this branch.`);
    return result;
  }

  try {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
  } catch {
    // worktree add reports the real failure below
  }
  // `remote-only` has no local branch to check out, so one is created tracking
  // origin. Every other state already has the branch, and `worktree add <path>
  // <branch>` moves it into the new checkout.
  const addArgs = state === 'remote-only'
    ? ['worktree', 'add', worktree, '-b', branch, `origin/${branch}`]
    : ['worktree', 'add', worktree, branch];
  if (run(project, addArgs) === null) {
    result.errors.push(`git worktree add failed for ${branch} at ${worktree}.`);
    return result;
  }
  result.created = true;

  if (state === 'behind') {
    if (run(worktree, ['merge', '--ff-only', `origin/${branch}`]) === null) {
      result.errors.push(`${branch} is ${behind} commit(s) behind origin and could not be fast-forwarded.`);
      // Take the checkout back down. Nothing has been written into it yet - the
      // env files and the dependency install both come later - so git removes it
      // without a --force. Leaving it would turn one failed run into a branch
      // that can never be started again: the next run finds the directory and
      // refuses with "already exists", for a state the user never created.
      if (run(project, ['worktree', 'remove', worktree]) === null) {
        result.warnings.push(`The worktree at ${worktree} could not be removed after that failure; remove it with git worktree remove before the next run.`);
      } else {
        result.created = false;
        removeOwnParent(project, worktree);
      }
      return result;
    }
    result.warnings.push(`Fast-forwarded ${branch} onto origin/${branch} (${behind} commit(s)).`);
  }
  if (state === 'ahead') {
    result.warnings.push(`${branch} carries ${ahead} commit(s) that origin does not have; they will be pushed along with the fixes.`);
  }

  result.envFiles = copyEnvFiles(project, worktree);
  if (options.bootstrap === false) {
    result.dependencies = { manager: null, error: null, skipped: true };
    return result;
  }
  const deps = installDependencies(worktree);
  result.dependencies = deps;
  result.installed = Boolean(deps.manager) && !deps.error;
  if (deps.error) {
    // Not fatal: the fixing itself needs no dependency tree, only the
    // verification gate does. It reports its own failure, and saying so here is
    // what keeps that failure from reading as "the fixes broke the build".
    result.warnings.push(`${deps.manager} install failed in the worktree, so lint/test/build will not run: ${deps.error}`);
  } else if (!deps.manager && fs.existsSync(path.join(worktree, 'package.json'))) {
    // A package.json with no lockfile next to it: nothing could be installed, so
    // the worktree has no node_modules and the gate would fail on a missing
    // dependency rather than on the code. Saying so is what turns a silent
    // "gate skipped" in the summary into something the user can act on.
    result.warnings.push('No lockfile in the worktree, so no dependencies were installed and lint/test/build will not run. Commit a lockfile to have the gate run.');
  }
  return result;
}

function remove(options) {
  const project = path.resolve(options.project || process.cwd());
  const worktree = path.resolve(options.worktree || worktreePathFor(project, options.branch));
  const result = { action: 'remove', branch: options.branch || null, project, worktree, removed: false, warnings: [], errors: [] };
  if (!isDirectory(worktree)) {
    result.warnings.push(`${worktree} does not exist; nothing to remove.`);
    return result;
  }
  // No `--force`, ever. git refuses a worktree holding modified or untracked
  // files, and that refusal is the last guard against deleting work the
  // verification gate stopped from being committed.
  if (tryGit(project, ['worktree', 'remove', worktree]) === null) {
    result.errors.push(`git worktree remove refused ${worktree} - it still holds modified or untracked files. Inspect it, then remove it yourself once nothing there is worth keeping.`);
    return result;
  }
  result.removed = true;
  // The skill's own parent only ever holds its worktrees, so an empty one is
  // litter; rmdir fails harmlessly while another run still has one.
  removeOwnParent(project, worktree);
  return result;
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    result = args.action === 'add' ? add(args) : remove(args);
  } catch (err) {
    result = { errors: [String((err && err.message) || err)], warnings: [] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors && result.errors.length ? 1 : 0);
}

module.exports = {
  parseArgs, worktreePathFor, worktreesDirFor, worktreeHolding, branchState, refExists,
  detectPackageManager, installDependencies, installFailure, copyEnvFiles, add, remove, git, tryGit,
};

if (require.main === module) main();
