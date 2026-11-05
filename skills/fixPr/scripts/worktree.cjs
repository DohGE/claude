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
const { unlinkLinks } = require('../../implementNewFeature/scripts/remove-worktree.cjs');

const bootstrapTimeoutMs = 10 * 60 * 1000;

const depsModes = ['auto', 'install', 'link'];

function parseArgs(argv) {
  const args = { action: 'add', branch: '', project: process.cwd(), worktree: '', bootstrap: true, deps: 'auto' };
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
    else if (m[1] === 'deps') args.deps = m[2];
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --action, --branch, --project, --worktree, --deps, --no-bootstrap).`);
  }
  if (!['add', 'remove'].includes(args.action)) {
    throw new Error(`Unknown --action=${args.action} (expected add|remove).`);
  }
  if (!depsModes.includes(args.deps)) {
    throw new Error(`Unknown --deps=${args.deps} (expected ${depsModes.join('|')}).`);
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

const lockfileOf = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' };

const sameText = (a, b) => {
  try {
    return fs.readFileSync(a, 'utf8').replace(/\r\n/g, '\n') === fs.readFileSync(b, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return false;
  }
};

const unlinkOne = (p) => {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
};

// The main checkout's `node_modules`, linked in (a junction on Windows) instead of installed
// again: five worktrees installed one after another took about twenty minutes before the first
// fixing agent could start (2026-11-03). Only for a lockfile identical to the checkout's, so the
// tree is the one this branch asks for, and only when git ignores the link - a `node_modules/`
// pattern matches no link, and the link would then be one `git add` away from a commit.
// The link is the danger `remove` unlinks first: git's recursive delete walks into a junction.
// Whether the main checkout's `node_modules` holds what its package.json declares. On
// 2026-11-05 it held two folders of ~1000 (@babel, @nx - emptied the day before): five worktrees
// linked it, five agents found the gate dead one after another, each spent turns on why, and
// two ran `npm ci` against an unreachable registry. Answered before the link, it stops the run
// with one sentence the user can act on.
function dependencyHealth(project) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  } catch {
    return { ok: true, missing: [], declared: 0 };
  }
  const names = [...new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})])];
  const missing = names.filter((name) => !fs.existsSync(path.join(project, 'node_modules', name, 'package.json')));
  return { ok: missing.length === 0, missing, declared: names.length };
}

const entriesOf = (dir) => {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return null;
  }
};

function linkDependencies(project, root, manager, isIgnored = (dir) => tryGit(dir, ['check-ignore', '-q', 'node_modules']) !== null) {
  const lock = lockfileOf[manager];
  const source = path.join(project, 'node_modules');
  const target = path.join(root, 'node_modules');
  if (!lock || !sameText(path.join(project, lock), path.join(root, lock))) return { linked: false, reason: 'its lockfile differs from the main checkout' };
  if (!isDirectory(source)) return { linked: false, reason: 'the main checkout has no node_modules' };
  const health = dependencyHealth(project);
  if (!health.ok) {
    return {
      linked: false,
      mainBroken: true,
      reason: `the main checkout's node_modules misses ${health.missing.length} of ${health.declared} declared packages (${health.missing.slice(0, 3).join(', ')}${health.missing.length > 3 ? ', …' : ''}): run \`${manager} ${manager === 'npm' ? 'ci' : 'install'}\` in ${project} first - never inside a worktree, whose node_modules is a link to it`,
    };
  }
  if (fs.existsSync(target)) return { linked: false, reason: 'the worktree already has a node_modules' };
  try {
    fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    return { linked: false, reason: `the link could not be made (${(err && err.message) || err})` };
  }
  if (!isIgnored(root)) {
    unlinkOne(target);
    return { linked: false, reason: 'git does not ignore a linked node_modules here' };
  }
  return { linked: true, reason: null };
}

// `mode`: `auto` links when it can and installs otherwise, `install` always installs, `link`
// links or reports why it could not.
function provideDependencies(project, root, { mode = 'auto', install = installDependencies, isIgnored } = {}) {
  const manager = detectPackageManager(root);
  if (!manager) return { manager: null, linked: false, error: null };
  if (mode !== 'install') {
    const link = linkDependencies(project, root, manager, isIgnored);
    if (link.linked) return { manager, linked: true, error: null };
    // A broken main checkout is the user's to repair, once, before the run - not five installs
    // in five worktrees against a registry that may not even answer.
    if (link.mainBroken) return { manager, linked: false, mainBroken: true, error: link.reason };
    if (mode === 'link') return { manager, linked: false, error: `node_modules could not be linked: ${link.reason}` };
  }
  return { ...install(root), linked: false };
}

// The project's doh config lives in its gitignored `.claude/doh/`, so a worktree checked out
// from HEAD has none of it: no rulebook for the fixing agent and its self-review (the run of
// 2026-11-03 reviewed without the project's naming rules), no gate config for checks.cjs.
// Copied only where git ignores it in the worktree - a tracked `.claude/doh/` is checked out
// already, and a copy there would be an untracked file `remove` then refuses over.
const dohConfigEntries = ['local', 'instructions', 'checks.json'];

function copyMissing(from, to, rel) {
  let st;
  try {
    st = fs.statSync(from);
  } catch {
    return [];
  }
  if (st.isDirectory()) {
    return fs.readdirSync(from).flatMap((name) => copyMissing(path.join(from, name), path.join(to, name), `${rel}/${name}`));
  }
  if (fs.existsSync(to)) return [];
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return [rel];
  } catch {
    return [];
  }
}

function copyDohConfig(project, root, isIgnored = (rel) => tryGit(root, ['check-ignore', '-q', rel]) !== null) {
  return dohConfigEntries.flatMap((entry) => {
    const rel = `.claude/doh/${entry}`;
    return isIgnored(rel) ? copyMissing(path.join(project, rel), path.join(root, rel), rel) : [];
  });
}

// The self-review writes its report into the worktree (`.claude/doh/codeReview/runs/`), which
// git ignores and `git worktree remove` deletes with the rest: the summary of 2026-11-03
// pointed at five reports that were gone. They move next to the run's other artifacts first.
function keepReports(project, worktree, branch) {
  const from = path.join(worktree, '.claude', 'doh', 'codeReview', 'runs');
  if (!isDirectory(from) || !isDirectory(path.join(project, '.claude'))) return { dir: null, reports: [] };
  const dir = path.join(project, '.claude', 'doh', sanitizeBranchName(branch), 'codeReview', 'runs');
  fs.cpSync(from, dir, { recursive: true, force: false, errorOnExist: false });
  const reports = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/^raport\.(md|html)$/.test(entry.name)) reports.push(p);
    }
  };
  walk(dir);
  return { dir, reports: reports.sort() };
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

// The other local-only config a checkout keeps out of git and an app will not start without:
// `*.local.*` files such as `proxy.dpx.local.js` or `environment.local.ts`. Only what git
// IGNORES and does not track is copied - a tracked file of that name is in the worktree already,
// and copying the checkout's edited copy over it would carry uncommitted work across.
// Measured on a dpx worktree: without its `proxy.dpx.local.js` the dev server never came up,
// and two E2E runs failed with 32 times ERR_CONNECTION_REFUSED before anyone looked at a file.
const isLocalConfig = (name) => /(^|\.)local\.[A-Za-z0-9]+$/.test(name) && !name.startsWith('.env');

function copyLocalFiles(project, root, list = () => tryGit(project, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'])) {
  const copied = [];
  for (const rel of String(list() || '').split('\n').map((line) => line.trim()).filter(Boolean)) {
    // `--directory` collapses an ignored folder (node_modules/, dist/) into one entry.
    if (rel.endsWith('/') || !isLocalConfig(path.basename(rel))) continue;
    const parts = rel.split('/');
    if (parts.some((part) => notWalked.has(part) || part.startsWith('.claude'))) continue;
    const target = path.join(root, rel);
    if (fs.existsSync(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(project, rel), target);
      copied.push(rel);
    } catch {
      // best-effort, like the `.env*` copy: a file that cannot be copied is reported by its absence
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
  result.dohConfig = copyDohConfig(project, worktree);
  if (options.bootstrap === false) {
    result.dependencies = { manager: null, error: null, skipped: true };
    return result;
  }
  const deps = provideDependencies(project, worktree, { mode: options.deps || 'auto' });
  result.dependencies = deps;
  result.installed = Boolean(deps.manager) && !deps.error;
  if (deps.mainBroken) {
    result.mainBroken = true;
    result.warnings.push(`No dependencies for the gate: ${deps.error}.`);
  } else if (deps.error) {
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
  // verification gate stopped from being committed. Asked first, so a refused
  // worktree keeps its linked node_modules for whoever inspects it.
  const refused = `git worktree remove refused ${worktree} - it still holds modified or untracked files. Inspect it, then remove it yourself once nothing there is worth keeping.`;
  const status = tryGit(worktree, ['status', '--porcelain']);
  if (status === null || status.trim()) {
    result.errors.push(refused);
    return result;
  }
  const kept = keepReports(project, worktree, options.branch || path.basename(worktree));
  result.keptReportsDir = kept.dir;
  result.keptReports = kept.reports;
  const mainModules = path.join(project, 'node_modules');
  const before = entriesOf(mainModules);
  result.unlinked = unlinkLinks(worktree).map((p) => path.relative(worktree, p));
  // Still a link after the unlink → git would walk into the main checkout's folder. Stop.
  const leftLink = ['node_modules'].map((n) => path.join(worktree, n)).find((p) => {
    try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
  });
  if (leftLink) {
    result.errors.push(`${leftLink} is still a link after unlinking; nothing was removed, so the folder it points at is safe. Remove the link by hand (rmdir, never a recursive delete), then run remove again.`);
    return result;
  }
  let gitError = '';
  try {
    git(project, ['worktree', 'remove', worktree]);
  } catch (err) {
    gitError = String((err && err.stderr) || (err && err.message) || '').trim().split(/\r?\n/).filter(Boolean).pop() || 'git worktree remove failed';
  }
  if (gitError) {
    // git deletes file by file and stops at the first it cannot (a file another process holds
    // open, Windows). The tree is then half gone and the status above was clean: say what git
    // said and what is left, not "it holds modified files" (2026-11-05: two such refusals left
    // folders emptied while the message claimed uncommitted work).
    const left = entriesOf(worktree);
    if (left === null || left === 0) {
      tryGit(project, ['worktree', 'prune']);
      try { fs.rmdirSync(worktree); } catch { /* gone already */ }
      result.warnings.push(`git worktree remove reported "${gitError}", but the worktree folder is ${left === null ? 'gone' : 'empty'}; pruned it.`);
    } else {
      result.errors.push(`git worktree remove stopped at "${gitError}" with ${left} entries left in ${worktree}; nothing uncommitted was there (status was clean). A process may hold a file open - close it (editor, test watcher, terminal in that folder), then run remove again.`);
      return result;
    }
  }
  const after = entriesOf(mainModules);
  if (before !== null && after !== null && after < before) {
    result.errors.push(`The main checkout's node_modules went from ${before} to ${after} entries while ${worktree} was removed. Run the install in ${project} before the next run.`);
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
  detectPackageManager, installDependencies, installFailure, copyEnvFiles, copyLocalFiles, isLocalConfig,
  linkDependencies, provideDependencies, copyDohConfig, keepReports, dependencyHealth,
  add, remove, git, tryGit,
};

if (require.main === module) main();
