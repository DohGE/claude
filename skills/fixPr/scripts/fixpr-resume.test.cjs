'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const resume = require('./fixpr-resume.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(dir, file, text, message) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

// origin (bare), the user's checkout (the project) and, pushed to origin, a stack
// main <- part-1 <- part-2 and a branch of its own, `solo`, on main. `tips` is where each branch
// stood when the run began.
function world(t) {
  const base = fs.realpathSync(tempDir(t, 'fpc-resume-'));
  const origin = path.join(base, 'origin.git');
  const project = path.join(base, 'app');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, project], { stdio: 'ignore' });
  for (const [k, v] of [['user.email', 't@t.local'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(project, 'config', k, v);
  commit(project, 'base.txt', 'base\n', 'base');
  git(project, 'push', '-q', 'origin', 'main');
  const tips = {};
  for (const [branch, from] of [['part-1', 'main'], ['part-2', 'part-1'], ['solo', 'main']]) {
    git(project, 'switch', '-q', '-c', branch, from);
    tips[branch] = commit(project, `${branch}.txt`, `${branch}\n`, branch);
    git(project, 'push', '-q', 'origin', branch);
  }
  git(project, 'switch', '-q', 'main');
  fs.mkdirSync(path.join(project, '.claude', 'doh'), { recursive: true });
  return { base, project, tips };
}

const pr = { 'part-1': [101, 'main'], 'part-2': [102, 'part-1'], solo: [103, 'main'] };

// The run file as pr-comments.cjs writes it, each target's own fields over `over[branch]`.
function runFile(w, over = {}, name = 'fixpr-run-2026-11-19-10-00.json') {
  const doh = path.join(w.project, '.claude', 'doh');
  const target = (branch) => {
    const [number, baseBranch] = pr[branch];
    const dir = path.join(doh, branch);
    fs.mkdirSync(dir, { recursive: true });
    return {
      branch, pr: { number, title: `feat(X): ${branch}`, url: `https://example.test/pull/${number}`, base: baseBranch },
      commentsPath: path.join(dir, `${branch}.json`), reportPath: path.join(dir, `${branch}.md`), promptPath: path.join(dir, `${branch}-prompt.md`),
      checksDir: path.join(dir, 'checks'), worktree: path.join(w.base, `wt-${branch}`), remoteTipAtStart: w.tips[branch],
      landing: branch === 'part-1' ? 'keep-base' : branch === 'part-2' ? 'hold' : 'rebase',
      stack: branch === 'part-2' ? { parent: 'part-1', children: [], parentTipAtStart: w.tips['part-1'] } : { parent: null, children: branch === 'part-1' ? ['part-2'] : [] },
      ...(over[branch] || {}),
    };
  };
  const file = path.join(doh, name);
  fs.writeFileSync(file, JSON.stringify({ project: w.project, stacks: [['part-1', 'part-2']], targets: ['part-1', 'part-2', 'solo'].map(target) }));
  return file;
}

function result(file, branch, value) {
  const t = JSON.parse(fs.readFileSync(file, 'utf8')).targets.find((x) => x.branch === branch);
  fs.writeFileSync(`${t.reportPath}.result.json`, JSON.stringify(value));
}

function worktree(w, branch) {
  const dir = path.join(w.base, `wt-${branch}`);
  git(w.project, 'worktree', 'add', '-q', dir, branch);
  return dir;
}

const pushedResult = (commitSha, extra = {}) => ({ type: 'result', committed: true, pushed: true, commit: commitSha, fixedThreadIds: ['T1'], verdicts: [], ...extra });
const actionOf = (out, branch) => out.actions.find((a) => a.branch === branch);
const plan = (file, options = {}, deps = {}) => resume.plan(file, { worktrees: 'no', ...options }, deps);

// 2026-11-18: the orchestrator died (exit 137) with agents still at work; nothing said which.
test('a target whose agent never ended is launched again on its worktree, which is named with what it holds', (t) => {
  const w = world(t);
  const wt = worktree(w, 'part-1');
  commit(wt, 'fix.txt', 'half\n', 'CR');
  fs.writeFileSync(path.join(wt, 'part-1.txt'), 'more\n');
  const file = runFile(w, { 'part-1': { launch: { push: 'no', language: 'Polish', errors: [] } } });
  const out = plan(file);
  const a = actionOf(out, 'part-1');
  assert.strictEqual(a.action, 'spawn');
  for (const piece of ['fixpr-launch.cjs', `--run="${file}"`, '--branch="part-1"', '--push="no"', '--language="Polish"', '--resume="yes"']) assert.ok(a.command.includes(piece), piece);
  assert.match(a.note, /1 commit\(s\)/);
  assert.match(a.note, /uncommitted/);
  assert.strictEqual(actionOf(out, 'part-2').action, 'spawn', 'a held part is fixed beside its parent, not after it');
  assert.strictEqual(actionOf(out, 'solo').note, undefined);
  assert.deepStrictEqual(out.counts, { spawn: 3 });
});

test('an agent that ended in error goes on with its uncommitted work, or is recorded when there is none', (t) => {
  const w = world(t);
  const wt = worktree(w, 'solo');
  fs.writeFileSync(path.join(wt, 'solo.txt'), 'half a fix\n');
  const file = runFile(w);
  result(file, 'solo', { type: 'error', report: 'build still red' });
  result(file, 'part-1', { type: 'error', report: 'lint still red' });
  result(file, 'part-2', pushedResult(w.tips['part-2'], { pushed: false, held: true, committed: false }));
  const out = plan(file);
  assert.strictEqual(actionOf(out, 'solo').action, 'spawn');
  assert.match(actionOf(out, 'solo').note, /build still red/);
  const recorded = actionOf(out, 'part-1');
  assert.strictEqual(recorded.action, 'after');
  assert.ok(recorded.command.includes('--keep-worktree="yes"'));
  // part-1 ended in error and has no outcome yet: part-2 waits for it to be recorded.
  assert.strictEqual(actionOf(out, 'part-2').action, 'wait');
});

test('a held part waits for its parent, then lands on it - its worktree made again when it is gone', (t) => {
  const w = world(t);
  const file = runFile(w);
  result(file, 'part-1', pushedResult(w.tips['part-1']));
  result(file, 'part-2', pushedResult(w.tips['part-2'], { pushed: false, held: true }));
  let out = plan(file);
  assert.strictEqual(actionOf(out, 'part-1').action, 'after');
  assert.strictEqual(actionOf(out, 'part-2').action, 'wait');
  assert.match(actionOf(out, 'part-2').reason, /part-1 has not landed/);

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.targets[0].outcome = { commit: w.tips['part-1'], committed: true, pushed: true, resolve: { resolved: 1, failed: [], replyFailed: [] } };
  fs.writeFileSync(file, JSON.stringify(data));
  const made = [];
  out = resume.plan(file, {}, { addWorktree: (branch) => { made.push(branch); return { worktree: path.join(w.base, `wt-${branch}`), warnings: ['linked'], errors: [] }; } });
  const land = actionOf(out, 'part-2');
  assert.strictEqual(land.action, 'land');
  for (const piece of ['restack.cjs', '--action="land"', '--branch="part-2"', '--push="yes"', '--summary="yes"', '--pending-steps="build"']) assert.ok(land.command.includes(piece), piece);
  assert.deepStrictEqual(made, ['part-2']);
  assert.strictEqual(land.worktree, path.join(w.base, 'wt-part-2'));
  assert.strictEqual(actionOf(out, 'part-1').action, 'done');

  const refused = resume.plan(file, {}, { addWorktree: () => ({ errors: ['part-2 is checked out elsewhere'] }) });
  assert.strictEqual(actionOf(refused, 'part-2').action, 'manual');
  assert.match(actionOf(refused, 'part-2').reason, /checked out elsewhere/);
});

// 2026-11-18: a bottom's commit pushed by hand after the crash skipped the keep-base check and
// conflicted with its base on GitHub.
test('a keep-base bottom committed and never pushed lands through restack.cjs --keep-base', (t) => {
  const w = world(t);
  const wt = worktree(w, 'part-1');
  const cr = commit(wt, 'fix.txt', 'fix\n', 'CR');
  const file = runFile(w);
  result(file, 'part-1', pushedResult(cr, { pushed: false }));
  const a = actionOf(plan(file), 'part-1');
  assert.strictEqual(a.action, 'land');
  assert.ok(a.command.includes('--keep-base="yes"') && a.command.includes('--branch="part-1"'));
  assert.match(a.reason, /only if it no longer merges/);
});

test('a commit never pushed goes out through restack.cjs push: plainly on top of origin, with the lease once rewritten', (t) => {
  const w = world(t);
  const wt = worktree(w, 'solo');
  const cr = commit(wt, 'fix.txt', 'fix\n', 'CR');
  const file = runFile(w);
  result(file, 'solo', pushedResult(cr, { pushed: false }));
  let a = actionOf(plan(file), 'solo');
  assert.strictEqual(a.action, 'push');
  assert.ok(a.command.includes(`--commit="${cr}"`) && !a.command.includes('--lease'));

  // Rebased onto a newer main, then the run stopped; the worktree is gone too.
  commit(w.project, 'main.txt', 'newer\n', 'main moved');
  git(w.project, 'push', '-q', 'origin', 'main');
  git(wt, 'fetch', '-q', 'origin');
  git(wt, 'rebase', '-q', 'origin/main');
  const rebased = git(wt, 'rev-parse', 'HEAD');
  git(w.project, 'worktree', 'remove', wt);
  result(file, 'solo', pushedResult(rebased, { pushed: false, rebased: true }));
  a = actionOf(plan(file), 'solo');
  assert.strictEqual(a.action, 'push');
  assert.ok(a.command.includes(`--commit="${rebased}"`) && a.command.includes(`--lease="${w.tips.solo}"`));

  // The same command, run: the commit is on origin, and the next pass hands it to fixpr-after.
  const ran = spawnSync(process.execPath, [path.join(__dirname, 'restack.cjs'), '--action=push', `--run=${file}`, '--branch=solo', `--commit=${rebased}`, `--lease=${w.tips.solo}`], { encoding: 'utf8' });
  assert.strictEqual(JSON.parse(ran.stdout.trim().split(/\r?\n/).pop()).pushed, true);
  a = actionOf(plan(file), 'solo');
  assert.strictEqual(a.action, 'after');
  assert.ok(a.command.includes(`--commit="${rebased}"`) && a.command.includes('--pushed="yes"') && a.command.includes('--land-next="no"'));
});

test('a held part whose landing could not push is pushed with the lease; one that landed gets fixpr-after', (t) => {
  const w = world(t);
  // The landing moved part-2 (a commit origin/part-2 is no ancestor of), then its push failed.
  git(w.project, 'switch', '-q', '-c', 'moved', 'main');
  const moved = commit(w.project, 'part-2.txt', 'moved\n', 'part-2 moved');
  git(w.project, 'switch', '-q', 'main');
  const parentDone = { outcome: { commit: w.tips['part-1'], committed: true, pushed: true, resolve: { resolved: 0, failed: [] } } };
  let file = runFile(w, { 'part-1': parentDone, 'part-2': { landingResult: { status: 'push-rejected', commit: moved, errors: ['error: failed to execute prompt script'] } } });
  result(file, 'part-1', pushedResult(w.tips['part-1']));
  result(file, 'part-2', pushedResult(w.tips['part-2'], { pushed: false, held: true }));
  let a = actionOf(plan(file), 'part-2');
  assert.strictEqual(a.action, 'push');
  assert.ok(a.command.includes(`--commit="${moved}"`) && a.command.includes(`--lease="${w.tips['part-2']}"`));
  assert.match(a.reason, /prompt script/);

  file = runFile(w, { 'part-1': parentDone, 'part-2': { landingResult: { status: 'landed', commit: w.tips['part-2'], pushed: true } } });
  result(file, 'part-2', pushedResult(w.tips['part-2'], { pushed: false, held: true }));
  a = actionOf(plan(file), 'part-2');
  assert.strictEqual(a.action, 'after');
  assert.ok(a.command.includes(`--commit="${w.tips['part-2']}"`) && a.command.includes('--pushed="yes"'));
});

test('a landing stopped inside its conflict agent\'s rebase gets that agent again; one the agent pushed gets fixpr-after', (t) => {
  const w = world(t);
  worktree(w, 'part-2');
  const parentDone = { outcome: { commit: w.tips['part-1'], committed: true, pushed: true, resolve: {} } };
  const file = runFile(w, { 'part-1': parentDone, 'part-2': { landingResult: { status: 'conflict', briefVars: '/c/part-2/restack/restack-agent-vars.json', conflictFiles: ['a.ts'] } } });
  result(file, 'part-1', pushedResult(w.tips['part-1']));
  result(file, 'part-2', pushedResult(w.tips['part-2'], { pushed: false, held: true }));
  const facts = resume.gitFacts(w.project);
  let a = actionOf(plan(file, {}, { facts: { ...facts, inRebase: () => true } }), 'part-2');
  assert.strictEqual(a.action, 'landing-agent');
  assert.strictEqual(a.briefVars, '/c/part-2/restack/restack-agent-vars.json');
  for (const piece of ['render-agent-prompt.cjs', 'restack-agent.md', 'part-2-prompt-restack.md', '--set="PR_NUMBER=102"', '--set="LANGUAGE=English"']) assert.ok(a.command.includes(piece), piece);
  a = actionOf(plan(file), 'part-2');
  assert.strictEqual(a.action, 'land', 'not in a rebase: the landing runs again and hands the conflict to its agent');
  // The agent had pushed part-2 onto part-1 before the run stopped.
  a = actionOf(plan(file, {}, { facts: { ...facts, tip: (b) => (b === 'part-2' ? 'f'.repeat(40) : facts.tip(b)), sits: () => true } }), 'part-2');
  assert.strictEqual(a.action, 'after');
  assert.ok(a.command.includes(`--commit="${'f'.repeat(40)}"`));
});

// 2026-11-18: six landed parts kept 26 open threads after a 401 on every resolve and reply.
test('threads left open after a push, or a push made after fixpr-after, are closed through --resolve-only', (t) => {
  const w = world(t);
  const failed = { resolved: 0, failed: [{ id: 'T1', error: 'HTTP 401: Bad credentials' }], replyFailed: [{ id: 'T1', error: 'HTTP 401: Bad credentials' }], unverified: [] };
  let file = runFile(w, { solo: { outcome: { commit: w.tips.solo, committed: true, pushed: true, resolve: failed } } });
  result(file, 'solo', pushedResult(w.tips.solo));
  let a = actionOf(plan(file), 'solo');
  assert.strictEqual(a.action, 'resolve');
  assert.ok(a.command.includes('fixpr-after.cjs') && a.command.includes('--resolve-only="yes"'));
  assert.match(a.reason, /1 thread\(s\) not resolved, 1 reply/);

  // fixpr-after ran before the push; the commit is on origin now.
  file = runFile(w, { solo: { outcome: { commit: w.tips.solo, committed: true, pushed: false, reply: 'no', resolve: { skipped: 'not pushed' } } } });
  a = actionOf(plan(file), 'solo');
  assert.strictEqual(a.action, 'resolve');
  assert.ok(a.command.includes('--reply="no"'));

  // Every thread resolved, only the replies refused, and the run said --no-reply: nothing left.
  file = runFile(w, { solo: { outcome: { commit: w.tips.solo, committed: true, pushed: true, reply: 'no', resolve: { resolved: 1, failed: [], replyFailed: [{ id: 'T1' }] } } } });
  assert.strictEqual(actionOf(plan(file), 'solo').action, 'done');
});

test('a part pushed under open parts the run does not name gets the cascade; one with nothing left is done', (t) => {
  const w = world(t);
  git(w.project, 'switch', '-q', '-c', 'solo-above', w.tips.solo);
  commit(w.project, 'above.txt', 'above\n', 'above');
  git(w.project, 'push', '-q', 'origin', 'solo-above');
  git(w.project, 'switch', '-q', 'solo');
  const cr = commit(w.project, 'fix.txt', 'fix\n', 'CR');
  git(w.project, 'push', '-q', 'origin', 'solo');
  git(w.project, 'switch', '-q', 'main');
  const done = { commit: cr, committed: true, pushed: true, resolve: { resolved: 1, failed: [], replyFailed: [] } };
  const file = runFile(w, { solo: { stack: { parent: null, children: [], above: ['solo-above'] }, outcome: done } });
  result(file, 'solo', pushedResult(cr));
  const a = actionOf(plan(file), 'solo');
  assert.strictEqual(a.action, 'cascade');
  for (const piece of ['--action="cascade"', '--stack="solo;solo-above"', '--from="solo"', `--from-old-tip="${w.tips.solo}"`]) assert.ok(a.command.includes(piece), piece);
  const plain = runFile(w, { solo: { outcome: done } }, 'fixpr-run-2026-11-19-10-01.json');
  result(plain, 'solo', pushedResult(cr));
  assert.strictEqual(actionOf(plan(plain), 'solo').action, 'done');
  assert.strictEqual(resume.newestRun(w.project), plain, 'the newest run file of the project');
});

test('a commit gone from the repository is for the user; the CLI prints the plan of the newest run', (t) => {
  const w = world(t);
  const file = runFile(w);
  result(file, 'solo', pushedResult('d'.repeat(40), { pushed: false }));
  const a = actionOf(plan(file), 'solo');
  assert.strictEqual(a.action, 'manual');
  assert.match(a.reason, /no longer in the repository/);
  const res = spawnSync(process.execPath, [path.join(__dirname, 'fixpr-resume.cjs'), `--project=${w.project}`, '--worktrees=no'], { encoding: 'utf8' });
  const out = JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
  assert.strictEqual(out.runPath, file);
  assert.deepStrictEqual(out.actions.map((x) => x.action), ['spawn', 'spawn', 'manual']);
  assert.throws(() => resume.parseArgs(['--push=maybe']), /--push takes yes or no/);
  assert.throws(() => resume.parseArgs(['--rn=x']), /Unknown argument/);
});
