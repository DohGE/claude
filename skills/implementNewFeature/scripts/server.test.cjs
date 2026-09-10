'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('./server.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inf-'));
}

async function listen(app) {
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${app.server.address().port}`;
}

const post = (base, urlPath, body) => fetch(`${base}${urlPath}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

// Every state update addresses one task; t1 is the task a fresh run starts with.
const postState = (base, body) => post(base, '/api/state', { taskId: 't1', ...body });

const getState = async base => (await fetch(`${base}/api/state`)).json();
const task0 = async base => (await getState(base)).tasks[0];

test('GET /api/state returns one task with the 7-step pipeline and Mockups opt-in', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.nextTaskId, 2);
  const task = state.tasks[0];
  assert.equal(task.id, 't1');
  assert.deepEqual(task.steps.map(s => s.name),
    ['Requirements', 'Feature Refinement', 'Mockups', 'Implementation',
      'Validation & E2E', 'Code Review', 'Mockoon Mocks']);
  assert.ok(task.steps.every(s => s.status === 'waiting'));
  // Mockups is the only step the stepper hides until the step-1 toggle enables it.
  assert.deepEqual(task.steps.filter(s => s.enabled === false).map(s => s.id), [3]);
  assert.equal(task.activeStep, 1);
  assert.equal(task.mockupReview, null);
  assert.equal(task.step1, null);
  assert.equal(task.step1Submitted, false);
  assert.equal(task.branch, '');
  assert.equal(task.root, null);
  assert.equal(task.authSaved, false);
});

test('POST /api/state applies to the addressed task and rejects an unknown one', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/tasks', {});
  await postState(base, { step: 2, status: 'in_progress', activeStep: 2,
    root: 'D:/repo', branch: 'feature/x' });
  await post(base, '/api/state', { taskId: 't2', step: 4, status: 'failed' });
  const state = await getState(base);
  assert.equal(state.tasks[0].steps[1].status, 'in_progress');
  assert.equal(state.tasks[0].root, 'D:/repo');
  assert.equal(state.tasks[0].branch, 'feature/x');
  // The other task is untouched by its neighbour's update.
  assert.equal(state.tasks[1].steps[1].status, 'waiting');
  assert.equal(state.tasks[1].steps[3].status, 'failed');
  assert.equal((await post(base, '/api/state', { taskId: 'nope', step: 1 })).status, 400);
  assert.equal((await post(base, '/api/state', { step: 1 })).status, 400);
});

test('POST /api/state enables the Mockups step and round-trips mockupReview', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const review = {
    rev: 2, text: 'Dwa ekrany — logowanie i lista',
    screens: [{ id: 'login', title: 'Logowanie', file: 'login.html' }],
    chat: [{ role: 'agent', text: 'Pierwsza wersja' }, { role: 'user', text: 'Szerszy przycisk' }]
  };
  await postState(base, { step: 3, enabled: true, status: 'in_progress',
    activeStep: 3, mockupReview: review });
  const task = await task0(base);
  assert.equal(task.steps[2].enabled, true);
  assert.deepEqual(task.mockupReview, review);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-state.json'), 'utf8'));
  assert.equal(onDisk.tasks[0].steps[2].enabled, true);

  await postState(base, { mockupReview: null });
  assert.equal((await task0(base)).mockupReview, null);
});

test('the server owns the mockup rev and the chat, not the orchestrator', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const screens = [{ id: 'login', title: 'Logowanie', file: 'login.html' }];
  await postState(base, { step: 3, enabled: true });
  // Round 1: the orchestrator sends the round, never a counter and never the chat.
  await postState(base, { mockupReview: { text: 'Pierwsza wersja', screens },
    mockupChat: { role: 'agent', text: 'Pierwsza wersja' } });
  let r = (await task0(base)).mockupReview;
  assert.equal(r.rev, 1);
  assert.deepEqual(r.chat, [{ role: 'agent', text: 'Pierwsza wersja' }]);
  // The user's feedback appends without resending anything.
  await postState(base, { mockupChat: { role: 'user', text: 'Szerszy przycisk' } });
  r = (await task0(base)).mockupReview;
  assert.equal(r.rev, 1, 'feedback is not a new round');
  assert.equal(r.chat.length, 2);
  // Round 2 carries the chat forward and moves the counter the UI re-renders on.
  await postState(base, { mockupReview: { text: 'Druga wersja', screens },
    mockupChat: { role: 'agent', text: 'Druga wersja' } });
  r = (await task0(base)).mockupReview;
  assert.equal(r.rev, 2);
  assert.deepEqual(r.chat.map(m => m.role), ['agent', 'user', 'agent']);
  // Clearing the panel and starting over keeps the counter monotonic.
  await postState(base, { mockupReview: null });
  await postState(base, { mockupReview: { text: 'Trzecia', screens } });
  assert.equal((await task0(base)).mockupReview.rev, 3);
  assert.deepEqual((await task0(base)).mockupReview.chat, []);
});

function writeMockup(dir, taskId, name, body) {
  const d = path.join(dir, 'tasks', taskId, 'generated-mockups');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), body);
}

test('GET /generated-mockups/<taskId>/<file> serves the mockup uncached', async t => {
  const dir = tmpDir();
  writeMockup(dir, 't1', 'login.html', '<h1>Logowanie</h1>');
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/generated-mockups/t1/login.html?rev=3`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  // The agent rewrites the same filenames between chat rounds.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), '<h1>Logowanie</h1>');
});

test('GET /generated-mockups rejects traversal, unknown types, tasks and missing files', async t => {
  const dir = tmpDir();
  writeMockup(dir, 't1', 'login.html', 'ok');
  fs.writeFileSync(path.join(dir, 'tasks', 't1', 'auth.json'), '{"login":"u","password":"s3cret"}');
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const blocked = ['/generated-mockups/t1/..%2Fauth.json', '/generated-mockups/t1/..%5Cauth.json',
    '/generated-mockups/t1/auth.json', '/generated-mockups/t1/missing.html',
    '/generated-mockups/t1/notes.txt', '/generated-mockups/t1/.env',
    // No task segment, unknown task, and a nested path are all refused.
    '/generated-mockups/login.html', '/generated-mockups/t9/login.html',
    '/generated-mockups/t1/sub/login.html'];
  for (const p of blocked) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, `expected 404 for ${p}`);
    assert.ok(!(await res.text()).includes('s3cret'), `${p} leaked credentials`);
  }
  const malformed = await fetch(`${base}/generated-mockups/t1/%zz.html`);
  assert.equal(malformed.status, 400);
});

test('POST /api/state merges updates and persists to pipeline-state.json', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await postState(base, { step: 3, status: 'in_progress', progress: 40,
    currentOperation: 'Task 2/5', logEntry: 'started task 2', activeStep: 3 });
  assert.equal(res.status, 200);
  const task = await task0(base);
  assert.equal(task.steps[2].status, 'in_progress');
  assert.equal(task.steps[2].progress, 40);
  assert.equal(task.steps[2].currentOperation, 'Task 2/5');
  assert.equal(task.steps[2].log.length, 1);
  assert.equal(task.activeStep, 3);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-state.json'), 'utf8'));
  assert.equal(onDisk.tasks[0].steps[2].status, 'in_progress');
});

test('createApp reloads persisted state after restart', async t => {
  const dir = tmpDir();
  const app1 = createApp(dir);
  const base1 = await listen(app1);
  await post(base1, '/api/tasks', { values: { taskDescription: 'Drugi' } });
  await postState(base1, { step: 1, status: 'completed' });
  await new Promise(r => app1.server.close(r));
  const app2 = createApp(dir);
  const base2 = await listen(app2);
  t.after(() => app2.server.close());
  const state = await getState(base2);
  assert.equal(state.tasks[0].steps[0].status, 'completed');
  assert.deepEqual(state.tasks.map(x => x.id), ['t1', 't2']);
  assert.equal(state.nextTaskId, 3);
});

test('createApp discards a state file written before tasks existed', async t => {
  const dir = tmpDir();
  // The pre-task shape has no branch and no task dir, so there is nothing to migrate.
  fs.writeFileSync(path.join(dir, 'pipeline-state.json'),
    JSON.stringify({ steps: [{ id: 1, status: 'completed' }], activeStep: 4 }));
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const state = await getState(base);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].activeStep, 1);
});

test('POST /api/state with unknown step returns 400', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.equal((await postState(base, { step: 9, status: 'completed' })).status, 400);
});

test('answer queue is FIFO per task and empties', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/answer', { taskId: 't1', kind: 'answer', text: 'first' });
  await post(base, '/api/answer', { taskId: 't1', kind: 'answer', text: 'second' });
  const a1 = await (await fetch(`${base}/api/answer`)).json();
  const a2 = await (await fetch(`${base}/api/answer`)).json();
  const a3 = await (await fetch(`${base}/api/answer`)).json();
  assert.equal(a1.answer.text, 'first');
  assert.equal(a2.answer.text, 'second');
  assert.equal(a3.answer, null);
});

test('answers are queued per task and pollable filtered or unfiltered', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/tasks', {});
  await post(base, '/api/answer', { taskId: 't2', kind: 'decision', decision: 'approve' });
  // Filtering on the other task must not see it.
  assert.equal((await (await fetch(`${base}/api/answer?taskId=t1`)).json()).answer, null);
  const got = await (await fetch(`${base}/api/answer?taskId=t2`)).json();
  assert.equal(got.answer.decision, 'approve');
  assert.equal(got.answer.taskId, 't2');
  assert.equal((await post(base, '/api/answer', { taskId: 'nope' })).status, 400);
  assert.equal((await fetch(`${base}/api/answer?taskId=nope`)).status, 400);
});

test('an unfiltered long poll is released by an answer for any task', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/tasks', {});
  const polling = fetch(`${base}/api/answer?wait=5`).then(r => r.json());
  await new Promise(r => setTimeout(r, 100));
  await post(base, '/api/answer', { taskId: 't2', kind: 'answer', value: 'tak' });
  const { answer } = await polling;
  assert.equal(answer.value, 'tak');
  assert.equal(answer.taskId, 't2');
});

test('a filtered long poll ignores another task and is released by its own', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/tasks', {});
  const polling = fetch(`${base}/api/answer?taskId=t2&wait=5`).then(r => r.json());
  await new Promise(r => setTimeout(r, 100));
  await post(base, '/api/answer', { taskId: 't1', kind: 'answer', value: 'nie dla ciebie' });
  await post(base, '/api/answer', { taskId: 't2', kind: 'answer', value: 'dla ciebie' });
  const { answer } = await polling;
  assert.equal(answer.value, 'dla ciebie');
  // t1's answer stayed queued for whoever asks for it.
  const left = await (await fetch(`${base}/api/answer?taskId=t1`)).json();
  assert.equal(left.answer.value, 'nie dla ciebie');
});

test('GET /api/answer?wait=2 long-polls until an answer arrives', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  setTimeout(() => {
    post(base, '/api/answer', { taskId: 't1', kind: 'decision', decision: 'approve' });
  }, 300);
  const started = Date.now();
  const got = await (await fetch(`${base}/api/answer?wait=2`)).json();
  assert.equal(got.answer.decision, 'approve');
  assert.ok(Date.now() - started >= 250, 'should have waited for the POST');
});

test('a step1 answer is stored on the task so the form can be re-rendered', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/answer', { taskId: 't1', kind: 'step1',
    taskDescription: 'Zaproszenia', businessRequirements: 'Admin zaprasza',
    branch: 'feature/zaproszenia', contractsText: '', hintsNote: '',
    mockups: [], contracts: [], hints: [], authProvided: false, generateMockups: true });
  const task = await task0(base);
  assert.equal(task.step1Submitted, true);
  assert.equal(task.branch, 'feature/zaproszenia');
  assert.equal(task.step1.taskDescription, 'Zaproszenia');
  assert.equal(task.step1.generateMockups, true);
  // The envelope is not part of the form.
  assert.equal(task.step1.kind, undefined);
  assert.equal(task.step1.taskId, undefined);
  // Neither is anything else a client happens to send: the whole state document is
  // re-sent to the browser once a second, so only the form's own fields are kept.
  await post(base, '/api/answer', { taskId: 't1', kind: 'step1', branch: 'feature/x',
    junk: 'x'.repeat(1000), taskDescription: 'y'.repeat(300000), hints: ['../../auth.json'] });
  const after = await task0(base);
  assert.equal(after.step1.junk, undefined);
  assert.equal(after.step1.taskDescription.length, 200 * 1024);
  assert.deepEqual(after.step1.hints, ['auth.json'], 'file names stay bare names');
  // The answer still reaches the orchestrator.
  const { answer } = await (await fetch(`${base}/api/answer`)).json();
  assert.equal(answer.kind, 'step1');
});

test('uploads, auth and mockoon live under the addressed task', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await post(base, '/api/upload', { taskId: 't1', category: 'mockups',
    filename: '..\\..\\evil.png', dataBase64: Buffer.from('img-bytes').toString('base64') });
  assert.equal(res.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'tasks', 't1', 'mockups', 'evil.png'), 'utf8'),
    'img-bytes');
  await post(base, '/api/auth', { taskId: 't1', login: 'u', password: 'p' });
  assert.ok(fs.existsSync(path.join(dir, 'tasks', 't1', 'auth.json')));
  assert.equal((await task0(base)).authSaved, true);
  assert.equal((await post(base, '/api/upload', { taskId: 'nope', category: 'mockups',
    filename: 'x.png', dataBase64: 'aa' })).status, 400);
  assert.equal((await post(base, '/api/auth', { taskId: 'nope', login: 'u', password: 'p' }))
    .status, 400);
});

test('POST /api/upload/remove deletes the file and drops it from step1', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  for (const n of ['a.png', 'b.png']) {
    await post(base, '/api/upload', { taskId: 't1', category: 'hints', filename: n,
      dataBase64: Buffer.from('x').toString('base64') });
  }
  await post(base, '/api/answer', { taskId: 't1', kind: 'step1', hints: ['a.png', 'b.png'] });
  const res = await post(base, '/api/upload/remove',
    { taskId: 't1', category: 'hints', filename: 'a.png' });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'tasks', 't1', 'hints', 'a.png')), false);
  assert.deepEqual((await task0(base)).step1.hints, ['b.png']);
  // Removing something that is already gone is not an error — the form may lag.
  assert.equal((await post(base, '/api/upload/remove',
    { taskId: 't1', category: 'hints', filename: 'a.png' })).status, 200);
  assert.equal((await post(base, '/api/upload/remove',
    { taskId: 't1', category: 'secrets', filename: 'a.png' })).status, 400);
});

test('POST /api/tasks copies files, credentials and form values but never the branch', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/upload', { taskId: 't1', category: 'contracts', filename: 'api.yaml',
    dataBase64: Buffer.from('openapi: 3').toString('base64') });
  await post(base, '/api/auth', { taskId: 't1', login: 'u', password: 'p' });
  const res = await post(base, '/api/tasks', { copyFrom: 't1', values: {
    taskDescription: 'Opis', businessRequirements: 'Wymagania',
    contractsText: 'POST /invites', hintsNote: '', generateMockups: true } });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.equal(id, 't2');
  assert.equal(fs.readFileSync(path.join(dir, 'tasks', 't2', 'contracts', 'api.yaml'), 'utf8'),
    'openapi: 3');
  assert.ok(fs.existsSync(path.join(dir, 'tasks', 't2', 'auth.json')));
  const state = await getState(base);
  const t2 = state.tasks[1];
  assert.equal(t2.branch, '');
  assert.equal(t2.step1Submitted, false);
  assert.equal(t2.authSaved, true);
  assert.equal(t2.step1.taskDescription, 'Opis');
  assert.equal(t2.step1.contractsText, 'POST /invites');
  assert.equal(t2.step1.generateMockups, true);
  assert.equal(t2.step1.branch, '');
  assert.equal(t2.step1.authProvided, true);
  assert.deepEqual(t2.step1.contracts, ['api.yaml']);
  assert.deepEqual(t2.step1.mockups, []);
  assert.equal(state.nextTaskId, 3);
  assert.equal((await post(base, '/api/tasks', { copyFrom: 'nope' })).status, 400);
});

test('POST /api/tasks without copyFrom creates an empty task', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const { id } = await (await post(base, '/api/tasks', {})).json();
  const state = await getState(base);
  const task = state.tasks.find(x => x.id === id);
  assert.equal(task.step1.taskDescription, '');
  assert.equal(task.authSaved, false);
  assert.deepEqual(task.step1.hints, []);
});

test('POST /api/tasks/remove refuses a started task and the last one', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const remove = taskId => post(base, '/api/tasks/remove', { taskId });
  assert.equal((await remove('t1')).status, 400);          // last remaining
  await post(base, '/api/tasks', {});
  await post(base, '/api/upload', { taskId: 't2', category: 'hints', filename: 'a.png',
    dataBase64: Buffer.from('x').toString('base64') });
  // Step 1 in_progress is only an open form — still closable.
  await post(base, '/api/state', { taskId: 't2', step: 1, status: 'in_progress' });
  await post(base, '/api/state', { taskId: 't2', step: 2, status: 'in_progress' });
  assert.equal((await remove('t2')).status, 400);          // already started
  await post(base, '/api/state', { taskId: 't2', step: 2, status: 'waiting' });
  await post(base, '/api/answer', { taskId: 't2', kind: 'step1', branch: 'feature/x' });
  assert.equal((await remove('t2')).status, 400);          // form already submitted
  app.getState().tasks[1].step1Submitted = false;
  assert.equal((await remove('t2')).status, 200);
  const state = await getState(base);
  assert.deepEqual(state.tasks.map(x => x.id), ['t1']);
  assert.equal(fs.existsSync(path.join(dir, 'tasks', 't2')), false);
  assert.equal(state.nextTaskId, 3, 'ids are never reused');
  assert.equal((await remove('nope')).status, 400);
});

test('POST /api/auth rejects missing or blank credentials with 400', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const bad = [{}, { login: 'user' }, { password: 'pass' },
    { login: '   ', password: 'pass' }, { login: 'user', password: '   ' }];
  for (const body of bad) {
    const res = await post(base, '/api/auth', { taskId: 't1', ...body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'tasks', 't1', 'auth.json')),
    'auth.json must not be created');
});

test('POST /api/auth stores the login trimmed and the password verbatim', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await post(base, '/api/auth',
    { taskId: 't1', login: ' qa@example.com ', password: 'Zażółć!7' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 't1', 'auth.json'), 'utf8'));
  // login is trimmed; the password is stored verbatim (spaces may be legal in it)
  assert.deepEqual(saved, { login: 'qa@example.com', password: 'Zażółć!7' });
});

test('credentials are not readable back over HTTP (no GET /api/auth)', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/auth', { taskId: 't1', login: 'user', password: 'secret' });
  assert.equal((await fetch(`${base}/api/auth`)).status, 404);
  // …and the state the browser polls every second carries only the flag.
  assert.ok(!JSON.stringify(await getState(base)).includes('secret'));
});

test('POST /api/upload rejects unknown category', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await post(base, '/api/upload',
    { taskId: 't1', category: 'secrets', filename: 'x', dataBase64: 'aa' });
  assert.equal(res.status, 400);
});

test('POST /api/shutdown responds ok, closes the server, fires onShutdown', async t => {
  let shutdownCalled = false;
  const app = createApp(tmpDir(), { onShutdown: () => { shutdownCalled = true; } });
  const base = await listen(app);
  t.after(() => {
    try {
      if (app.server.closeAllConnections) app.server.closeAllConnections();
      app.server.close(() => {});
    } catch (_e) { /* already closed */ }
  });
  const closed = new Promise(r => app.server.on('close', r));
  const res = await fetch(`${base}/api/shutdown`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  await closed;
  assert.ok(shutdownCalled, 'onShutdown hook should run after close');
});

test('POST /api/shutdown deletes auth.json from every task', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => {
    try {
      if (app.server.closeAllConnections) app.server.closeAllConnections();
      app.server.close(() => {});
    } catch (_e) { /* already closed */ }
  });
  await post(base, '/api/auth', { taskId: 't1', login: 'user', password: 'secret' });
  await post(base, '/api/tasks', {});
  await post(base, '/api/auth', { taskId: 't2', login: 'user2', password: 'secret2' });
  const authFiles = ['t1', 't2'].map(id => path.join(dir, 'tasks', id, 'auth.json'));
  assert.ok(authFiles.every(f => fs.existsSync(f)));
  const closed = new Promise(r => app.server.on('close', r));
  await fetch(`${base}/api/shutdown`, { method: 'POST' });
  await closed;
  assert.ok(authFiles.every(f => !fs.existsSync(f)), 'auth.json must be wiped on shutdown');
});

test('GET /api/mockoon serves the addressed task environment file', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const env = JSON.stringify({ name: 'Feature mocks', port: 3000, hostname: 'localhost' }, null, 2);
  fs.mkdirSync(path.join(dir, 'tasks', 't1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks', 't1', 'mockoon.json'), env, 'utf8');
  const res = await fetch(`${base}/api/mockoon?taskId=t1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  // Byte-for-byte: the user copies exactly what the agent formatted.
  assert.equal(await res.text(), env);
});

test('GET /api/mockoon returns 404 before the mocks are generated or for a bad task', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.equal((await fetch(`${base}/api/mockoon?taskId=t1`)).status, 404);
  assert.equal((await fetch(`${base}/api/mockoon?taskId=t9`)).status, 404);
  assert.equal((await fetch(`${base}/api/mockoon`)).status, 404);
});

// PowerShell re-encodes curl args / temp files to the Windows ANSI codepage
// (cp1250 on Polish systems) or UTF-16, so the server must not assume UTF-8.
const CP1250 = { 'ą': 0xB9, 'ć': 0xE6, 'ę': 0xEA, 'ł': 0xB3, 'ń': 0xF1,
  'ó': 0xF3, 'ś': 0x9C, 'ź': 0x9F, 'ż': 0xBF };
const cp1250Bytes = s => Buffer.from([...s].map(ch => {
  if (ch in CP1250) return CP1250[ch];
  const code = ch.charCodeAt(0);
  assert.ok(code < 128, `no cp1250 mapping for ${ch}`);
  return code;
}));

async function postRaw(base, urlPath, buf) {
  return fetch(`${base}${urlPath}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: buf
  });
}

test('POST /api/state decodes cp1250 bodies (PowerShell mojibake) to Polish text', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const text = 'Task 1/4: Zmiana kolorów (żółty przełącznik)';
  const res = await postRaw(base, '/api/state',
    cp1250Bytes(JSON.stringify({ taskId: 't1', step: 3, currentOperation: text })));
  assert.equal(res.status, 200);
  assert.equal((await task0(base)).steps[2].currentOperation, text);
});

test('POST /api/state decodes UTF-16LE BOM bodies (PowerShell Out-File default)', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const text = 'Zażółć gęślą jaźń';
  const json = JSON.stringify({ taskId: 't1', step: 2, currentOperation: text });
  const res = await postRaw(base, '/api/state',
    Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(json, 'utf16le')]));
  assert.equal(res.status, 200);
  assert.equal((await task0(base)).steps[1].currentOperation, text);
});

test('POST /api/state strips a UTF-8 BOM before parsing', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const json = JSON.stringify({ taskId: 't1', step: 1, currentOperation: 'Wymagania — zapisuję' });
  const res = await postRaw(base, '/api/state',
    Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(json, 'utf8')]));
  assert.equal(res.status, 200);
  assert.equal((await task0(base)).steps[0].currentOperation, 'Wymagania — zapisuję');
});

test('POST /api/state passes valid UTF-8 Polish text through unchanged', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const text = 'Pchnąć w tę łódź jeża lub ośm skrzyń fig';
  const res = await postRaw(base, '/api/state',
    Buffer.from(JSON.stringify({ taskId: 't1', step: 4, logEntry: text }), 'utf8'));
  assert.equal(res.status, 200);
  assert.equal((await task0(base)).steps[3].log[0].text, text);
});

test('GET / serves the stepper UI', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Requirements/);
});

test('POST /api/state bumps questionSeq per task even when the question id repeats', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/tasks', {});
  const seq = async id => (await getState(base)).tasks.find(x => x.id === id).questionSeq;
  assert.strictEqual(await seq('t1'), 0);
  await postState(base, { question: { id: 'q1', text: 'first' } });
  assert.strictEqual(await seq('t1'), 1);
  await postState(base, { question: null });
  await postState(base, { question: { id: 'q1', text: 'second' } });
  assert.strictEqual(await seq('t1'), 3, 'every question POST moves the counter the UI re-renders on');
  assert.strictEqual(await seq('t2'), 0, 'the counter belongs to the task, not the run');
});
