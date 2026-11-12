'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseArgs, recipeOf, pickPort, baselineOnly, regression } = require('./regression.cjs');

// <run>/tasks/t1, as the pipeline lays a task out; the run folder holds unit-baseline.json.
function taskDir(t) {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-'));
  t.after(() => fs.rmSync(run, { recursive: true, force: true }));
  const dir = path.join(run, 'tasks', 't1');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const put = (dir, rel, value) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};

const PLAN = { devServer: { command: 'npx ng serve app --port {port}', port: 4317, url: 'http://localhost:{port}/#' },
  backends: ['http://localhost:3000/'], specs: [{ file: 'nodes.spec.cjs' }] };

function suite(t, { plan = PLAN, mocks = false } = {}) {
  const dir = taskDir(t);
  put(dir, 'e2e/nodes.spec.cjs', '// spec\n');
  if (plan) put(dir, 'validation/plan.json', plan);
  if (mocks) put(dir, 'mocks/mocks.patch', 'diff --git a/x b/x\n');
  return dir;
}

// Every seam of the script: the gate, git, the process record, the preflight, the port.
function seams({ steps = {}, mocksInTree = [], dirty = [''], applyFails = false, backendDown = false, server = ['READY 4400'] } = {}) {
  const calls = { checks: [], git: [], start: [], cleanup: 0 };
  const grep = [...mocksInTree];
  const diffs = [...dirty];
  return {
    calls,
    checks: (options) => {
      calls.checks.push(options);
      const name = options.only[0];
      const step = steps[name] || { status: 'passed' };
      return { errors: step.errors || [], steps: [{ step: name, ...step }] };
    },
    git: (args) => {
      calls.git.push(args.join(' '));
      if (args[0] === 'grep') return { status: 0, stdout: (grep.length > 1 ? grep.shift() : grep[0] || ''), out: '' };
      if (args[0] === 'diff') return { status: 0, stdout: (diffs.length > 1 ? diffs.shift() : diffs[0]), out: '' };
      if (args[0] === 'apply' && !args.includes('-R') && applyFails) return { status: 1, stdout: '', out: 'error: patch failed: src/app.config.ts:12\n' };
      if (args[0] === 'merge-base') return { status: 0, stdout: 'abc123\n', out: '' };
      return { status: 0, stdout: '', out: '' };
    },
    processes: {
      start: async (o) => { calls.start.push(o); return [`STARTED ${o.port} 77 log`]; },
      wait: async () => server,
      cleanup: () => { calls.cleanup++; return ['STOPPED 4400 77']; },
    },
    preflight: async () => (backendDown ? ['unreachable http://localhost:3000/ (ECONNREFUSED) - start the backend or Mockoon, or reconnect the VPN'] : []),
    pickPort: async () => 4400,
  };
}

const args = (dir, extra = {}) => ({ root: dir, taskDir: dir, project: dir, base: 'master', only: ['unit', 'e2e', 'precommit'], specs: [], grep: '', readyMinutes: 1, ...extra });

test('a green regression runs the unit suite, the E2E suite on its own dev server and the pre-commit gate, in that order', async (t) => {
  const dir = suite(t);
  put(dir, 'auth.json', { login: 'qa', password: 'x' });
  const s = seams();
  const out = await regression(args(dir), s);
  assert.deepStrictEqual(out.lines, ['UNIT_PASSED', 'E2E_PASSED', 'PRECOMMIT_PASSED', 'REGRESSION_GREEN']);
  assert.deepStrictEqual(s.calls.checks.map((c) => c.only[0]), ['test', 'e2e', 'precommit']);
  assert.strictEqual(s.calls.checks[0].changedSince, 'master', 'the gate config scopes the unit run to what the task changed');
  assert.strictEqual(s.calls.start[0].line, 'npx ng serve app --port 4400', 'the port this run got, not the one the plan was written on');
  const e2e = s.calls.checks[1];
  assert.match(e2e.command, /cli\.js" test --config ".*playwright\.config\.cjs" --grep-invert @visual$/);
  assert.strictEqual(e2e.env.E2E_BASE_URL, 'http://localhost:4400/#');
  assert.strictEqual(e2e.env.E2E_TEST_DIR, path.join(dir, 'e2e'));
  assert.strictEqual(e2e.env.E2E_REPORT_FILE, undefined, 'a full run writes the suite\'s own report');
  assert.strictEqual(e2e.authFile, path.join(dir, 'auth.json'));
  assert.strictEqual(s.calls.cleanup, 1, 'the dev server is stopped');
  assert.ok(s.calls.git.includes('add -A'), 'the gate sees the staged work');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'results', 'regression.json'), 'utf8')).verdict, 'REGRESSION_GREEN');
});

test('the mocks come back for the run and are gone after it, red or green', async (t) => {
  const dir = suite(t, { mocks: true });
  const red = seams({ steps: { e2e: { status: 'failed', errorsPath: path.join(dir, 'checks', 'e2e.errors.log') } }, mocksInTree: ['', ''] });
  const out = await regression(args(dir), red);
  assert.deepStrictEqual(out.lines, ['UNIT_PASSED', `E2E_FAILED ${path.join(dir, 'checks', 'e2e.errors.log').replace(/\\/g, '/')}`, 'MOCKS_REVERTED', 'PRECOMMIT_PASSED', 'REGRESSION_RED']);
  const applies = red.calls.git.filter((c) => c.startsWith('apply'));
  assert.strictEqual(applies.length, 2);
  assert.ok(!applies[0].includes('-R') && applies[1].includes('-R'), 'applied, then reverted');
  assert.strictEqual(red.calls.cleanup, 1);

  // A mock that survived the revert is the one outcome the mechanism exists to prevent.
  const left = seams({ mocksInTree: ['', 'src/app/doh-mock-endpoints.ts\n'] });
  const stuck = await regression(args(suite(t, { mocks: true })), left);
  assert.deepStrictEqual(stuck.lines.slice(1, 3), ['E2E_PASSED', 'MOCKS_LEFT src/app/doh-mock-endpoints.ts']);
  assert.strictEqual(stuck.verdict, 'REGRESSION_RED');
  // So is a wiring file the round trip left changed.
  const changed = seams({ mocksInTree: [''], dirty: ['', 'src/app.config.ts\n'] });
  assert.match((await regression(args(suite(t, { mocks: true })), changed)).lines[2], /^MOCKS_LEFT src\/app\.config\.ts$/);
});

test('what the machine lacks is BLOCKED, never a red suite: the backend, a patch that no longer applies, a server that never came up', async (t) => {
  const down = await regression(args(suite(t)), seams({ backendDown: true }));
  assert.deepStrictEqual(down.lines, ['UNIT_PASSED', 'E2E_BLOCKED unreachable http://localhost:3000/ (ECONNREFUSED) - start the backend or Mockoon, or reconnect the VPN', 'REGRESSION_BLOCKED']);
  const stale = seams({ applyFails: true });
  const patch = await regression(args(suite(t, { mocks: true })), stale);
  assert.deepStrictEqual(patch.lines.slice(1), ['E2E_BLOCKED mocks.patch does not apply any more: error: patch failed: src/app.config.ts:12', 'REGRESSION_BLOCKED']);
  assert.strictEqual(stale.calls.start.length, 0, 'nothing is started on a tree without its mocks');
  const dead = seams({ server: ['EXITED 4400', 'Error: Cannot find module x'] });
  const exited = await regression(args(suite(t)), dead);
  assert.match(exited.lines[1], /^E2E_BLOCKED the dev server exited: Error: Cannot find module x \(log: logs\/dev-server-4400\.log\)$/);
  assert.strictEqual(dead.calls.cleanup, 1);
  // A red unit suite with a blocked E2E is still red: there is something to fix.
  const both = await regression(args(suite(t)), seams({ backendDown: true, steps: { test: { status: 'failed', errorsPath: '/x/test.errors.log' } } }));
  assert.strictEqual(both.verdict, 'REGRESSION_RED');
});

test('a part nobody could run is said, not passed over', async (t) => {
  const none = taskDir(t);
  const out = await regression(args(none), seams({ steps: { test: { status: 'skipped', reason: 'the project has no test:unit (or test) script' },
    precommit: { status: 'skipped', reason: 'the project has no lint-staged config and no pre-commit hook' } } }));
  assert.deepStrictEqual(out.lines, ['UNIT_SKIPPED the project has no test:unit (or test) script',
    'E2E_SKIPPED the task has no E2E suite (validation left none)',
    'PRECOMMIT_SKIPPED the project has no lint-staged config and no pre-commit hook', 'REGRESSION_GREEN']);
  assert.deepStrictEqual(out.skipped, ['unit', 'e2e', 'precommit']);
  // A suite without a recipe to start the app with.
  const bare = await regression(args(suite(t, { plan: null }), { only: ['e2e'] }), seams());
  assert.match(bare.lines[0], /^E2E_SKIPPED nobody recorded how the app is started/);
});

test('a fix agent re-runs only what it touched, into a report of its own', async (t) => {
  const dir = suite(t);
  const s = seams();
  const out = await regression(args(dir, { only: ['e2e'], specs: ['nodes.spec.cjs'], grep: 'R74 contrast' }), s);
  assert.deepStrictEqual(out.lines, ['E2E_PASSED', 'REGRESSION_GREEN']);
  assert.match(s.calls.checks[0].command, /--grep-invert @visual --grep "R74 contrast" nodes\.spec\.cjs$/);
  assert.strictEqual(s.calls.checks[0].env.E2E_REPORT_FILE, path.join(dir, 'e2e-report-partial.json'));
  assert.ok(fs.existsSync(path.join(dir, 'results', 'regression-partial.json')) && !fs.existsSync(path.join(dir, 'results', 'regression.json')));
  const missing = await regression(args(dir, { only: ['e2e'], specs: ['gone.spec.cjs'] }), seams());
  assert.match(missing.lines[0], /^E2E_SKIPPED no such spec in .*: gone\.spec\.cjs$/);
});

test('unit failures the base already had are not this task\'s', async (t) => {
  const dir = suite(t);
  const errors = put(dir, 'checks/test.errors.log', 'FAIL projects/dpx/src/app/shared/date.pipe.spec.ts\n  expected 12:00 got 13:00\n');
  put(dir, '../../unit-baseline.json', { abc123: [{ spec: 'projects/dpx/src/app/shared/date.pipe.spec.ts', reason: 'time zone' }] });
  const s = seams({ steps: { test: { status: 'failed', errorsPath: errors } } });
  const out = await regression(args(dir, { only: ['unit'] }), s);
  assert.deepStrictEqual(out.lines, ['UNIT_PASSED 1 failing spec(s) are known failures of the base (unit-baseline.json)', 'REGRESSION_GREEN']);
  // One failure outside the list keeps the run red.
  fs.appendFileSync(errors, 'FAIL projects/dpx/src/app/pages/nodes/nodes.component.spec.ts\n');
  assert.strictEqual(baselineOnly({ errorsPath: errors, taskDir: dir, root: dir, base: 'master', git: s.git }), null);
  assert.strictEqual((await regression(args(dir, { only: ['unit'] }), s)).verdict, 'REGRESSION_RED');
});

test('the recipe is the plan of step 5, else the project\'s own "visual" section; a plan may name a unit command', (t) => {
  const dir = suite(t, { plan: { ...PLAN, unit: { full: 'python -m pytest -q' } } });
  assert.deepStrictEqual([recipeOf({ taskDir: dir, root: dir, project: dir }).source, recipeOf({ taskDir: dir, root: dir, project: dir }).unitFull],
    ['validation/plan.json', 'python -m pytest -q']);
  const project = taskDir(t);
  put(project, '.claude/doh/checks.json', { steps: {}, visual: { command: 'npx ng serve dpx --port {port}', url: 'http://localhost:{port}/#', backend: ['http://localhost:3000/'] } });
  const bare = taskDir(t);
  const recipe = recipeOf({ taskDir: bare, root: bare, project });
  assert.deepStrictEqual([recipe.command, recipe.backends, recipe.source], ['npx ng serve dpx --port {port}', ['http://localhost:3000/'], '.claude/doh/checks.json "visual"']);
  assert.strictEqual(recipeOf({ taskDir: bare, root: bare, project: bare }), null);
});

test('the port is the recorded one when free, else the next above it, never the stepper\'s', async () => {
  assert.strictEqual(await pickPort(4317, async () => true), 4317);
  assert.strictEqual(await pickPort(4317, async (p) => p >= 4320), 4320);
  assert.strictEqual(await pickPort(9999, async () => true), 10000);
  assert.strictEqual(await pickPort(0, async () => true), 4300);
  assert.strictEqual(await pickPort(4317, async () => false), 0);
});

test('against a real repository: the mock patch is applied and reverted by content', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regression-repo-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'app.config.ts'), 'export const config = [];\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const dir = suite(t, { mocks: false });
  // The patch as step 5 leaves it: the mock module and its wiring line.
  fs.writeFileSync(path.join(root, 'app.config.ts'), 'export const config = [];\nimport \'./doh-mock-endpoints\'; // DOH-MOCK\n');
  fs.writeFileSync(path.join(root, 'doh-mock-endpoints.ts'), '// DOH-MOCK\nexport {};\n');
  git('add', '-N', 'doh-mock-endpoints.ts');
  put(dir, 'mocks/mocks.patch', git('diff'));
  git('reset', '-q', '--hard');
  fs.rmSync(path.join(root, 'doh-mock-endpoints.ts'), { force: true });
  const s = seams();
  let during = null;
  const out = await regression({ ...args(dir, { only: ['e2e'] }), root }, { ...s, git: undefined,
    checks: (o) => { during = fs.existsSync(path.join(root, 'doh-mock-endpoints.ts')); return s.checks(o); } });
  assert.strictEqual(during, true, 'the suite ran with the mocks in the tree');
  assert.deepStrictEqual(out.lines, ['E2E_PASSED', 'MOCKS_REVERTED', 'REGRESSION_GREEN']);
  assert.ok(!fs.existsSync(path.join(root, 'doh-mock-endpoints.ts')));
  assert.strictEqual(git('status', '--porcelain').trim(), '');
});

test('parseArgs names its parts and refuses a path where a spec name belongs', () => {
  assert.deepStrictEqual(parseArgs(['--root=/w', '--task-dir=/s/tasks/t1']).only, ['unit', 'e2e', 'precommit']);
  assert.strictEqual(parseArgs(['--root=/w', '--task-dir=/s']).project, '/w');
  assert.throws(() => parseArgs(['--root=/w', '--task-dir=/s', '--only=unit,lint']), /--only takes unit, e2e, precommit \(not lint\)/);
  assert.throws(() => parseArgs(['--root=/w', '--task-dir=/s', '--spec=../x.spec.cjs']), /bare spec file names/);
  assert.throws(() => parseArgs(['--task-dir=/s']), /--root is required/);
});
