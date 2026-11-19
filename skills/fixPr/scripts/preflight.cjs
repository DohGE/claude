#!/usr/bin/env node
'use strict';

// Whether this process can do what a run is about to ask of it, answered in seconds and before
// any worktree or agent exists: reach `origin` without a prompt, commit under a known identity,
// call the GitHub API with a token GitHub accepts, and link a complete `node_modules`.
//
// Each of the four failed once in the middle of a run (2026-11-18), long after it could have been
// seen: Git Credential Manager could not use its store from Claude's process, so every launch
// warned "Could not fetch origin/<branch>" and the first push failed 25 minutes later as
// `push-rejected`; a missing user.name/user.email made a rebase stop as a "conflict" with no
// conflicting file; a stale GH_TOKEN failed 26 thread resolves; a worktree installed for ten
// minutes because the main checkout's node_modules was gone. One call here names the cause and
// its fix while nothing has been started yet.
//
// fixPr runs it inside pr-comments.cjs (the collector), /doh:restack inside `restack.cjs
// --action=plan` and `--action=stack`; anything else that commits or pushes - implementNewFeature's
// commit and pull request step - can call `preflight()` or this file directly.
//
// Usage: node preflight.cjs --project=<dir> [--push=yes|no] [--commit=yes|no] [--resolve=yes|no] [--gate=yes|no]
//   --push    a push follows: an unreachable origin stops the run (otherwise a warning)
//   --commit  a commit or a rebase follows: a missing identity stops the run (default yes)
//   --resolve review threads are resolved on GitHub: a token GitHub refuses stops the run
//   --gate    the project's gate runs in worktrees: an incomplete main node_modules stops the run
// Prints one JSON object: { ok, checks: { origin, identity, token, deps }, errors, warnings }.
// Exit code 1 when `errors` is not empty.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const github = require('../../codeReview/scripts/github.cjs');
const { dependencyHealth, detectPackageManager } = require('./worktree.cjs');

const originTimeoutMs = 20000;

function parseArgs(argv) {
  const args = { project: process.cwd(), push: 'yes', commit: 'yes', resolve: 'no', gate: 'yes' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) unknown.push(arg);
    else if (m[1] === 'project') args.project = m[2].trim();
    else if (m[1] === 'push') args.push = m[2].trim();
    else if (m[1] === 'commit') args.commit = m[2].trim();
    else if (m[1] === 'resolve') args.resolve = m[2].trim();
    else if (m[1] === 'gate') args.gate = m[2].trim();
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --project, --push, --commit, --resolve, --gate).`);
  for (const key of ['push', 'commit', 'resolve', 'gate']) {
    if (!['yes', 'no'].includes(args[key])) throw new Error(`--${key} takes yes or no.`);
  }
  return args;
}

// No prompt can ever be answered from here: a terminal prompt is refused at once instead of
// waiting on a stdin nobody writes to, and Git Credential Manager is told not to open a window.
function gitQuiet(project, args, { timeout = originTimeoutMs } = {}) {
  const res = spawnSync('git', ['-C', project, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  const timedOut = Boolean(res.error && /ETIMEDOUT/.test(String(res.error.code || res.error.message)));
  return { ok: res.status === 0, out: String(res.stdout || '').trim(), err: String(res.stderr || (res.error && res.error.message) || '').trim(), timedOut };
}

const firstLine = (text) => (String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '');

// The fix for what git said, as specific as its first line allows.
function originFix(line, project) {
  const fetch = `\`git -C "${project}" fetch origin\``;
  if (/wincredman|credential ?store|persist credentials/i.test(line)) {
    return `Git Credential Manager cannot use its credential store from this process: run \`git config --global credential.credentialStore dpapi\`, or log in once from a normal terminal (${fetch}), then start again.`;
  }
  if (/could not resolve host|unable to access|connection (timed out|refused)|network is unreachable|proxy/i.test(line) && !/40[13]/.test(line)) {
    return 'origin is not reachable from this machine (network, VPN or proxy): check the connection, then start again.';
  }
  if (/permission denied \(publickey|host key verification/i.test(line)) {
    return `the SSH key for origin is not available to this process: load it (\`ssh-add\`) or run ${fetch} once from a normal terminal, then start again.`;
  }
  return `git has no usable credential for origin in this process: log in once from a normal terminal (${fetch}); with Git Credential Manager on Windows also try \`git config --global credential.credentialStore dpapi\`. Then start again.`;
}

function checkOrigin(project, run = gitQuiet) {
  if (!run(project, ['remote', 'get-url', 'origin'], { timeout: 5000 }).ok) {
    return { ok: false, error: 'the repository has no `origin` remote', fix: 'add it (`git remote add origin <url>`), then start again.' };
  }
  const started = Date.now();
  // `HEAD` alone: authenticates exactly like a fetch, answers with one line on any repository.
  const res = run(project, ['-c', 'credential.interactive=false', 'ls-remote', 'origin', 'HEAD']);
  const ms = Date.now() - started;
  if (res.ok) return { ok: true, ms };
  if (res.timedOut) {
    return { ok: false, ms, error: `git ls-remote origin gave no answer in ${originTimeoutMs / 1000} s`, fix: `a credential prompt may be waiting where nobody sees it: run \`git -C "${project}" fetch origin\` once from a normal terminal, then start again.` };
  }
  const line = firstLine(res.err) || 'git ls-remote origin failed';
  return { ok: false, ms, error: line, fix: originFix(line, project) };
}

// Every commit, rebase and cherry-pick of a run needs both; git's own environment variables count
// too. Without them `git rebase` stops with "Committer identity unknown", which restack.cjs read
// as a conflict with no conflicting file (2026-11-18).
function checkIdentity(project, run = gitQuiet, env = process.env) {
  const value = (key, vars) => run(project, ['config', '--get', key], { timeout: 5000 }).out || vars.map((v) => env[v]).find(Boolean) || '';
  const name = value('user.name', ['GIT_COMMITTER_NAME', 'GIT_AUTHOR_NAME']);
  const email = value('user.email', ['GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_EMAIL', 'EMAIL']);
  const missing = [!name && 'user.name', !email && 'user.email'].filter(Boolean);
  if (!missing.length) return { ok: true };
  const commands = missing.map((key) => `\`git config --global ${key} "<${key === 'user.name' ? 'your name' : 'your e-mail'}>"\``).join(' and ');
  return { ok: false, missing, error: `git has no ${missing.join(' and ')}: no commit or rebase can be made`, fix: `run ${commands}, then start again.` };
}

// One cheap authenticated call: the repository itself. A token GitHub refuses answers 401 on any
// endpoint, a public one included, so this tells a good token from a stale one; github.cjs falls
// through to the next token source on that 401 and keeps the one that works for this process.
function checkToken(project, { request = github.request, findToken = github.tokenWithSource } = {}) {
  const slug = github.repoSlug(project);
  if (!slug) return { ok: true, skipped: 'no github.com remote', source: null };
  const res = request(project, { path: `/repos/${slug.owner}/${slug.repo}` });
  const found = findToken(project);
  const fix = 'set GH_TOKEN to a valid token (or unset a stale one), or refresh the stored github.com credential (`gh auth login`, or one `git fetch` from a normal terminal), then start again.';
  if (!found.token) {
    return { ok: false, source: null, tried: found.tried || [], error: `no GitHub token found (looked in ${(found.tried || []).join(', ')})`, fix };
  }
  const rejected = res.rejectedSources || found.rejected || [];
  if (!res.ok) return { ok: false, source: found.source, rejected, error: res.error || `HTTP ${res.status}`, fix };
  const permissions = (res.json && res.json.permissions) || null;
  return {
    ok: true,
    source: found.source,
    ...(rejected.length ? { rejected, note: res.tokenNote || found.note || null } : {}),
    ...(permissions ? { canPush: Boolean(permissions.push) } : {}),
  };
}

// The main checkout's node_modules, which every worktree links: one missing, or missing packages
// its package.json declares, means every worktree installs on its own or has no gate at all.
function checkDeps(project) {
  if (!fs.existsSync(path.join(project, 'package.json'))) return { ok: true, skipped: 'no package.json' };
  const manager = detectPackageManager(project) || 'npm';
  const command = `\`${manager} ${manager === 'npm' ? 'ci' : 'install'}\` in ${project}`;
  if (!fs.existsSync(path.join(project, 'node_modules'))) {
    return { ok: false, error: 'the main checkout has no node_modules, so every worktree would install its own', fix: `run ${command}, then start again.` };
  }
  const health = dependencyHealth(project);
  if (health.ok) return { ok: true, declared: health.declared };
  return {
    ok: false,
    missing: health.missing.length,
    error: `the main checkout's node_modules misses ${health.missing.length} of ${health.declared} declared packages (${health.missing.slice(0, 3).join(', ')}${health.missing.length > 3 ? ', …' : ''})`,
    fix: `run ${command} - never inside a worktree, whose node_modules is a link to it - then start again.`,
  };
}

// `options`: push, commit, resolve, gate - booleans; each turns its check's failure from a warning
// into an error. `deps`: the tests' seams for every check.
function preflight(project, options = {}, deps = {}) {
  const root = path.resolve(project || process.cwd());
  const want = { push: true, commit: true, resolve: false, gate: true, ...options };
  const result = { ok: true, checks: {}, errors: [], warnings: [] };
  const report = (name, check, fatal) => {
    result.checks[name] = check;
    if (check.ok) return;
    (fatal ? result.errors : result.warnings).push(`preflight ${name}: ${check.error} - ${check.fix}`);
  };
  report('origin', (deps.origin || checkOrigin)(root), want.push);
  report('identity', (deps.identity || checkIdentity)(root), want.commit);
  const token = (deps.token || checkToken)(root);
  report('token', token, want.resolve);
  if (token.ok && token.note) result.warnings.push(`preflight token: ${token.note} - unset or refresh ${token.rejected.join(', ')}; this run uses ${token.source}.`);
  if (want.gate) report('deps', (deps.deps || checkDeps)(root), true);
  result.ok = result.errors.length === 0;
  return result;
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    result = preflight(args.project, { push: args.push === 'yes', commit: args.commit === 'yes', resolve: args.resolve === 'yes', gate: args.gate === 'yes' });
  } catch (err) {
    result = { ok: false, checks: {}, errors: [String((err && err.message) || err)], warnings: [] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, preflight, checkOrigin, checkIdentity, checkToken, checkDeps, originFix, gitQuiet };

if (require.main === module) main();
