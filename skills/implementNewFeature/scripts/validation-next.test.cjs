'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, planProblems, nextPhase } = require('./validation-next.cjs');

function taskDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-next-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const write = (dir, rel, value) => {
  const file = path.join(dir, 'validation', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};

const PLAN = {
  devServer: { command: 'npx ng serve dpx -c local --port 4317', port: 4317 },
  specs: [
    { file: 'nodes-list.spec.cjs', kind: 'e2e', lines: ['R1', 'R2'] },
    { file: 'node-settings.parallel.spec.cjs', lines: ['R70'] },
    { file: 'visual.spec.cjs', kind: 'visual', lines: ['R120'] },
  ],
};
const author = (dir, file, type = 'result') => write(dir, path.join('authors', `${file}.json`), { type, spec: file, tests: 3, passed: 3 });

test('a step with nothing on disk starts at prepare', (t) => {
  assert.deepStrictEqual(nextPhase({ taskDir: taskDir(t) }), { next: 'prepare' });
});

test('the plan hands every spec file to an author of its own, then the suite to verify', (t) => {
  const dir = taskDir(t);
  write(dir, 'plan.json', PLAN);
  write(dir, 'context.md', '# context\n');
  assert.deepStrictEqual(nextPhase({ taskDir: dir }),
    { next: 'author', specs: ['nodes-list.spec.cjs', 'node-settings.parallel.spec.cjs', 'visual.spec.cjs'], done: [] });
  author(dir, 'nodes-list.spec.cjs');
  assert.deepStrictEqual(nextPhase({ taskDir: dir }),
    { next: 'author', specs: ['node-settings.parallel.spec.cjs', 'visual.spec.cjs'], done: ['nodes-list.spec.cjs'] });
  // An author that gave up, and one that wrote another spec's result, have not delivered theirs.
  author(dir, 'node-settings.parallel.spec.cjs', 'error');
  write(dir, path.join('authors', 'visual.spec.cjs.json'), { type: 'result', spec: 'other.spec.cjs' });
  assert.deepStrictEqual(nextPhase({ taskDir: dir }).specs, ['node-settings.parallel.spec.cjs', 'visual.spec.cjs']);
  author(dir, 'node-settings.parallel.spec.cjs');
  author(dir, 'visual.spec.cjs');
  assert.deepStrictEqual(nextPhase({ taskDir: dir }),
    { next: 'verify', specs: ['nodes-list.spec.cjs', 'node-settings.parallel.spec.cjs', 'visual.spec.cjs'] });
  // A retry goes on at verify: nothing is prepared or written twice.
  assert.strictEqual(nextPhase({ taskDir: dir }).next, 'verify');
  // Unless the step is to start over.
  assert.deepStrictEqual(nextPhase({ taskDir: dir, restart: true }), { next: 'prepare' });
  assert.ok(!fs.existsSync(path.join(dir, 'validation', 'authors')));
  assert.ok(fs.existsSync(path.join(dir, 'validation', 'context.md')), 'what prepare found out is still worth reading');
});

test('a plan nobody can work from sends the step back to prepare, with the reason', (t) => {
  const dir = taskDir(t);
  write(dir, 'plan.json', '{ not json');
  assert.deepStrictEqual(nextPhase({ taskDir: dir }), { next: 'prepare', errors: ['validation/plan.json is not a JSON object'] });
  write(dir, 'plan.json', PLAN);
  assert.deepStrictEqual(nextPhase({ taskDir: dir }), { next: 'prepare', errors: ['validation/context.md is missing'] });
  assert.deepStrictEqual(planProblems({ specs: [] }),
    ['"specs" must list at least one spec file', '"devServer" needs the "command" the app is started with and its "port"']);
  assert.deepStrictEqual(planProblems({ devServer: PLAN.devServer,
    specs: [{ file: '../x.spec.cjs' }, { file: 'a.spec.cjs' }, { file: 'a.spec.cjs' }, { file: 'b.spec.cjs', kind: 'unit' }] }),
  ['spec "../x.spec.cjs" is not a bare <name>.spec.cjs file name', 'spec a.spec.cjs is listed twice', 'spec b.spec.cjs: "kind" is e2e or visual']);
  assert.deepStrictEqual(planProblems(PLAN), []);
});

test('parseArgs needs the task folder', () => {
  assert.deepStrictEqual(parseArgs(['--task-dir=/s/tasks/t1', '--restart']), { taskDir: '/s/tasks/t1', restart: true });
  assert.throws(() => parseArgs([]), /--task-dir/);
  assert.throws(() => parseArgs(['--taskdir=/x']), /Unknown argument/);
});
