'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('./server.cjs');
const { listRuns, resumeRun } = require('./resume-run.cjs');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inf-resume-'));
const DAY = 24 * 60 * 60 * 1000;

function task(id, extra = {}) {
  return { id, branch: `feature/${id}`, activeStep: 4, step1Submitted: true, summary: null,
    steps: [{ id: 4, name: 'Implementation', status: 'in_progress', currentOperation: '' }], ...extra };
}

function writeRun(root, stamp, tasks, { server = null, ageDays = 0 } = {}) {
  const dir = path.join(root, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'pipeline-state.json');
  fs.writeFileSync(file, JSON.stringify({ tasks, nextTaskId: tasks.length + 1 }));
  const at = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(file, at, at);
  if (server) fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(server));
  return dir;
}

test('listRuns: runy z niedokończonymi taskami, najnowszy pierwszy; skończone, bez wysłanego formularza i stare pominięte', () => {
  const project = tmpDir();
  const skillDir = tmpDir();
  const doh = path.join(project, '.claude', 'doh');
  writeRun(doh, '20261101-100000', [task('t1'), task('t2', { summary: { done: true } })]);
  writeRun(doh, '20261103-090000', [task('t1', { activeStep: 6, steps: [{ id: 6, status: 'in_progress', currentOperation: 'Walking' }] })],
    { server: { pid: 4242, port: 9999 } });
  writeRun(doh, '20261102-080000', [task('t1', { summary: { done: true } })]);
  writeRun(doh, '20261102-070000', [task('t1', { step1Submitted: false, branch: '' })]);
  writeRun(doh, '20261001-070000', [task('t1')], { ageDays: 30 });
  writeRun(path.join(skillDir, '.implementNewFeature'), '20261102-120000', [task('t3')]);
  fs.mkdirSync(path.join(doh, 'instructions'), { recursive: true });

  const runs = listRuns({ project, skillDir, alive: pid => pid === 4242 });
  assert.deepStrictEqual(runs.map(r => r.stamp), ['20261103-090000', '20261102-120000', '20261101-100000']);
  assert.deepStrictEqual(runs[0].server, { pid: 4242, port: 9999 });
  assert.equal(runs[0].dir, path.join(doh, '20261103-090000'));
  assert.equal(runs[0].project, path.resolve(project));
  assert.deepStrictEqual(runs[0].tasks, [{ id: 't1', branch: 'feature/t1',
    line: '- t1 on `feature/t1`: step 6 Code Review - in_progress, "Walking"' }]);
  assert.equal(runs[2].server, null);
  assert.deepStrictEqual(runs[2].tasks.map(t => t.id), ['t1'], 'a finished task is not resumed');
  assert.equal(listRuns({ project, skillDir, alive: () => false, maxAgeDays: 60 }).length, 4);
});

test('listRuns: server.json z martwym pid to brak serwera; projekt bez runów to pusta lista', () => {
  const project = tmpDir();
  writeRun(path.join(project, '.claude', 'doh'), '20261103-090000', [task('t1')], { server: { pid: 1, port: 9999 } });
  assert.equal(listRuns({ project, skillDir: tmpDir(), alive: () => false })[0].server, null);
  assert.deepStrictEqual(listRuns({ project: tmpDir(), skillDir: tmpDir() }), []);
});

// A real server over the run's own state, started the way the launcher would: orphaned.
async function serve(dir, launches, opts = {}) {
  const app = createApp(dir, { starterSession: null, orphaned: true, project: path.dirname(dir),
    launchOrchestrator: async ({ taskId }) => {
      launches.push(taskId);
      return { launched: taskId !== 't3', command: `claude "attach ${taskId}"`, cwd: 'D:/proj',
        ...(taskId === 't3' ? { error: 'no terminal' } : {}) };
    }, ...opts });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return app;
}

test('resumeRun: martwy serwer startuje od nowa (open + orphaned), ta sesja bierze pierwszy task, reszta dostaje terminale', async t => {
  const project = tmpDir();
  const dir = writeRun(path.join(project, '.claude', 'doh'), '20261103-090000', [
    task('t1', { orchestrator: { session: 'old1' } }),
    task('t2', { orchestrator: { session: 'old2' } }),
    task('t3', { orchestrator: { session: 'old3' } }),
    task('t4', { summary: { done: true } }),
    task('t5', { step1Submitted: false, orchestrator: null })]);
  const [run] = listRuns({ project, skillDir: tmpDir(), alive: () => false });
  const launches = [];
  let app;
  const restarts = [];
  const restart = async (r, flags) => {
    restarts.push([r.dir, flags]);
    app = await serve(dir, launches);
    return { ok: true, port: app.server.address().port };
  };
  t.after(() => app && app.server.close());

  const out = await resumeRun(run, { restart });
  assert.deepStrictEqual(restarts, [[dir, { open: true, orphaned: true }]]);
  assert.deepStrictEqual(launches, ['t2', 't3']);
  assert.deepStrictEqual(out, {
    stamp: '20261103-090000', sessionDir: dir, port: app.server.address().port, restarted: true, self: 't1',
    launched: [
      { taskId: 't2', launched: true, command: 'claude "attach t2"', cwd: 'D:/proj' },
      { taskId: 't3', launched: false, command: 'claude "attach t3"', cwd: 'D:/proj', error: 'no terminal' }],
    running: [] });
});

test('resumeRun: żywy serwer tego runu zostaje; task z żywym orkiestratorem nie dostaje drugiej sesji', async t => {
  const project = tmpDir();
  const dir = writeRun(path.join(project, '.claude', 'doh'), '20261103-090000', [task('t1'), task('t2')]);
  const launches = [];
  const app = await serve(dir, launches, { orphaned: false });
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const parked = fetch(`${base}/api/answer?taskId=t1&session=alive&wait=5`).catch(() => {});
  await new Promise(r => setTimeout(r, 100));
  const run = { stamp: '20261103-090000', dir, project, server: { pid: process.pid, port: app.server.address().port },
    tasks: [{ id: 't1' }, { id: 't2' }] };
  const out = await resumeRun(run, { restart: async () => assert.fail('a live server is not restarted') });
  assert.equal(out.restarted, false);
  assert.equal(out.self, 't2');
  assert.deepStrictEqual(out.running, [{ taskId: 't1', status: 'listening' }]);
  assert.deepStrictEqual(out.launched, []);
  assert.deepStrictEqual(launches, []);
  await fetch(`${base}/api/answer`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 't1', kind: 'answer', text: 'x' }) });
  await parked;
});

test('resumeRun: port zajęty przez inny run - restart zgłasza błąd, nic nie jest otwierane', async () => {
  const project = tmpDir();
  writeRun(path.join(project, '.claude', 'doh'), '20261103-090000', [task('t1')]);
  const [run] = listRuns({ project, skillDir: tmpDir(), alive: () => false });
  const out = await resumeRun(run, { restart: async () => ({ ok: false, error: 'port 9999 is already in use' }) });
  assert.deepStrictEqual(out, { stamp: '20261103-090000', sessionDir: run.dir, error: 'port 9999 is already in use' });
});
