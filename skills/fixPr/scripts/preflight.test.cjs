'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pf = require('./preflight.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

// A git stand-in: `answers` maps the first git argument that is not `-c`/its value to a result.
function fakeGit(answers) {
  const calls = [];
  const run = (project, args) => {
    calls.push(args);
    const verb = args[0] === '-c' ? args[2] : args[0];
    const key = verb === 'config' ? args[args.length - 1] : verb;
    return { ok: false, out: '', err: '', timedOut: false, ...(answers[key] || {}) };
  };
  run.calls = calls;
  return run;
}

test('parseArgs takes the four switches and refuses anything else', () => {
  assert.deepStrictEqual(pf.parseArgs(['--project=/p', '--push=no', '--resolve=yes']), { project: '/p', push: 'no', commit: 'yes', resolve: 'yes', gate: 'yes' });
  assert.throws(() => pf.parseArgs(['--push=maybe']), /yes or no/);
  assert.throws(() => pf.parseArgs(['--branch=a']), /Unknown argument/);
});

test('an origin Git Credential Manager cannot reach names git\'s first line and the store fix', () => {
  // 2026-11-18: GCM could not use its store from Claude's process. Every launch only warned
  // "Could not fetch", and the first push failed 25 minutes into the run.
  const run = fakeGit({
    remote: { ok: true, out: 'https://github.com/acme/repo.git' },
    'ls-remote': { err: "fatal: Unable to persist credentials with the 'wincredman' credential store.\nerror: failed to execute prompt script (exit code 1)\nfatal: could not read Username" },
  });
  const res = pf.checkOrigin('/p', run);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "fatal: Unable to persist credentials with the 'wincredman' credential store.");
  assert.match(res.fix, /git config --global credential\.credentialStore dpapi/);
  assert.match(res.fix, /normal terminal/);
  const lsRemote = run.calls.find((a) => a.includes('ls-remote'));
  assert.ok(lsRemote.includes('credential.interactive=false'), 'no credential window is ever opened');
});

test('an origin that never answers is a timeout with the reason, not a hang', () => {
  const run = fakeGit({ remote: { ok: true }, 'ls-remote': { timedOut: true } });
  const res = pf.checkOrigin('/p', run);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /no answer in 20 s/);
  assert.match(res.fix, /prompt may be waiting/);
});

test('other origin failures get the fix their first line points at', () => {
  assert.match(pf.originFix('fatal: unable to access \'https://github.com/a/b.git/\': Could not resolve host: github.com', '/p'), /network, VPN or proxy/);
  assert.match(pf.originFix('git@github.com: Permission denied (publickey).', '/p'), /ssh-add/);
  assert.match(pf.originFix('fatal: Authentication failed for \'https://github.com/a/b.git/\'', '/p'), /log in once from a normal terminal/);
});

test('checkOrigin reaches a real remote and refuses a repository without one', (t) => {
  const bare = tempDir(t, 'fpc-pf-bare-');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const dir = tempDir(t, 'fpc-pf-');
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  const none = pf.checkOrigin(dir);
  assert.strictEqual(none.ok, false);
  assert.match(none.error, /no `origin` remote/);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', bare]);
  const reached = pf.checkOrigin(dir);
  assert.strictEqual(reached.ok, true, reached.error);
  assert.strictEqual(typeof reached.ms, 'number');
});

test('a missing identity names the keys and the commands that set them', () => {
  // 2026-11-18: with no user.name/user.email, restack.cjs reported a rebase that could not commit
  // as a conflict with no conflicting file, and an agent spent four minutes finding out why.
  const res = pf.checkIdentity('/p', fakeGit({}), {});
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(res.missing, ['user.name', 'user.email']);
  assert.match(res.fix, /git config --global user\.name "<your name>"` and `git config --global user\.email/);
  assert.strictEqual(pf.checkIdentity('/p', fakeGit({ 'user.name': { ok: true, out: 'A' }, 'user.email': { ok: true, out: 'a@b' } }), {}).ok, true);
  assert.strictEqual(pf.checkIdentity('/p', fakeGit({}), { GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b' }).ok, true, 'git reads its own variables too');
});

test('checkToken reports the source used, a refused one it fell past, and a token nobody accepts', (t) => {
  const dir = tempDir(t, 'fpc-pf-');
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  assert.deepStrictEqual(pf.checkToken(dir), { ok: true, skipped: 'no github.com remote', source: null }, 'no GitHub, nothing to ask');
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/repo.git']);
  const paths = [];
  const fellBack = pf.checkToken(dir, {
    request: (project, o) => { paths.push(o.path); return { ok: true, status: 200, json: { permissions: { push: true } }, tokenNote: 'GH_TOKEN was rejected; used git credential' }; },
    findToken: () => ({ token: 't', source: 'git credential', rejected: ['GH_TOKEN'], tried: [] }),
  });
  assert.deepStrictEqual(paths, ['/repos/acme/repo']);
  assert.deepStrictEqual(fellBack, { ok: true, source: 'git credential', rejected: ['GH_TOKEN'], note: 'GH_TOKEN was rejected; used git credential', canPush: true });
  const refused = pf.checkToken(dir, {
    request: () => ({ ok: false, status: 401, rejectedSources: ['GH_TOKEN', 'git credential'], error: 'GH_TOKEN was rejected; git credential was rejected too - Bad credentials' }),
    findToken: () => ({ token: 't', source: 'GH_TOKEN', tried: [] }),
  });
  assert.strictEqual(refused.ok, false);
  assert.deepStrictEqual(refused.rejected, ['GH_TOKEN', 'git credential']);
  assert.match(refused.fix, /GH_TOKEN/);
  const none = pf.checkToken(dir, { request: () => ({ ok: true, status: 200, json: {} }), findToken: () => ({ token: null, source: null, tried: ['GH_TOKEN', '.netrc'] }) });
  assert.strictEqual(none.ok, false);
  assert.match(none.error, /no GitHub token found \(looked in GH_TOKEN, \.netrc\)/);
});

test('checkDeps wants the main checkout\'s node_modules present and complete', (t) => {
  const dir = tempDir(t, 'fpc-pf-');
  assert.deepStrictEqual(pf.checkDeps(dir), { ok: true, skipped: 'no package.json' });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '1' }, devDependencies: { b: '1' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  const absent = pf.checkDeps(dir);
  assert.strictEqual(absent.ok, false);
  assert.match(absent.error, /no node_modules/);
  assert.match(absent.fix, /`npm ci`/);
  fs.mkdirSync(path.join(dir, 'node_modules', 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'a', 'package.json'), '{}');
  const partial = pf.checkDeps(dir);
  assert.strictEqual(partial.ok, false);
  assert.match(partial.error, /misses 1 of 2 declared packages \(b\)/);
  fs.mkdirSync(path.join(dir, 'node_modules', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'b', 'package.json'), '{}');
  assert.deepStrictEqual(pf.checkDeps(dir), { ok: true, declared: 2 });
});

test('preflight stops only on what the run will need', () => {
  const bad = { ok: false, error: 'E', fix: 'F' };
  const deps = { origin: () => bad, identity: () => bad, token: () => bad, deps: () => bad };
  const pushing = pf.preflight('/p', { push: true, commit: true, resolve: true, gate: true }, deps);
  assert.strictEqual(pushing.ok, false);
  assert.deepStrictEqual(pushing.errors, ['preflight origin: E - F', 'preflight identity: E - F', 'preflight token: E - F', 'preflight deps: E - F']);
  // A dry run commits nothing, pushes nothing, resolves nothing and runs no gate: all warnings.
  const dry = pf.preflight('/p', { push: false, commit: false, resolve: false, gate: false }, deps);
  assert.strictEqual(dry.ok, true);
  assert.deepStrictEqual(dry.errors, []);
  assert.strictEqual(dry.warnings.length, 3);
  assert.strictEqual(dry.checks.deps, undefined, 'no gate, no reason to look at node_modules');
  const fell = pf.preflight('/p', { push: true, resolve: true, gate: false }, {
    origin: () => ({ ok: true }), identity: () => ({ ok: true }),
    token: () => ({ ok: true, source: 'git credential', rejected: ['GH_TOKEN'], note: 'GH_TOKEN was rejected; used git credential' }),
  });
  assert.strictEqual(fell.ok, true);
  assert.deepStrictEqual(fell.warnings, ['preflight token: GH_TOKEN was rejected; used git credential - unset or refresh GH_TOKEN; this run uses git credential.']);
});
