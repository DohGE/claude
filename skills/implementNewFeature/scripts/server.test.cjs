'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
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

// Chat entries carry a `time` as well; these helpers keep an assertion about who said
// what from having to restate it.
const said = chat => (chat || []).map(({ role, text }) => ({ role, text }));
const getState = async base => (await fetch(`${base}/api/state`)).json();
const task0 = async base => (await getState(base)).tasks[0];

test('GET /api/state returns one task with the 8-step pipeline, Mockups and Story opt-in', async t => {
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
      'Validation & E2E', 'Code Review', 'Mockoon Mocks', 'Story Description', 'Final Code Review']);
  assert.ok(task.steps.every(s => s.status === 'waiting'));
  // The review runs before validation, the final review after it; Mockoon is on demand.
  assert.deepEqual(task.route, [1, 2, 3, 8, 4, 6, 5, 9]);
  assert.equal(task.base, null);
  // Mockups and Story are the steps the stepper hides until a step-1 switch enables them;
  // refinement has a switch too, but it starts on.
  assert.deepEqual(task.steps.filter(s => s.enabled === false).map(s => s.id), [3, 8]);
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

test('the server owns the mockup rev, and the step owns the chat', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const screens = [{ id: 'login', title: 'Logowanie', file: 'login.html' }];
  await postState(base, { step: 3, enabled: true });
  // Round 1: the orchestrator sends the round, never a counter and never the chat.
  await postState(base, { mockupReview: { text: 'Pierwsza wersja', screens },
    mockupChat: { role: 'agent', text: 'Pierwsza wersja' } });
  const chatOf = async () => said((await task0(base)).steps[2].chat);
  assert.equal((await task0(base)).mockupReview.rev, 1);
  assert.deepEqual(await chatOf(), [{ role: 'agent', text: 'Pierwsza wersja' }]);
  // The user's feedback appends without resending anything.
  await postState(base, { step: 3, mockupChat: { role: 'user', text: 'Szerszy przycisk' } });
  assert.equal((await task0(base)).mockupReview.rev, 1, 'feedback is not a new round');
  assert.equal((await chatOf()).length, 2);
  // Round 2 carries the chat forward and moves the counter the UI re-renders on.
  await postState(base, { step: 3, mockupReview: { text: 'Druga wersja', screens },
    mockupChat: { role: 'agent', text: 'Druga wersja' } });
  assert.equal((await task0(base)).mockupReview.rev, 2);
  assert.deepEqual((await chatOf()).map(m => m.role), ['agent', 'user', 'agent']);
  // Clearing the panel and starting over keeps the counter monotonic - and keeps the
  // conversation, which belongs to the step the user held it on, not to one round.
  await postState(base, { mockupReview: null });
  await postState(base, { mockupReview: { text: 'Trzecia', screens } });
  assert.equal((await task0(base)).mockupReview.rev, 3);
  assert.equal((await chatOf()).length, 3);
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

test('a truncated state file is kept aside, not silently overwritten', async t => {
  const dir = tmpDir();
  const stateFile = path.join(dir, 'pipeline-state.json');
  // What a process killed mid-write leaves behind.
  fs.writeFileSync(stateFile, '{"tasks":[{"id":"t1","bran');
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.equal((await getState(base)).tasks.length, 1, 'the run starts fresh rather than refusing to run');
  assert.ok(fs.existsSync(`${stateFile}.corrupt`), 'the unreadable file is preserved for inspection');
  await postState(base, { step: 1, status: 'completed' });
  assert.ok(!fs.existsSync(`${stateFile}.tmp`), 'the atomic write leaves no temporary file behind');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).tasks.length, 1, 'and the state file is complete JSON');
});

test('POST /api/state with unknown step returns 400', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.equal((await postState(base, { step: 10, status: 'completed' })).status, 400);
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

test('an abandoned long poll does not swallow the answer meant for the next one', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  // The orchestrator's poll dies mid-wait (tool timeout, interrupted session).
  const ac = new AbortController();
  const abandoned = fetch(`${base}/api/answer?wait=300`, { signal: ac.signal }).catch(() => null);
  await new Promise(r => setTimeout(r, 50));
  ac.abort();
  await abandoned;
  await new Promise(r => setTimeout(r, 50));
  // The user answers in the browser afterwards; it must reach the NEXT poll.
  await post(base, '/api/answer', { taskId: 't1', kind: 'answer', text: 'still here' });
  const got = await (await fetch(`${base}/api/answer?wait=1`)).json();
  assert.equal(got.answer && got.answer.text, 'still here');
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
    taskDescription: 'Zaproszenia',
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
  // Cut at the cap, then marked - the marker is what makes the loss visible to whoever
  // reads requirements.md, so it is part of the stored value rather than a side channel.
  assert.ok(after.step1.taskDescription.startsWith("y".repeat(200 * 1024)));
  assert.match(after.step1.taskDescription.slice(200 * 1024), /ucięte/);
  assert.deepEqual(after.step1.hints, ['auth.json'], 'file names stay bare names');
  // The answer still reaches the orchestrator.
  const { answer } = await (await fetch(`${base}/api/answer`)).json();
  assert.equal(answer.kind, 'step1');
});

test('a transcript line is capped far below a form field, and says which cap it hit', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  // MAX_CHAT keeps a looping agent from growing the state document without bound -
  // which at the form's 200 KB it did not: 200 entries x 200 KB is 40 MB for one step,
  // re-sent to the browser every second. A chat line is a message someone reads back.
  await postState(base, { step: 4, chat: { role: 'agent', text: 'x'.repeat(50000) } });
  const line = (await task0(base)).steps[3].chat[0].text;
  assert.ok(line.length < 9 * 1024, 'the line is cut at the transcript cap, not the form one');
  assert.match(line, /ucięte.*8 KB/, 'and the marker names the cap it hit');
  // A form field is a pasted document and keeps the 200 KB it was sized for.
  await post(base, '/api/answer', { taskId: 't1', kind: 'step1', branch: 'b',
    taskDescription: 'y'.repeat(50000) });
  assert.strictEqual((await task0(base)).step1.taskDescription.length, 50000,
    'a 50 KB requirement is nowhere near the form cap');
});

test('a clean shutdown stops advertising a pid that is about to die', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  // What the launcher reads to find the instance it must stop. Leaving it behind after
  // a clean exit advertises a pid the OS is free to hand to something else, and the next
  // launcher run then aims a kill at whatever inherited it.
  const marker = path.join(dir, 'server.json');
  fs.writeFileSync(marker, JSON.stringify({ port: 9999, pid: process.pid }));
  assert.ok(fs.existsSync(marker));
  await post(base, '/api/shutdown', {});
  await new Promise((r) => { setTimeout(r, 120); });
  assert.ok(!fs.existsSync(marker), 'server.json does not outlive the process it describes');
});

test('an oversized report, operation or log entry is cut and marked', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  // `GET /api/state` re-sends the WHOLE document once a second and `persist()`
  // rewrites it on every update, so an agent that pastes its findings instead of a
  // summary would be paid for again every tick for the rest of the run.
  const huge = 'x'.repeat(300000);
  await postState(base, { step: 6, report: huge, currentOperation: huge, logEntry: huge });
  const step = (await task0(base)).steps[5];
  for (const [name, value] of [['report', step.report], ['currentOperation', step.currentOperation],
    ['logEntry', step.log[0].text]]) {
    assert.ok(value.length < 210 * 1024, `${name} is cut at the cap`);
    assert.match(value.slice(200 * 1024), /ucięte/, `${name} says it was cut`);
  }
  // The cap must not turn a cleared report into an empty string: null clears the panel.
  await postState(base, { step: 6, report: null });
  assert.strictEqual((await task0(base)).steps[5].report, null);
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
  // A form saved before the two fields were merged keeps the second one, folded in.
  assert.equal(t2.step1.taskDescription, 'Opis\n\nWymagania');
  assert.equal(t2.step1.businessRequirements, undefined);
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

test('POST /api/answer records mockup feedback in the chat as it arrives', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 3, enabled: true });
  await postState(base, { step: 3, status: 'in_progress', activeStep: 3,
    mockupReview: { text: 'Two screens', screens: [] } });
  await post(base, '/api/answer', { taskId: 't1', kind: 'mockup', decision: 'feedback',
    text: 'Wider button' });
  assert.deepStrictEqual(said((await task0(base)).steps[2].chat),
    [{ role: 'user', text: 'Wider button' }],
    'the browser gets its message back without waiting for the orchestrator');
  // Approve is not a chat message.
  await post(base, '/api/answer', { taskId: 't1', kind: 'mockup', decision: 'approve' });
  assert.strictEqual((await task0(base)).steps[2].chat.length, 1);
});

test('POST /api/answer: a Claude artifact of the mockups leaves the round on screen and goes to the orchestrator', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 3, enabled: true });
  await postState(base, { step: 3, status: 'in_progress', activeStep: 3, currentOperation: 'Waiting for your review',
    mockupReview: { text: 'Two screens', screens: [] } });
  const res = await post(base, '/api/answer', { taskId: 't1', kind: 'mockup', decision: 'artifact' });
  assert.equal(res.status, 200);
  const task = await task0(base);
  assert.ok(task.mockupReview && !task.mockupReview.answered, 'the round stays up for review');
  assert.strictEqual(task.steps[2].currentOperation, 'Waiting for your review', 'the review goes on');
  assert.deepStrictEqual(said(task.steps[2].chat), [], 'no chat line: the orchestrator posts the link');
  assert.match(JSON.stringify(task.steps[2].log), /Claude artifact of the mockups requested/);
  const answer = (await (await fetch(`${base}/api/answer?taskId=t1&wait=1`)).json()).answer;
  assert.deepStrictEqual([answer.kind, answer.decision], ['mockup', 'artifact']);
});

test('POST /api/state stamps reviewSummary with a fresh rev every round', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const rev = async () => (await task0(base)).reviewSummary.rev;
  await postState(base, { step: 2, reviewSummary: { text: 'Plan v1' } });
  assert.strictEqual(await rev(), 1);
  await postState(base, { reviewSummary: null });
  await postState(base, { step: 2, reviewSummary: { text: 'Plan v2' } });
  assert.strictEqual(await rev(), 2, 'a revised plan must replace the one on screen');
  await postState(base, { step: 2, reviewSummary: { text: 'Plan v3', rev: 9 } });
  assert.strictEqual(await rev(), 9, 'an explicit rev still wins, as a resumed run needs');
});

test('the launched server announces port AND pid, which is what the start scripts stop', async t => {
  const dir = tmpDir();
  // Both start scripts read server.json to stop the previous instance before
  // taking its port back. Without the pid they cannot, and a restart silently
  // leaves two servers sharing this session's state.
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs'), '--session-dir', dir, '--port', '0'],
    { stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch (_e) {} });
  const file = path.join(dir, 'server.json');
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.existsSync(file), 'the server writes server.json on listen');
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(info.port > 0, 'the announced port is a real one');
  assert.strictEqual(info.pid, child.pid, 'the announced pid is the process to stop');
});

test('a session under .claude/doh gets the catch-all .gitignore, credentials included', async t => {
  const root = tmpDir();
  const dohDir = path.join(root, '.claude', 'doh');
  const dir = path.join(dohDir, '20260912-120000');
  fs.mkdirSync(dir, { recursive: true });
  const app = createApp(dir);
  t.after(() => app.server.close());
  const gi = fs.readFileSync(path.join(dohDir, '.gitignore'), 'utf8');
  assert.match(gi, /^\*$/m, 'everything in doh/ is ignored by default');
  assert.match(gi, /^!instructions\/\*\*$/m, 'except the project rulebook, which is meant to be shared');
  // Not under .claude/doh: nothing is written where it would not belong.
  const plain = tmpDir();
  createApp(plain).server.close();
  assert.ok(!fs.existsSync(path.join(path.dirname(plain), '.gitignore')));
});

test('the step names SKILL.md quotes at the user are the names the server ships', async t => {
  // A failed run reports `Failed at <step name>` and must use the NAME, never the id:
  // with mockups off the tiles renumber, so an id points the user at the wrong tile.
  // That makes every name SKILL.md spells out part of the contract - rename a step in
  // the server and the summary starts naming a step that no longer exists.
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const names = (await getState(base)).tasks[0].steps.map(s => s.name);
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  for (const quoted of ['Requirements', 'Feature Refinement', 'Mockups', 'Implementation',
    'Validation & E2E', 'Code Review', 'Mockoon Mocks', 'Story Description', 'Final Code Review']) {
    assert.ok(names.includes(quoted), 'the server still ships the step named ' + quoted);
    assert.ok(skill.includes(quoted), 'SKILL.md still names the step ' + quoted);
  }
  assert.strictEqual(names.length, 9);
});

test('an answer reaches the poll with the field names SKILL.md tells the run to read', async t => {
  // The orchestrator reads `questionId` and `value` off the polled answer. They are not
  // guessable - `decision` and `mockup` carry their text in `text`, so reading `text`
  // here yields undefined and the run forwards an empty answer to the agent instead of
  // stopping. The page is the only producer, so its names are the contract.
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { question: { id: 'q1', text: 'Which one?', options: ['A', 'B'] } });
  await post(base, '/api/answer', { taskId: 't1', kind: 'answer', questionId: 'q1', value: 'B' });
  const { answer } = await (await fetch(`${base}/api/answer?wait=1`)).json();
  assert.deepStrictEqual(answer, { taskId: 't1', kind: 'answer', questionId: 'q1', value: 'B' });
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  for (const name of ['questionId', 'value']) {
    assert.ok(skill.includes('`' + name + '`'), 'SKILL.md still names the field ' + name);
  }
});

test('every field the page sends back is a field SKILL.md names', () => {
  // The page is the only producer of these payloads and the orchestrator the only
  // consumer; nothing in between validates a name. A field added to the form, or one
  // renamed, reaches an orchestrator that never learned to read it - and an unread
  // field is indistinguishable from a field the user left empty.
  const ui = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');
  // The orchestrator reads SKILL.md and the step file of the step it is on (references/steps/).
  const stepsDir = path.join(__dirname, '..', 'references', 'steps');
  const skill = [path.join(__dirname, '..', 'SKILL.md'), ...fs.readdirSync(stepsDir).map((n) => path.join(stepsDir, n))]
    .map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  const names = new Set();
  for (let at = ui.indexOf('sendAnswer({'); at !== -1; at = ui.indexOf('sendAnswer({', at + 1)) {
    const open = ui.indexOf('{', at);
    let depth = 0, end = open;
    for (; end < ui.length; end++) {
      if (ui[end] === '{') depth++;
      else if (ui[end] === '}' && --depth === 0) { end++; break; }
    }
    let nest = 0, current = '';
    const parts = [];
    for (const ch of ui.slice(open + 1, end - 1)) {
      if ('{(['.includes(ch)) nest++;
      if ('})]'.includes(ch)) nest--;
      if (ch === ',' && nest === 0) { parts.push(current); current = ''; } else current += ch;
    }
    parts.push(current);
    for (const part of parts) {
      const m = part.trim().match(/^([a-zA-Z][a-zA-Z0-9]*)s*:/)
        || part.trim().match(/^([a-zA-Z][a-zA-Z0-9]*)$/);
      if (m) names.add(m[1]);
    }
  }
  names.delete('kind');
  assert.ok(names.size >= 10, 'the payload fields were found: ' + [...names].join(', '));
  assert.deepStrictEqual([...names].filter((n) => !skill.includes(n)).sort(), [],
    'these fields travel to the orchestrator without SKILL.md ever naming them');
});

test('the stepper page loads nothing from the network but its own server', () => {
  // The pipeline runs on machines that may be offline or behind a proxy that does not
  // let a CDN through. A stylesheet or script pulled from outside would not fail at
  // author time and would take the whole control surface down where it matters.
  const ui = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');
  const refs = [...ui.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]);
  const external = refs.filter((u) => /^(https?:)?\/\//.test(u));
  assert.deepStrictEqual(external, [], 'these resources come from outside the server');
  for (const call of ['WebSocket', 'sendBeacon', 'document.cookie']) {
    assert.ok(!ui.includes(call), 'the page must not use ' + call);
  }
});

test('a field past the cap is marked as cut, not quietly shortened', async t => {
  // `contractsText` exists for pasting a contract, and an OpenAPI document routinely
  // runs past the cap. Cutting it mid-sentence with nothing said leaves the refinement
  // agent designing against half a document, with no way to know it is half.
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const long = 'x'.repeat(200 * 1024 + 10);
  await post(base, '/api/answer', { taskId: 't1', kind: 'step1', taskDescription: 'krótki opis',
    branch: 'feature/x', contractsText: long });
  const form = (await task0(base)).step1;
  assert.ok(form.contractsText.length > 200 * 1024, 'the cut leaves a marker behind it');
  assert.match(form.contractsText, /ucięte/, 'and the marker says what happened');
  assert.strictEqual(form.taskDescription, 'krótki opis', 'a field inside the cap is untouched');
});

test('an upload past the body cap is refused with a reason, and the server survives', async t => {
  // Destroying the socket on overflow left the page with a bare network failure, so a
  // file too large read as `the server is gone` - and the user went hunting for a dead
  // process instead of a smaller file. Draining the rest costs milliseconds on a local
  // socket and is what lets the response reach the browser at all.
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await post(base, '/api/answer',
    { taskId: 't1', kind: 'step1', taskDescription: 'x'.repeat(26 * 1024 * 1024) });
  assert.strictEqual(res.status, 413);
  assert.match((await res.json()).error, /body over 25 MB/);
  const after = await fetch(`${base}/api/state`);
  assert.strictEqual(after.status, 200, 'one refused upload must not take the run down');
});

test('a malformed request line is answered, not fatal', async t => {
  // `new URL` used to run outside the handler's try, so `GET ////` threw, the async
  // handler rejected, and the unhandled rejection took the process down - with every
  // task's state open. Anyone able to reach the port could end a run from a browser bar.
  const net = require('net');
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const port = app.server.address().port;
  const eol = String.fromCharCode(13, 10);
  const raw = (line) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(line + eol + 'Host: x' + eol + 'Content-Length: 0' + eol + eol);
    });
    let seen = '';
    socket.on('data', (d) => { seen += d; });
    socket.on('close', () => resolve(seen.split(eol)[0] || ''));
    socket.on('error', () => resolve(''));
    setTimeout(() => socket.destroy(), 500);
  });
  for (const line of ['GET //// HTTP/1.1', 'GET http://x:y:z/api/state HTTP/1.1']) {
    const status = await raw(line);
    const code = Number(status.split(' ')[1]);
    assert.ok(code >= 400 && code < 600, line + ' -> ' + status);
  }
  assert.strictEqual((await fetch(`${base}/api/state`)).status, 200, 'and the server is still up');
});

test('a burst of hostile requests leaves the server answering', async t => {
  // The run is long, interactive and holds every task's state in this one process, so a
  // single request that escapes the handler ends it. This fires the shapes that reach a
  // local port in practice - a stray browser probe, a half-written body, a traversal try
  // - all at once, because a path can be safe alone and fatal while others are in flight.
  const net = require('net');
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const port = app.server.address().port;
  const eol = String.fromCharCode(13, 10);
  const raw = (line) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(line + eol + 'Host: x' + eol + 'Content-Length: 0' + eol + eol);
    });
    socket.on('data', () => {});
    socket.on('close', () => resolve());
    socket.on('error', () => resolve());
    setTimeout(() => { socket.destroy(); resolve(); }, 300);
  });
  const send = (path, body) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }).catch(() => null);
  const jobs = [];
  for (let i = 0; i < 15; i++) {
    jobs.push(raw('GET //// HTTP/1.1'));
    jobs.push(raw('GET /generated-mockups/../../x HTTP/1.1'));
    jobs.push(send('/api/state', '{not json'));
    jobs.push(send('/api/answer', JSON.stringify({ taskId: 'nope', kind: 'answer' })));
    jobs.push(fetch(base + '/api/answer?taskId=nope').catch(() => null));
    jobs.push(fetch(base + '/api/state').catch(() => null));
  }
  await Promise.all(jobs);
  assert.strictEqual((await fetch(base + '/api/state')).status, 200,
    'the server answered ' + jobs.length + ' hostile requests and is still up');
});

test('a body that will not parse is a caller error, not a server error', async t => {
  // The page shows the status it got. Answering 500 to a malformed body tells the user
  // the run broke, which sends them to the server log for a mistake that lives in the
  // request - and the two need opposite responses.
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(base + '/api/state', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /malformed JSON body/);
  const ok = await postState(base, { step: 1, status: 'completed' });
  assert.strictEqual(ok.status, 200, 'a good body still goes through');
});

// --- Model, effort i czat per krok ---------------------------------------------

const AGENTS_FORM = {
  model: 'opus', effort: 'high',
  steps: {
    2: { model: 'sonnet', effort: 'low' }, 3: { model: '', effort: '' },
    4: { model: '', effort: 'max' }, 5: { model: '', effort: '' },
    6: { model: 'haiku', effort: '' }, 7: { model: '', effort: '' }
  }
};

const step1 = (base, extra) => post(base, '/api/answer', { taskId: 't1', kind: 'step1',
  taskDescription: 'Opis', branch: 'feature/x', ...extra });

test('krok 1 zapamiętuje model i effort agenta, globalnie i per krok', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, { agents: AGENTS_FORM });
  const { agents } = (await task0(base)).step1;
  assert.strictEqual(agents.model, 'opus');
  assert.strictEqual(agents.effort, 'high');
  assert.deepStrictEqual(agents.steps['2'], { model: 'sonnet', effort: 'low' });
  assert.deepStrictEqual(agents.steps['4'], { model: '', effort: 'max' });
  assert.deepStrictEqual(agents.steps['6'], { model: 'haiku', effort: '' });
  // Kroki bez nadpisania dziedziczą — w stanie stoją jako puste, nie jako brak klucza.
  assert.deepStrictEqual(Object.keys(agents.steps), ['2', '3', '4', '5', '6', '7', '8', '9']);
  // Every helper a step's agent spawns has a setting of its own, unset here.
  assert.deepStrictEqual(Object.keys(agents.roles), ['reviewWalker', 'reviewFixer', 'validationRunner',
    'validationCompliance', 'finalWalker', 'finalFixer']);
  assert.ok(Object.values(agents.roles).every(r => r.model === '' && r.effort === ''));
});

test('model i effort spoza listy schodzą do dziedziczenia, nie lecą do agenta', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  // Wartość, której narzędzie Agent nie zna, wywaliłaby spawn w połowie runu.
  await step1(base, { agents: { model: 'gpt-4', effort: 'ultra',
    steps: { 4: { model: 'sonnet-5-mega', effort: 'wysoki' } } } });
  const { agents } = (await task0(base)).step1;
  assert.strictEqual(agents.model, '');
  assert.strictEqual(agents.effort, '');
  assert.deepStrictEqual(agents.steps['4'], { model: '', effort: '' });
});

test('formularz bez ustawień agenta daje pełny, pusty zestaw', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, {});
  const { agents } = (await task0(base)).step1;
  assert.strictEqual(agents.model, '');
  assert.strictEqual(agents.effort, '');
  assert.deepStrictEqual(agents.steps['5'], { model: '', effort: '' });
});

const FALLBACK_MODELS = [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }, { value: 'fable', label: 'Fable' }];

test('lista modeli pochodzi z models.json sesji i tylko ona przechodzi do stanu', async t => {
  const dir = tmpDir();
  const models = [{ value: 'opus', label: 'Opus 5.5' }, { value: 'claude-sonnet-5', label: 'Sonnet 5' }];
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(models));
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.deepStrictEqual((await getState(base)).models, models);
  // Haiku jest aliasem, który przechodził wcześniej — ta sesja go nie oferuje.
  await step1(base, { agents: { model: 'claude-sonnet-5', steps: { 4: { model: 'haiku' } } } });
  const { agents } = (await task0(base)).step1;
  assert.strictEqual(agents.model, 'claude-sonnet-5');
  assert.strictEqual(agents.steps['4'].model, '');
  // Lista jest wyliczana, nie zapisywana: stan na dysku jej nie niesie.
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-state.json'), 'utf8'));
  assert.strictEqual(saved.models, undefined);
});

test('bez używalnego models.json serwer podaje aliasy bez wersji', async t => {
  const cases = [null, '{', '{"models":[{"value":"opus"}]}', '[]',
    JSON.stringify([{ value: '' }, { value: 'rm -rf /', label: 'x' }, { label: 'Opus' }, 'opus'])];
  for (const body of cases) {
    const dir = tmpDir();
    if (body !== null) fs.writeFileSync(path.join(dir, 'models.json'), body);
    const app = createApp(dir);
    const base = await listen(app);
    const { models } = await getState(base);
    app.server.close();
    assert.deepStrictEqual(models, FALLBACK_MODELS, `models.json: ${body}`);
  }
});

test('models.json: brak etykiety to wartość, duplikat wypada, UTF-16 z PowerShella się czyta', async t => {
  const dir = tmpDir();
  const list = [{ value: 'opus', label: '  Opus 5.5  ' }, { value: 'opus', label: 'drugi' },
    { value: 'fable' }, { value: 'x y', label: 'spacja' }];
  // Out-File w Windows PowerShell pisze UTF-16LE z BOM-em.
  fs.writeFileSync(path.join(dir, 'models.json'),
    Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(JSON.stringify(list), 'utf16le')]));
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.deepStrictEqual((await getState(base)).models,
    [{ value: 'opus', label: 'Opus 5.5' }, { value: 'fable', label: 'fable' }]);
});

test('wznowiony run z modelem, którego sesja już nie oferuje, dziedziczy', async t => {
  const dir = tmpDir();
  const first = createApp(dir);
  const firstBase = await listen(first);
  await step1(firstBase, { agents: { model: 'fable', effort: 'high',
    steps: { 6: { model: 'sonnet', effort: 'low' } } } });
  await new Promise(r => first.server.close(r));
  fs.writeFileSync(path.join(dir, 'models.json'),
    JSON.stringify([{ value: 'opus', label: 'Opus 5.5' }, { value: 'sonnet', label: 'Sonnet 5' }]));
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const { agents } = (await task0(base)).step1;
  // Spawn z fable padłby dopiero na tym kroku; effort zostaje, bo nie zależy od modelu.
  assert.strictEqual(agents.model, '');
  assert.strictEqual(agents.effort, 'high');
  assert.deepStrictEqual(agents.steps['6'], { model: 'sonnet', effort: 'low' });
});

test('każdy krok startuje z pustym czatem', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.ok((await task0(base)).steps.every(s => Array.isArray(s.chat) && s.chat.length === 0));
});

test('POST /api/state dopisuje linię agenta do czatu wskazanego kroku', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 4, status: 'in_progress', activeStep: 4,
    chat: { role: 'agent', text: 'Robię to inaczej — bez migracji.' } });
  const task = await task0(base);
  assert.deepStrictEqual(said(task.steps[3].chat),
    [{ role: 'agent', text: 'Robię to inaczej — bez migracji.' }]);
  assert.deepStrictEqual(task.steps[4].chat, [], 'czat należy do kroku, nie do taska');
  // Rola inna niż user jest agentem: przeglądarka rysuje tylko te dwie.
  await postState(base, { step: 4, chat: { role: 'system', text: 'x' } });
  assert.strictEqual((await task0(base)).steps[3].chat[1].role, 'agent');
});

test('czat bez podanego kroku jest odrzucany, nie ginie po cichu', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await postState(base, { chat: { role: 'agent', text: 'donikąd' } });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /chat/);
});

test('mockupChat pisze do czatu kroku 3, a runda mockupów go nie kasuje', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const screens = [{ id: 'login', title: 'Logowanie', file: 'login.html' }];
  await postState(base, { step: 3, enabled: true });
  await postState(base, { step: 3, mockupReview: { text: 'Pierwsza wersja', screens },
    mockupChat: { role: 'agent', text: 'Pierwsza wersja' } });
  assert.deepStrictEqual(said((await task0(base)).steps[2].chat),
    [{ role: 'agent', text: 'Pierwsza wersja' }]);
  await postState(base, { step: 3, mockupReview: { text: 'Druga wersja', screens },
    mockupChat: { role: 'agent', text: 'Druga wersja' } });
  const task = await task0(base);
  assert.strictEqual(task.mockupReview.rev, 2);
  assert.deepStrictEqual(task.steps[2].chat.map(m => m.text),
    ['Pierwsza wersja', 'Druga wersja'], 'transkrypcja przeżywa kolejne rundy');
  assert.strictEqual(task.mockupReview.chat, undefined,
    'czat ma jedno miejsce — krok, nie panel recenzji');
});

test('POST /api/answer kind=message dopisuje linię użytkownika i budzi pętlę', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 4, status: 'in_progress', activeStep: 4 });
  const waiting = fetch(`${base}/api/answer?wait=5`).then(r => r.json());
  await post(base, '/api/answer',
    { taskId: 't1', kind: 'message', step: 4, text: 'Pomiń cache, zrób to synchronicznie' });
  const { answer } = await waiting;
  assert.strictEqual(answer.kind, 'message');
  assert.strictEqual(answer.step, 4);
  assert.strictEqual(answer.taskId, 't1');
  assert.deepStrictEqual(said((await task0(base)).steps[3].chat),
    [{ role: 'user', text: 'Pomiń cache, zrób to synchronicznie' }],
    'przeglądarka widzi swoją wiadomość bez czekania na orkiestratora');
});

test('message do nieistniejącego kroku jest odrzucany', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await post(base, '/api/answer',
    { taskId: 't1', kind: 'message', step: 10, text: 'halo' });
  assert.strictEqual(res.status, 400);
  const { answer } = await (await fetch(`${base}/api/answer`)).json();
  assert.strictEqual(answer, null, 'odrzucona wiadomość nie trafia do kolejki');
});

test('stan wczytany sprzed czatu dostaje puste czaty zamiast wywracać panel', async t => {
  const dir = tmpDir();
  // Dokładnie to, co leży na dysku po runie z poprzedniej wersji skilla.
  const old = { tasks: [{ id: 't1', branch: '', root: null, activeStep: 4,
    steps: [1, 2, 3, 4, 5, 6, 7].map(id => ({ id, name: `S${id}`, status: 'waiting',
      progress: null, enabled: true, currentOperation: '', report: null, log: [] })),
    question: null, questionSeq: 0, mockupSeq: 0, reviewSeq: 0, reviewSummary: null,
    mockupReview: null, summary: null, step1: null, step1Submitted: false,
    authSaved: false }], nextTaskId: 2 };
  fs.writeFileSync(path.join(dir, 'pipeline-state.json'), JSON.stringify(old));
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.ok((await task0(base)).steps.every(s => Array.isArray(s.chat)));
  const res = await postState(base, { step: 4, chat: { role: 'agent', text: 'wracam' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await task0(base)).steps[3].chat.length, 1);
});

test('czat makiet trafia do kroku o id 3, nie na trzecią pozycję listy', async t => {
  const dir = tmpDir();
  // Stan z kolejnością kroków inną niż domyślna: id są kontraktem, pozycja nie.
  const shuffled = { tasks: [{ id: 't1', branch: '', root: null, activeStep: 1,
    steps: [3, 1, 2, 4, 5, 6, 7].map(id => ({ id, name: `S${id}`, status: 'waiting',
      progress: null, enabled: true, currentOperation: '', report: null, log: [], chat: [] })),
    question: null, questionSeq: 0, mockupSeq: 0, reviewSeq: 0, reviewSummary: null,
    mockupReview: null, summary: null, step1: null, step1Submitted: false,
    authSaved: false }], nextTaskId: 2 };
  fs.writeFileSync(path.join(dir, 'pipeline-state.json'), JSON.stringify(shuffled));
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());

  await postState(base, { mockupChat: { role: 'agent', text: 'makieta gotowa' } });
  const steps = (await task0(base)).steps;
  assert.deepStrictEqual(said(steps.find(s => s.id === 3).chat),
    [{ role: 'agent', text: 'makieta gotowa' }]);
  assert.deepStrictEqual(steps.find(s => s.id === 2).chat, [],
    'trzecia pozycja listy to nie krok 3');
});

test('czat makiet w stanie bez kroku 3 jest głośnym błędem, nie wywrotką', async t => {
  const dir = tmpDir();
  const short = { tasks: [{ id: 't1', branch: '', root: null, activeStep: 1,
    steps: [1, 2].map(id => ({ id, name: `S${id}`, status: 'waiting', progress: null,
      enabled: true, currentOperation: '', report: null, log: [], chat: [] })),
    question: null, questionSeq: 0, mockupSeq: 0, reviewSeq: 0, reviewSummary: null,
    mockupReview: null, summary: null, step1: null, step1Submitted: false,
    authSaved: false }], nextTaskId: 2 };
  fs.writeFileSync(path.join(dir, 'pipeline-state.json'), JSON.stringify(short));
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());

  const res = await postState(base, { mockupChat: { role: 'agent', text: 'donikąd' } });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /unknown step 3/);
});

test('literówka w nazwie pola to głośny błąd, nie ciche 200', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());

  const res = await postState(base, { step: 4, currentOperationn: 'Piszę kod' });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /unknown field.* currentOperationn/);
  // I nic z takiego ciała nie zostaje zastosowane — nawet pola, które są poprawne.
  const task = await task0(base);
  assert.strictEqual(task.steps[3].currentOperation, '');
  assert.strictEqual(task.steps[3].status, 'waiting');
});

test('poprawne ciało przechodzi w całości, z każdym polem kontraktu', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());

  const res = await postState(base, {
    step: 4, status: 'in_progress', enabled: true, progress: 40,
    currentOperation: 'Task 2/5', report: null, logEntry: 'zrobione',
    chat: { role: 'agent', text: 'lecę dalej' }, activeStep: 4, branch: 'feature/x',
    root: null, question: null, reviewSummary: null, mockupReview: null, summary: null,
  });
  assert.strictEqual(res.status, 200);
  const task = await task0(base);
  assert.strictEqual(task.steps[3].currentOperation, 'Task 2/5');
  assert.strictEqual(task.branch, 'feature/x');
});

// --- Stały port 9999 i klucz projektu ------------------------------------------

const DEFAULT_PORT = 9999;

// Uruchomienie server.cjs tak, jak robi to launcher, i poczekanie na server.json.
function spawnServer(t, dir, args) {
  const child = spawn(process.execPath,
    [path.join(__dirname, 'server.cjs'), '--session-dir', dir, ...(args || [])],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', c => { err += c; });
  const dead = new Promise(r => child.on('exit', r));
  t.after(async () => { try { child.kill(); } catch (_e) {} await dead; });
  return {
    child,
    stderr: () => err,
    exit: (ms = 8000) => Promise.race([
      new Promise(r => child.on('exit', code => r(code))),
      new Promise(r => setTimeout(() => r('still running'), ms))
    ]),
    async info(ms = 5000) {
      const file = path.join(dir, 'server.json');
      for (let i = 0; i < ms / 50 && !fs.existsSync(file); i++) {
        await new Promise(r => setTimeout(r, 50));
      }
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    }
  };
}

test('bez --port serwer siada na 9999, bo tam użytkownik ma otwartą kartę', async t => {
  const srv = spawnServer(t, tmpDir());
  const info = await srv.info();
  assert.ok(info, 'server.json powstał: ' + srv.stderr());
  assert.strictEqual(info.port, DEFAULT_PORT);
});

test('zajęty 9999 to głośna awaria, nie ciche przeniesienie na inny port', async t => {
  // Cicha zmiana portu jest gorsza niż brak startu: orkiestrator i wszystkie prompty
  // sub-agentów niosą 9999, więc run wyglądałby na żywy, a panele stałyby martwe.
  const squatter = http.createServer((_q, r) => r.end());
  await new Promise(r => squatter.listen(DEFAULT_PORT, '127.0.0.1', r));
  t.after(() => new Promise(r => squatter.close(r)));
  const dir = tmpDir();
  const srv = spawnServer(t, dir);
  const code = await srv.exit();
  assert.notStrictEqual(code, 0, 'proces kończy się błędem');
  assert.match(srv.stderr(), /9999/, 'komunikat nazywa port, o który chodzi');
  assert.ok(!fs.existsSync(path.join(dir, 'server.json')),
    'nie zostaje server.json, który kłamałby o żywym serwerze');
});

test('GET /api/state niesie klucz projektu, stały w obrębie jednego doh/', async t => {
  const root = tmpDir();
  const doh = path.join(root, '.claude', 'doh');
  const mk = async ts => {
    const dir = path.join(doh, ts);
    fs.mkdirSync(dir, { recursive: true });
    const app = createApp(dir);
    const base = await listen(app);
    t.after(() => app.server.close());
    return (await getState(base)).project;
  };
  const a = await mk('20260918-100000');
  const b = await mk('20260918-110000');
  assert.ok(a && typeof a === 'string', 'klucz jest w odpowiedzi');
  assert.strictEqual(a, b, 'dwa runy tego samego projektu dzielą klucz');
  const other = createApp(tmpDir());
  const otherBase = await listen(other);
  t.after(() => other.server.close());
  assert.notStrictEqual((await getState(otherBase)).project, a, 'inny projekt, inny klucz');
  // Klucz nie jest ścieżką: w localStorage przeglądarki nie ma po co trzymać dysku.
  assert.ok(!a.includes(path.sep) && !a.includes('/'), 'klucz jest nieprzezroczysty');
});

test('an answer reaches the poll that asked for that task, not the catch-all parked first', async t => {
  // The orchestrator watches every task at once, so its poll carries no taskId and
  // matches anything. An agent waiting on its own question parks a second poll. Serving
  // whichever was parked first let the catch-all swallow an answer written for the task:
  // the agent waited out its whole timeout, re-polled into an empty queue, and stopped.
  // The user had watched the answer send, so nothing on screen said why it had stalled.
  const app = createApp(tmpDir());
  t.after(() => app.server.close());
  const base = await listen(app);
  const poll = query => fetch(`${base}/api/answer?${query}`).then(r => r.json()).then(j => j.answer);
  const settle = () => new Promise(r => setTimeout(r, 60));

  await post(base, '/api/tasks', { values: {} });
  const catchAll = poll('wait=5');
  await settle();
  const agent = poll('taskId=t1&wait=5');
  await settle();

  await post(base, '/api/answer', { taskId: 't1', text: 'use the shared service' });
  assert.strictEqual((await agent).text, 'use the shared service', 'the agent that asked gets the answer');

  // And the catch-all is still parked, free to take what no one claimed.
  await post(base, '/api/answer', { taskId: 't2', text: 'nobody is waiting on this one' });
  assert.strictEqual((await catchAll).text, 'nobody is waiting on this one');
});

test('the catch-all poll is still served when no task-specific one waits', async t => {
  const app = createApp(tmpDir());
  t.after(() => app.server.close());
  const base = await listen(app);
  const only = fetch(`${base}/api/answer?wait=5`).then(r => r.json()).then(j => j.answer);
  await new Promise(r => setTimeout(r, 60));
  await post(base, '/api/answer', { taskId: 't1', text: 'alone' });
  assert.strictEqual((await only).text, 'alone');
});


test('a chat line is timed, so a message written after a failure can be told from one before', async t => {
  // What the user writes to a step whose agent has already died is promised to the retry.
  // The orchestrator used to keep that promise from memory, and on a long run its memory is
  // summarised away long before the user gets round to clicking retry - the line would go
  // with it, while the log still said it had been kept. The transcript is the durable copy,
  // and the time is what says which side of the failure it fell on. Log entries have always
  // carried one; without one here the two could not be lined up at all.
  const app = createApp(tmpDir());
  t.after(() => app.server.close());
  const base = await listen(app);

  await postState(base, { step: 4, chat: { role: 'agent', text: 'starting the implementation' } });
  await postState(base, { step: 4, status: 'failed', logEntry: 'the step failed' });
  await post(base, '/api/answer', { taskId: 't1', kind: 'message', step: 4, text: 'skip the cache, do it synchronously' });

  const step = (await task0(base)).steps.find(x => x.id === 4);
  const failedAt = step.log.find(e => e.text === 'the step failed').time;
  assert.ok(failedAt, 'the failure is timed');
  assert.ok(step.chat.every(m => m.time), 'every chat line is timed');

  // Exactly the read the retry makes: the user lines later than the failure.
  const kept = step.chat.filter(m => m.role === 'user' && m.time > failedAt).map(m => m.text);
  assert.deepStrictEqual(kept, ['skip the cache, do it synchronously']);
  // And the agent line from before the failure is not dragged into the retry prompt.
  assert.ok(step.chat.some(m => m.text === 'starting the implementation' && m.time <= step.chat[1].time));
});


test('the E2E slot is the server\'s: one holder, a FIFO queue, handed on when step 5 ends', async t => {
  // Only one task may be inside step 5: Chrome, the extension and the dev port are
  // single-instance. Every task has an orchestrator of its own now, and none of them sees
  // what the others hold, so the slot lives here and moves on without being asked.
  const app = createApp(tmpDir());
  t.after(() => app.server.close());
  const base = await listen(app);
  const acquire = async id => (await post(base, '/api/e2e', { taskId: id })).json();
  await post(base, '/api/tasks', { values: {} });
  await post(base, '/api/tasks', { values: {} });
  assert.deepStrictEqual((await getState(base)).e2e, { holder: null, queue: [] }, 'a fresh run holds nothing');

  assert.deepStrictEqual(await acquire('t1'), { granted: true });
  assert.deepStrictEqual(await acquire('t1'), { granted: true }, 'asking again for the slot held is a yes');
  await postState(base, { step: 5, status: 'in_progress', activeStep: 5 });
  assert.deepStrictEqual(await acquire('t2'), { granted: false, holder: 't1', queue: ['t2'] });
  assert.deepStrictEqual(await acquire('t3'), { granted: false, holder: 't1', queue: ['t2', 't3'] });
  assert.deepStrictEqual((await acquire('t2')).queue, ['t2', 't3'], 'asking again keeps the place');
  let s = await getState(base);
  const five = id => s.tasks.find(x => x.id === id).steps.find(x => x.id === 5);
  assert.deepStrictEqual([five('t2').status, five('t2').currentOperation, s.tasks[1].activeStep],
    ['waiting', 'Waiting for the E2E slot', 5]);
  assert.deepStrictEqual(five('t2').log.map(e => e.text), ['Queued for the E2E slot'], 'logged once, however often it asks');

  // The failure protocol keeps it: a failed step 5 waits for its retry.
  await postState(base, { step: 5, status: 'failed' });
  assert.equal((await getState(base)).e2e.holder, 't1');

  await postState(base, { step: 5, status: 'completed' });
  s = await getState(base);
  assert.deepStrictEqual(s.e2e, { holder: 't2', queue: ['t3'] }, 'the oldest queued task goes next');
  assert.equal(five('t2').currentOperation, 'Took the E2E slot');
  const told = await (await fetch(`${base}/api/answer?taskId=t2`)).json();
  assert.deepStrictEqual(told.answer, { kind: 'e2e', taskId: 't2' }, 'and its orchestrator hears it');

  // A task that finishes - or is abandoned - while queued gives its place up, and the holder's
  // summary frees the slot.
  await post(base, '/api/state', { taskId: 't3', summary: { status: 'abandoned' } });
  assert.deepStrictEqual((await getState(base)).e2e, { holder: 't2', queue: [] });
  await post(base, '/api/state', { taskId: 't2', summary: { status: 'done' } });
  assert.deepStrictEqual((await getState(base)).e2e, { holder: null, queue: [] });
});

test('a run resumed from before the server kept the slot reads it off the steps', async t => {
  const dir = tmpDir();
  const first = createApp(dir);
  const base = await listen(first);
  await post(base, '/api/tasks', { values: {} });
  await post(base, '/api/tasks', { values: {} });
  await postState(base, { step: 5, status: 'in_progress' });
  const queue = id => post(base, '/api/state', { taskId: id, step: 5, status: 'waiting',
    currentOperation: 'Waiting for the E2E slot', logEntry: 'Queued for the E2E slot' });
  await queue('t3');
  await new Promise(r => setTimeout(r, 5));
  await queue('t2');
  await new Promise(r => first.server.close(r));
  const file = path.join(dir, 'pipeline-state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.e2e;
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.deepStrictEqual(createApp(dir).getState().e2e, { holder: 't1', queue: ['t3', 't2'] });
});

// --- Optional steps, review runs and the story ------------------------------------

test('the step-1 switches decide which of refinement, mockups and story the stepper shows', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const switched = async () => (await task0(base)).steps
    .filter(s => [2, 3, 8].includes(s.id)).map(s => [s.id, s.enabled]);
  // Refinement runs unless the form says otherwise: a form from before its switch ran it.
  await step1(base, {});
  assert.deepStrictEqual(await switched(), [[2, true], [3, false], [8, false]]);
  // A revision flips them back and forth: the switch, not the first answer, decides.
  await step1(base, { refinement: false, generateMockups: true, storyDescription: true });
  assert.deepStrictEqual(await switched(), [[2, false], [3, true], [8, true]]);
  const form = (await task0(base)).step1;
  assert.strictEqual(form.refinement, false);
  assert.strictEqual(form.generateMockups, true);
  assert.strictEqual(form.storyDescription, true);
});

test('the orchestrator gets the step-1 answer as stored, not as sent', async t => {
  // requirements.md is written from the answer, so the merge and the flag check have to
  // have happened by the time the orchestrator reads it.
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, { businessRequirements: 'Wymagania', codeReview: [{ flags: ['--light', '--bogus'] }] });
  const { answer } = await (await fetch(`${base}/api/answer`)).json();
  assert.strictEqual(answer.kind, 'step1');
  assert.strictEqual(answer.taskId, 't1');
  assert.strictEqual(answer.taskDescription, 'Opis\n\nWymagania');
  assert.strictEqual(answer.businessRequirements, undefined);
  assert.strictEqual(answer.refinement, true);
  assert.deepStrictEqual(answer.codeReview, [{ flags: ['--light'] }]);
});

test('review runs: one to three, only flags codeReview takes, the two passes when none are set', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, {});
  assert.deepStrictEqual((await task0(base)).step1.codeReview,
    [{ flags: [] }, { flags: ['--since-last'] }], 'no runs set is the default, never no review');
  await step1(base, { codeReview: [] });
  assert.strictEqual((await task0(base)).step1.codeReview.length, 2, 'an empty list too');
  await step1(base, { codeReview: [
    // --project is the pipeline's own, a made-up flag would reach codeReview as a branch.
    { flags: ['--light', '--made-up', '--project', '--project=x'] },
    // Kept in the skill's own order, whatever order the page sent.
    { flags: ['--since-last', '--only-md'] },
    {},
    { flags: ['--light'] }] });
  assert.deepStrictEqual((await task0(base)).step1.codeReview, [
    { flags: ['--light'] }, { flags: ['--only-md', '--since-last'] }, { flags: [] }]);
});

test('GET /api/review-flags lists the switches codeReview takes, read from its SKILL.md', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/review-flags`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  const names = body.flags.map(f => f.name);
  for (const flag of ['--only-md', '--since-last', '--light', '--with-checklist']) {
    assert.ok(names.includes(flag), `${flag} in ${names}`);
  }
  assert.ok(!names.includes('--project'), 'the one flag with a value is the pipeline\'s own');
  assert.strictEqual(new Set(names).size, names.length, 'each flag once');
  for (const f of body.flags) assert.ok(f.description.trim().length > 10, `${f.name} has a description`);
  assert.deepStrictEqual(body.defaultRuns, [{ flags: [] }, { flags: ['--since-last'] }]);
  assert.strictEqual(body.maxRuns, 3);
});

test('GET /api/story serves the task story as plain text, 404 before it is written', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.strictEqual((await fetch(`${base}/api/story?taskId=t1`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/story?taskId=t9`)).status, 404);
  const story = '## Description\n\nAs an admin, I want to <b>invite</b> users.\n\n## Acceptance criteria\n\n1. The "Zaproś" button sends the invitation.\n';
  fs.mkdirSync(path.join(dir, 'tasks', 't1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks', 't1', 'story.md'), story, 'utf8');
  const res = await fetch(`${base}/api/story?taskId=t1`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/, 'markup in a story is shown, never rendered');
  assert.strictEqual(res.headers.get('cache-control'), 'no-store', 'a rewritten story shows up');
  assert.strictEqual(await res.text(), story);
});

test('a run resumed from a seven-step state gets the story step, and its form the merged description', async t => {
  const dir = tmpDir();
  const old = { tasks: [{ id: 't1', branch: 'feature/x', root: null, activeStep: 4,
    steps: [1, 2, 3, 4, 5, 6, 7].map(id => ({ id, name: `S${id}`, status: 'waiting',
      progress: null, enabled: id !== 3, currentOperation: '', report: null, log: [], chat: [] })),
    question: null, questionSeq: 0, mockupSeq: 0, reviewSeq: 0, reviewSummary: null,
    mockupReview: null, summary: null, step1Submitted: true, authSaved: false,
    step1: { taskDescription: 'Opis', businessRequirements: 'Wymagania', branch: 'feature/x' } }],
  nextTaskId: 2 };
  fs.writeFileSync(path.join(dir, 'pipeline-state.json'), JSON.stringify(old));
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const task = await task0(base);
  assert.deepStrictEqual(task.steps.map(s => s.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // Started before the final review existed: it keeps validation before its one review.
  assert.deepStrictEqual(task.route, [1, 2, 3, 8, 4, 5, 6]);
  assert.strictEqual(task.steps.find(s => s.id === 9).enabled, false, 'a legacy task never runs the final review');
  const story = task.steps.find(s => s.id === 8);
  assert.strictEqual(story.name, 'Story Description');
  assert.strictEqual(story.enabled, false, 'an old form never asked for a story');
  assert.deepStrictEqual(story.chat, []);
  assert.strictEqual(task.step1.taskDescription, 'Opis\n\nWymagania');
  assert.strictEqual(task.step1.businessRequirements, undefined);
  assert.strictEqual(task.step1.refinement, true, 'an old form ran the refinement');
  assert.deepStrictEqual(task.step1.codeReview, [{ flags: [] }, { flags: ['--since-last'] }]);
  const res = await postState(base, { step: 8, status: 'in_progress', activeStep: 8 });
  assert.strictEqual(res.status, 200, 'the appended step takes updates like any other');
});

const stepOf = (task, id) => task.steps.find(s => s.id === id);
const nextAnswer = async base => (await (await fetch(`${base}/api/answer`)).json()).answer;

test('a resubmitted form names what changed and repeats only the steps that read it', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, { generateMockups: true });
  assert.strictEqual((await nextAnswer(base)).revision, undefined, 'the first form is no revision');
  await postState(base, { step: 2, status: 'completed' });
  await postState(base, { step: 3, status: 'in_progress', activeStep: 3, progress: 40,
    currentOperation: 'Waiting for your review', mockupReview: { text: 'Round 1', screens: [] } });
  // A setting alone repeats nothing: the gate the user left stays where it was.
  let body = await (await step1(base, { generateMockups: true, codeReview: [{ flags: [] }] })).json();
  assert.deepStrictEqual(body.revision.changed, ['codeReview']);
  assert.strictEqual(body.revision.restartAt, null);
  let task = await task0(base);
  assert.strictEqual(task.activeStep, 3);
  assert.ok(task.mockupReview, 'the mockup gate is still open');
  assert.deepStrictEqual((await nextAnswer(base)).revision, body.revision, 'the orchestrator gets the same revision');
  // The branch is read by nothing before implementation.
  body = await (await step1(base, { generateMockups: true, codeReview: [{ flags: [] }], branch: 'feature/y' })).json();
  assert.deepStrictEqual(body.revision.changed, ['branch']);
  assert.strictEqual(body.revision.restartAt, null);
  assert.strictEqual((await task0(base)).branch, 'feature/y');
  // The description is read from the refinement on: it repeats, and every step after it
  // waits again - at once, before the orchestrator has read the answer.
  body = await (await step1(base, { generateMockups: true, codeReview: [{ flags: [] }],
    branch: 'feature/y', taskDescription: 'Nowy opis' })).json();
  assert.deepStrictEqual(body.revision.changed, ['description']);
  assert.strictEqual(body.revision.restartAt, 2);
  task = await task0(base);
  assert.strictEqual(task.activeStep, 2);
  assert.strictEqual(stepOf(task, 2).status, 'in_progress');
  assert.strictEqual(stepOf(task, 3).status, 'waiting');
  assert.strictEqual(stepOf(task, 3).progress, null);
  assert.strictEqual(task.mockupReview, null, 'the old round is off the screen');
  assert.match(stepOf(task, 2).log.at(-1).text, /description/);
});

test('a step switched on or off repeats what it feeds, and the step the run sits on hands over', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, { refinement: false, storyDescription: true });
  await postState(base, { step: 8, status: 'in_progress', activeStep: 8 });
  // Refinement comes before the story, which already ran without it.
  let body = await (await step1(base, { refinement: true, storyDescription: true })).json();
  assert.deepStrictEqual(body.revision.switchedOn, [2]);
  assert.deepStrictEqual(body.revision.changed, ['steps']);
  assert.strictEqual(body.revision.restartAt, 2);
  let task = await task0(base);
  assert.deepStrictEqual([stepOf(task, 2).status, stepOf(task, 8).status], ['in_progress', 'waiting']);
  // Switched off while it runs: the next step of the route takes over.
  body = await (await step1(base, { refinement: false, storyDescription: true })).json();
  assert.deepStrictEqual(body.revision.switchedOff, [2]);
  assert.strictEqual(body.revision.restartAt, 8);
  task = await task0(base);
  assert.deepStrictEqual([stepOf(task, 2).status, stepOf(task, 2).enabled], ['waiting', false]);
  assert.strictEqual(stepOf(task, 8).status, 'in_progress');
  // The last step before implementation switched off: implementation starts.
  body = await (await step1(base, { refinement: false, storyDescription: false })).json();
  assert.strictEqual(body.revision.restartAt, 4);
  task = await task0(base);
  assert.strictEqual(task.activeStep, 4);
  assert.strictEqual(stepOf(task, 4).status, 'in_progress');
  // From here on only the settings move.
  const res = await step1(base, { refinement: false, storyDescription: false, taskDescription: 'Inny' });
  assert.strictEqual(res.status, 409);
  assert.match((await res.json()).error, /description/);
  assert.strictEqual((await task0(base)).step1.taskDescription, 'Opis', 'a refused form changes nothing');
  body = await (await step1(base, { refinement: false, storyDescription: false,
    agents: { effort: 'high' } })).json();
  assert.deepStrictEqual(body.revision.changed, ['agents']);
  assert.strictEqual((await post(base, '/api/upload', { taskId: 't1', category: 'hints',
    filename: 'a.png', dataBase64: 'eA==' })).status, 409, 'nor can its files');
  assert.strictEqual((await post(base, '/api/upload/remove', { taskId: 't1', category: 'hints',
    filename: 'a.png' })).status, 409);
  await postState(base, { summary: { text: 'Done' } });
  assert.strictEqual((await step1(base, { refinement: false, storyDescription: false,
    agents: { effort: 'low' } })).status, 409, 'a finished task takes no form at all');
});

test('approved mockups switched off send the refinement round again', async t => {
  // Their approval wrote the ## UI design section into the refinement's files.
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, { generateMockups: true, storyDescription: true });
  await postState(base, { step: 2, status: 'completed' });
  await postState(base, { step: 3, status: 'completed' });
  await postState(base, { step: 8, status: 'in_progress', activeStep: 8 });
  const body = await (await step1(base, { generateMockups: false, storyDescription: true })).json();
  assert.strictEqual(body.revision.restartAt, 2);
  const task = await task0(base);
  assert.deepStrictEqual([2, 3, 8].map(id => stepOf(task, id).status), ['in_progress', 'waiting', 'waiting']);
});

test('a file counts as changed only when its bytes moved, a removal included', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const upload = data => post(base, '/api/upload', { taskId: 't1', category: 'hints',
    filename: 'a.png', dataBase64: Buffer.from(data).toString('base64') });
  await upload('x');
  await step1(base, { hints: ['a.png'] });
  await upload('x');
  let body = await (await step1(base, { hints: ['a.png'] })).json();
  assert.deepStrictEqual([body.revision.changed, body.revision.files], [[], []], 'the same file again');
  await upload('y');
  body = await (await step1(base, { hints: ['a.png'] })).json();
  assert.deepStrictEqual(body.revision.files, [{ category: 'hints', name: 'a.png', change: 'replaced' }]);
  assert.deepStrictEqual(body.revision.changed, ['materials']);
  await post(base, '/api/upload/remove', { taskId: 't1', category: 'hints', filename: 'a.png' });
  body = await (await step1(base, { hints: [] })).json();
  assert.deepStrictEqual(body.revision.files, [{ category: 'hints', name: 'a.png', change: 'removed' }]);
  // Credentials sent again unchanged are no change; new ones are, and only as a flag.
  await post(base, '/api/auth', { taskId: 't1', login: 'u', password: 'p' });
  body = await (await step1(base, { authProvided: true })).json();
  assert.ok(body.revision.changed.includes('authorization'));
  await post(base, '/api/auth', { taskId: 't1', login: 'u', password: 'p' });
  body = await (await step1(base, { authProvided: true })).json();
  assert.deepStrictEqual(body.revision.changed, []);
  await post(base, '/api/auth', { taskId: 't1', login: 'u', password: 'q' });
  body = await (await step1(base, { authProvided: true })).json();
  assert.deepStrictEqual(body.revision.changed, ['authorization']);
  assert.ok(!JSON.stringify(body).includes('"q"'), 'the password never travels back');
});

test('Stop interrupts a running step and leaves everything else as it was', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const stop = step => post(base, '/api/answer', { taskId: 't1', kind: 'stop', step });
  await postState(base, { step: 2, status: 'in_progress', activeStep: 2, progress: 40,
    currentOperation: 'Asking', question: { id: 'q1', text: 'Which one?' } });
  assert.strictEqual((await stop(2)).status, 200);
  const task = await task0(base);
  const step = stepOf(task, 2);
  assert.deepStrictEqual([step.status, step.progress, step.currentOperation, step.report],
    ['in_progress', 40, 'Asking', null], 'the step is where it was');
  assert.ok(step.stopped, 'only the flag says it was stopped');
  assert.strictEqual(step.log.at(-1).text, 'Stopped by the user');
  assert.deepStrictEqual(task.question, { id: 'q1', text: 'Which one?' }, 'the question stays open');
  assert.deepStrictEqual(await nextAnswer(base), { kind: 'stop', step: 2, taskId: 't1' });
  assert.strictEqual((await stop(2)).status, 409, 'a stopped step cannot be stopped again');
  // The agent may still report progress in the seconds before it is stopped.
  await postState(base, { step: 2, status: 'in_progress', progress: 45 });
  assert.ok(stepOf(await task0(base), 2).stopped, 'a progress post does not undo the Stop');
  // What the user sends next is what resumes the agent, and the answer says so - once.
  await post(base, '/api/answer', { taskId: 't1', kind: 'answer', questionId: 'q1', value: 'B' });
  assert.deepStrictEqual(await nextAnswer(base),
    { kind: 'answer', questionId: 'q1', value: 'B', taskId: 't1', afterStop: true });
  assert.ok(!stepOf(await task0(base), 2).stopped);
  await post(base, '/api/answer', { taskId: 't1', kind: 'answer', questionId: 'q1', value: 'C',
    afterStop: true });
  assert.ok(!('afterStop' in await nextAnswer(base)), 'only the server says it came after a Stop');
  await postState(base, { step: 2, status: 'completed' });
  assert.strictEqual((await stop(2)).status, 409, 'a step that is not running cannot be stopped');
  assert.strictEqual((await stop(1)).status, 400);
});

test('a Stop ends with what the user sends that step, with a gate, or with the step moving on', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const stop = async step => {
    assert.strictEqual((await post(base, '/api/answer', { taskId: 't1', kind: 'stop', step })).status, 200);
    await nextAnswer(base);
  };
  await postState(base, { step: 4, status: 'in_progress', activeStep: 4 });
  await stop(4);
  await post(base, '/api/answer', { taskId: 't1', kind: 'message', step: 5, text: 'Inny krok' });
  assert.ok(!('afterStop' in await nextAnswer(base)), 'a line for another step resumes nothing');
  assert.ok(stepOf(await task0(base), 4).stopped);
  await post(base, '/api/answer', { taskId: 't1', kind: 'message', step: 4, text: 'Dalej' });
  assert.strictEqual((await nextAnswer(base)).afterStop, true);
  assert.ok(!stepOf(await task0(base), 4).stopped);
  await stop(4);
  await postState(base, { step: 4, status: 'failed', report: 'Broke' });
  assert.ok(!stepOf(await task0(base), 4).stopped, 'a failed step has nothing left to resume');
  // Mockup feedback is step 3's, and a new round means the agent had finished anyway.
  await postState(base, { step: 3, enabled: true, status: 'in_progress', activeStep: 3 });
  await stop(3);
  await post(base, '/api/answer', { taskId: 't1', kind: 'mockup', decision: 'feedback', text: 'Ciemniej' });
  assert.strictEqual((await nextAnswer(base)).afterStop, true);
  await stop(3);
  await postState(base, { step: 3, mockupReview: { text: 'Runda', screens: [] } });
  assert.ok(!stepOf(await task0(base), 3).stopped, 'a new round lost no race to the Stop');
});

test('attachments: images only, never overwritten, names in the transcript and paths for the agent', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const attach = filename => post(base, '/api/upload', { taskId: 't1', category: 'attachments',
    filename, dataBase64: Buffer.from(filename).toString('base64') });
  assert.strictEqual((await (await attach('shot.png')).json()).name, '1-shot.png');
  assert.strictEqual((await (await attach('shot.png')).json()).name, '2-shot.png');
  assert.strictEqual((await attach('notes.txt')).status, 400);
  await post(base, '/api/answer', { taskId: 't1', kind: 'message', step: 3, text: 'Zobacz',
    attachments: ['1-shot.png', '2-shot.png', 'nope.png', '../auth.json'] });
  const line = stepOf(await task0(base), 3).chat.at(-1);
  assert.deepStrictEqual(line.attachments, ['1-shot.png', '2-shot.png']);
  const answer = await nextAnswer(base);
  assert.deepStrictEqual(answer.attachments, ['1-shot.png', '2-shot.png']
    .map(n => path.join(dir, 'tasks', 't1', 'attachments', n)));
  await post(base, '/api/answer', { taskId: 't1', kind: 'decision', decision: 'feedback', text: 'Popraw',
    attachments: ['1-shot.png'] });
  assert.strictEqual((await nextAnswer(base)).attachments.length, 1, 'plan feedback carries them too');
  await post(base, '/api/answer', { taskId: 't1', kind: 'message', step: 3, text: 'Bez' });
  assert.ok(!('attachments' in stepOf(await task0(base), 3).chat.at(-1)));
  assert.ok(!('attachments' in await nextAnswer(base)));
});

test('description images: pictures only, kept with the form, and a new one repeats the flow', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const upload = filename => post(base, '/api/upload', { taskId: 't1', category: 'images',
    filename, dataBase64: Buffer.from(filename).toString('base64') });
  assert.strictEqual((await upload('notes.txt')).status, 400);
  assert.strictEqual((await (await upload('flow.png')).json()).name, 'flow.png');
  assert.ok(fs.existsSync(path.join(dir, 'tasks', 't1', 'images', 'flow.png')));
  await step1(base, { images: ['flow.png', 'notes.txt'] });
  assert.deepStrictEqual((await task0(base)).step1.images, ['flow.png'], 'the description keeps pictures only');
  await nextAnswer(base);
  await postState(base, { step: 2, status: 'in_progress', activeStep: 2 });
  await upload('sketch.jpg');
  const body = await (await step1(base, { images: ['flow.png', 'sketch.jpg'] })).json();
  assert.deepStrictEqual(body.revision.changed, ['description'], 'a picture is part of the description');
  assert.deepStrictEqual(body.revision.files, [{ category: 'images', name: 'sketch.jpg', change: 'added' }]);
  assert.strictEqual(body.revision.restartAt, 2);
  // Every agent reads the pictures from the task dir, so a copied task takes them along.
  const { id } = await (await post(base, '/api/tasks', { copyFrom: 't1',
    values: { taskDescription: 'Opis' } })).json();
  assert.deepStrictEqual((await getState(base)).tasks[1].step1.images, ['flow.png', 'sketch.jpg']);
  assert.ok(fs.existsSync(path.join(dir, 'tasks', id, 'images', 'sketch.jpg')));
});

test('Stop on the story gate keeps the gate, and the approval says it came after a Stop', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 8, enabled: true, status: 'in_progress', activeStep: 8,
    reviewSummary: { text: 'Five criteria' } });
  assert.strictEqual((await post(base, '/api/answer', { taskId: 't1', kind: 'stop', step: 8 })).status, 200);
  const task = await task0(base);
  assert.strictEqual(stepOf(task, 8).status, 'in_progress');
  assert.strictEqual(task.reviewSummary.text, 'Five criteria', 'the gate stays open');
  await nextAnswer(base);
  await post(base, '/api/answer', { taskId: 't1', kind: 'decision', decision: 'approve' });
  assert.deepStrictEqual(await nextAnswer(base),
    { taskId: 't1', kind: 'decision', decision: 'approve', afterStop: true });
});

test('the user deletes a line of their own by id: it leaves the transcript and the orchestrator hears of it', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 4, status: 'in_progress', activeStep: 4 });
  await post(base, '/api/upload', { taskId: 't1', category: 'attachments', filename: 'a.png',
    dataBase64: Buffer.from('png').toString('base64') });
  await post(base, '/api/answer', { taskId: 't1', kind: 'message', step: 4, text: 'Dodaj eksport',
    attachments: ['1-a.png'] });
  await postState(base, { step: 4, chat: { role: 'agent', text: 'Robię eksport' } });
  await post(base, '/api/answer', { taskId: 't1', kind: 'message', step: 4, text: 'I import' });
  await nextAnswer(base);
  await nextAnswer(base);
  assert.deepStrictEqual(stepOf(await task0(base), 4).chat.map(m => m.id), [1, 2, 3]);
  const del = id => post(base, '/api/answer', { taskId: 't1', kind: 'delete', step: 4, id });
  assert.strictEqual((await del(2)).status, 404, "the agent's own line stays");
  assert.strictEqual((await del(9)).status, 404);
  assert.strictEqual((await del(1)).status, 200);
  assert.deepStrictEqual(stepOf(await task0(base), 4).chat.map(m => m.id), [2, 3]);
  assert.deepStrictEqual(await nextAnswer(base), { kind: 'delete', step: 4, id: 1, text: 'Dodaj eksport',
    attachments: [path.join(dir, 'tasks', 't1', 'attachments', '1-a.png')], taskId: 't1' });
  assert.strictEqual((await del(1)).status, 404, 'a line goes once');
  await postState(base, { step: 4, chat: { role: 'agent', text: 'Bez eksportu' } });
  assert.strictEqual(stepOf(await task0(base), 4).chat.at(-1).id, 4, 'a number is never reused');
  // A stopped agent hears of it as stopped, and stays stopped.
  await post(base, '/api/answer', { taskId: 't1', kind: 'stop', step: 4 });
  await nextAnswer(base);
  await del(3);
  assert.strictEqual((await nextAnswer(base)).afterStop, true);
  assert.ok(stepOf(await task0(base), 4).stopped);
});

test('a transcript resumed from before lines had ids gets them, in order', async t => {
  const dir = tmpDir();
  const first = createApp(dir);
  const firstBase = await listen(first);
  await postState(firstBase, { step: 4, chat: { role: 'agent', text: 'a' } });
  await postState(firstBase, { step: 4, chat: { role: 'user', text: 'b' } });
  await new Promise(r => first.server.close(r));
  const file = path.join(dir, 'pipeline-state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const old = stepOf(saved.tasks[0], 4);
  for (const m of old.chat) delete m.id;
  delete old.chatSeq;
  fs.writeFileSync(file, JSON.stringify(saved));
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 4, chat: { role: 'agent', text: 'c' } });
  assert.deepStrictEqual(stepOf(await task0(base), 4).chat.map(m => [m.id, m.text]),
    [[1, 'a'], [2, 'b'], [3, 'c']]);
});

test('GET /uploads serves the task images for thumbnails, and nothing else', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/upload', { taskId: 't1', category: 'mockups', filename: 'm.png',
    dataBase64: Buffer.from('png').toString('base64') });
  await post(base, '/api/upload', { taskId: 't1', category: 'contracts', filename: 'api.yaml',
    dataBase64: Buffer.from('openapi').toString('base64') });
  await post(base, '/api/auth', { taskId: 't1', login: 'u', password: 'p' });
  const res = await fetch(`${base}/uploads/t1/mockups/m.png`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.strictEqual(await res.text(), 'png');
  for (const p of ['t1/mockups/..%2Fauth.json', 't1/contracts/api.yaml', 't9/mockups/m.png',
    't1/secrets/m.png', 't1/mockups/missing.png', 't1/auth.json']) {
    assert.strictEqual((await fetch(`${base}/uploads/${p}`)).status, 404, p);
  }
});

test('POST /api/open-folder opens the screenshots folder once it holds something', async t => {
  const dir = tmpDir();
  const opened = [];
  const app = createApp(dir, { openFolder: d => opened.push(d) });
  const base = await listen(app);
  t.after(() => app.server.close());
  const open = folder => post(base, '/api/open-folder', { taskId: 't1', folder });
  assert.strictEqual((await open('mockup-screenshots')).status, 404);
  const shots = path.join(dir, 'tasks', 't1', 'mockup-screenshots');
  fs.mkdirSync(shots, { recursive: true });
  fs.writeFileSync(path.join(shots, '1.0 Login - Empty.png'), 'png');
  const res = await open('mockup-screenshots');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(opened, [shots]);
  assert.strictEqual((await open('generated-mockups')).status, 400, 'only the folders the page may open');
  assert.strictEqual((await open('..')).status, 400);
});

test('an answer to the open question takes it down at once, logs it, and still goes to the orchestrator', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 2, status: 'in_progress', activeStep: 2, currentOperation: 'Asking',
    question: { id: 'q1', text: 'Which one?', options: ['A', 'B'] } });
  const seq = (await task0(base)).questionSeq;
  // An answer to a question already replaced takes nothing down - it is still forwarded.
  await post(base, '/api/answer', { taskId: 't1', kind: 'answer', questionId: 'q0', value: 'A' });
  assert.strictEqual((await task0(base)).question.id, 'q1');
  assert.strictEqual((await nextAnswer(base)).questionId, 'q0');
  await post(base, '/api/answer', { taskId: 't1', kind: 'answer', questionId: 'q1',
    value: `B, because${' really'.repeat(40)}` });
  const task = await task0(base);
  assert.strictEqual(task.question, null, 'the page drops the question without waiting for the agent');
  assert.strictEqual(task.questionSeq, seq + 1);
  const step = stepOf(task, 2);
  assert.strictEqual(step.currentOperation, 'Processing answer…');
  assert.match(step.log.at(-1).text, /^q1: B, because really/);
  assert.ok(step.log.at(-1).text.length <= 124 && step.log.at(-1).text.endsWith('…'), 'one short line');
  assert.strictEqual((await nextAnswer(base)).questionId, 'q1');
});

test('plan feedback hides the gate until the next round or a reopen; Approve takes it down', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 2, status: 'in_progress', activeStep: 2,
    reviewSummary: { text: 'Plan v1', critical: ['Angular 20 + jest 15'] } });
  await post(base, '/api/answer', { taskId: 't1', kind: 'decision', decision: 'feedback', text: 'Krócej' });
  let task = await task0(base);
  assert.ok(task.reviewSummary.answered, 'the gate stays in the state, marked answered');
  assert.deepStrictEqual(task.reviewSummary.critical, ['Angular 20 + jest 15']);
  assert.deepStrictEqual(said(stepOf(task, 2).chat), [{ role: 'user', text: 'Krócej' }],
    'the feedback is in the transcript the progress view shows');
  assert.strictEqual(stepOf(task, 2).currentOperation, 'Reworking the plan…');
  assert.strictEqual((await nextAnswer(base)).text, 'Krócej');
  // The agent only noted it: the orchestrator hands the same gate back.
  assert.strictEqual((await postState(base, { step: 2, currentOperation: 'Waiting for you', reopenGate: true })).status, 200);
  task = await task0(base);
  assert.ok(!('answered' in task.reviewSummary));
  assert.strictEqual(task.reviewSummary.rev, 1);
  await post(base, '/api/answer', { taskId: 't1', kind: 'decision', decision: 'feedback', text: 'Jeszcze' });
  await nextAnswer(base);
  // A new round is a new gate, open again.
  await postState(base, { step: 2, reviewSummary: { text: 'Plan v2', critical: [] } });
  task = await task0(base);
  assert.ok(!('answered' in task.reviewSummary));
  assert.strictEqual(task.reviewSummary.rev, 2);
  await post(base, '/api/answer', { taskId: 't1', kind: 'decision', decision: 'approve' });
  task = await task0(base);
  assert.strictEqual(task.reviewSummary, null);
  assert.strictEqual(stepOf(task, 2).log.at(-1).text, 'The plan was approved');
  assert.strictEqual((await nextAnswer(base)).decision, 'approve', 'the orchestrator still gets the decision');
});

test('story feedback says it is the story being reworked', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 8, enabled: true, status: 'in_progress', activeStep: 8,
    reviewSummary: { text: 'Story ready' } });
  await post(base, '/api/answer', { taskId: 't1', kind: 'decision', decision: 'feedback', text: 'Dodaj AC' });
  assert.strictEqual(stepOf(await task0(base), 8).currentOperation, 'Reworking the story…');
});

test('mockup feedback hides the mockups until the next round; Approve takes them down', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 3, enabled: true, status: 'in_progress', activeStep: 3,
    mockupReview: { text: 'Two screens', screens: [] } });
  await post(base, '/api/answer', { taskId: 't1', kind: 'mockup', decision: 'feedback', text: 'Ciemniej' });
  let task = await task0(base);
  assert.ok(task.mockupReview.answered);
  assert.strictEqual(stepOf(task, 3).currentOperation, 'Reworking the mockups…');
  await postState(base, { step: 3, reopenGate: true });
  assert.ok(!('answered' in (await task0(base)).mockupReview));
  await post(base, '/api/answer', { taskId: 't1', kind: 'mockup', decision: 'approve' });
  task = await task0(base);
  assert.strictEqual(task.mockupReview, null);
  assert.strictEqual(stepOf(task, 3).currentOperation, 'Approved — updating spec, plan and checklist…');
});

test('Retry takes the failure off the step at once; Finish leaves it for the summary', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 4, status: 'failed', activeStep: 4, report: 'Build broke' });
  await post(base, '/api/answer', { taskId: 't1', kind: 'decision', decision: 'finish' });
  assert.strictEqual(stepOf(await task0(base), 4).status, 'failed');
  assert.strictEqual((await nextAnswer(base)).decision, 'finish');
  await post(base, '/api/answer', { taskId: 't1', kind: 'decision', decision: 'retry' });
  const step = stepOf(await task0(base), 4);
  assert.deepStrictEqual([step.status, step.report, step.currentOperation],
    ['in_progress', null, 'Retrying the step…']);
  assert.strictEqual((await nextAnswer(base)).decision, 'retry');
});

test('GET /api/state carries each task\'s usage, read from its own orchestrator\'s session', async t => {
  const app = createApp(tmpDir(), { starterSession: 's1',
    readUsage: session => ({ relay: true, model: `m-${session}` }) });
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/tasks', { values: {} });
  await post(base, '/api/tasks', { values: {} });
  await fetch(`${base}/api/answer?taskId=t3&session=s3`);
  assert.deepStrictEqual((await getState(base)).usage,
    { t1: { relay: true, model: 'm-s1' }, t3: { relay: true, model: 'm-s3' } }, 't2 has no session yet');
});

// --- One orchestrator per task -----------------------------------------------------

test('pierwszy task należy do sesji, która uruchomiła serwer; inna dostaje 409, póki tamta żyje', async t => {
  const app = createApp(tmpDir(), { starterSession: 'starter' });
  const base = await listen(app);
  t.after(() => app.server.close());
  const s = await getState(base);
  assert.equal(s.tasks[0].orchestrator.session, 'starter');
  assert.deepStrictEqual(s.orchestrators.t1, { status: 'working', session: 'starter', launchError: null });
  const other = await fetch(`${base}/api/answer?taskId=t1&session=intruder`);
  assert.equal(other.status, 409);
  assert.deepStrictEqual(await other.json(), { error: 'task t1 has an orchestrator of its own', session: 'starter' });
  assert.deepStrictEqual(await (await fetch(`${base}/api/answer?taskId=t1&session=starter`)).json(), { answer: null });
});

test('zaparkowany poll to listening, zerwany w trakcie to closed, i wtedy task przejmuje inna sesja', async t => {
  const app = createApp(tmpDir(), { starterSession: 'a' });
  const base = await listen(app);
  t.after(() => app.server.close());
  const status = async () => (await getState(base)).orchestrators.t1.status;
  const ctl = new AbortController();
  const parked = fetch(`${base}/api/answer?taskId=t1&session=a&wait=30`, { signal: ctl.signal }).catch(() => null);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await status(), 'listening');
  ctl.abort();
  await parked;
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await status(), 'closed', 'a waiter cut off mid-wait went with its session');
  assert.equal((await fetch(`${base}/api/answer?taskId=t1&session=b`)).status, 200);
  const s = await getState(base);
  assert.deepStrictEqual([s.orchestrators.t1.status, s.tasks[0].orchestrator.session], ['working', 'b']);
  assert.equal((await fetch(`${base}/api/answer?taskId=t1&session=a`)).status, 409, 'and the old one, back, is refused');
});

test('pierwszy formularz nowego taska otwiera mu własnego orkiestratora; t1 i rewizja - nie', async t => {
  const launches = [];
  const app = createApp(tmpDir(), { starterSession: 'starter', project: 'D:/proj',
    launchOrchestrator: async spec => { launches.push(spec); return { launched: true, command: 'c', cwd: spec.project }; } });
  const base = await listen(app);
  t.after(() => app.server.close());
  const step1 = taskId => post(base, '/api/answer', { taskId, kind: 'step1', taskDescription: 'x',
    branch: `feature/${taskId}`, mockups: [], contracts: [], hints: [], authProvided: false });
  await step1('t1');
  await post(base, '/api/tasks', { values: {} });
  await step1('t2');
  await new Promise(r => setTimeout(r, 20));
  assert.deepStrictEqual(launches, [{ project: path.resolve('D:/proj'), taskId: 't2', port: app.server.address().port }]);
  let s = await getState(base);
  assert.deepStrictEqual(s.orchestrators.t2, { status: 'starting', session: null, launchError: null });
  await step1('t2');
  assert.equal(launches.length, 1, 'a revised form opens nothing more');
  // The form waits in the queue for the new session, and its first poll claims the task.
  const first = await (await fetch(`${base}/api/answer?taskId=t2&session=n2`)).json();
  assert.equal(first.answer.kind, 'step1');
  s = await getState(base);
  assert.deepStrictEqual([s.orchestrators.t2.status, s.orchestrators.t2.session], ['working', 'n2']);
});

test('katalog projektu nie jest rootem żadnego taska, choćby jedynego: każdy pracuje w swoim worktree', async t => {
  const project = path.join(tmpDir(), 'proj');
  fs.mkdirSync(project, { recursive: true });
  const app = createApp(tmpDir(), { project });
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/tasks', { values: {} });
  const spelled = process.platform === 'win32' ? `${project.toUpperCase()}\\` : `${project}/`;
  for (const root of [project, spelled]) {
    const refused = await postState(base, { root });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /is the project's checkout - every task works in a worktree of its own/);
  }
  assert.equal((await getState(base)).tasks[0].root, null, 'a refused body changes nothing');
  assert.equal((await postState(base, { root: `${project}-worktrees/a-t1` })).status, 200);
});

test('root innego taska to 409, choćby inaczej zapisany', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const project = path.join(tmpDir(), 'proj');
  await post(base, '/api/tasks', { values: {} });
  assert.equal((await postState(base, { root: project })).status, 200);
  assert.equal((await postState(base, { root: project })).status, 200, 'its own root again is no conflict');
  const spelled = process.platform === 'win32' ? `${project.toUpperCase()}\\` : `${project}/`;
  const taken = await post(base, '/api/state', { taskId: 't2', root: spelled, branch: 'feature/b' });
  assert.equal(taken.status, 409);
  assert.match((await taken.json()).error, /is task t1's$/);
  const s = await getState(base);
  assert.deepStrictEqual([s.tasks[1].root, s.tasks[1].branch], [null, ''], 'a refused body changes nothing');
  assert.equal((await post(base, '/api/state', { taskId: 't2', root: `${project}-worktrees/b-t2` })).status, 200);
});

test('Open: terminal dla taska bez żywego orkiestratora, 409 dla żywego, a porażka mówi, co wpisać', async t => {
  let result = { launched: false, command: 'claude "x"', cwd: 'D:/proj', error: 'spawn cmd.exe ENOENT' };
  const app = createApp(tmpDir(), { starterSession: 'starter', launchOrchestrator: async () => result });
  const base = await listen(app);
  t.after(() => app.server.close());
  const open = id => post(base, '/api/orchestrator/launch', { taskId: id });
  await post(base, '/api/tasks', { values: {} });
  assert.deepStrictEqual(await (await open('t2')).json(), result);
  assert.deepStrictEqual((await getState(base)).orchestrators.t2,
    { status: 'closed', session: null, launchError: 'spawn cmd.exe ENOENT' });
  result = { launched: true, command: 'claude "x"', cwd: 'D:/proj' };
  assert.equal((await (await open('t2')).json()).launched, true);
  assert.deepStrictEqual((await getState(base)).orchestrators.t2, { status: 'starting', session: null, launchError: null });
  assert.equal((await open('t1')).status, 409);
  assert.equal((await open('t9')).status, 400);
});

test('serwer bez launchera podaje komendę do ręcznego wpisania, a GET /api/orchestrator - gdzie jest run', async t => {
  const dir = tmpDir();
  const app = createApp(dir, { starterSession: null, project: 'D:/proj' });
  const base = await listen(app);
  t.after(() => app.server.close());
  const port = app.server.address().port;
  const command = `claude "/doh:implementNewFeature --attach t1 --port ${port}"`;
  assert.deepStrictEqual(await (await post(base, '/api/orchestrator/launch', { taskId: 't1' })).json(),
    { launched: false, command, cwd: path.resolve('D:/proj'), error: 'this server opens no terminals' });
  assert.deepStrictEqual(await (await fetch(`${base}/api/orchestrator?taskId=t1`)).json(), { taskId: 't1',
    sessionDir: path.resolve(dir), projectDir: path.resolve('D:/proj'), port, command,
    status: 'none', session: null, launchError: null });
  assert.equal((await fetch(`${base}/api/orchestrator?taskId=t7`)).status, 400);
});

test('żądanie, które inna strona kazała wysłać przeglądarce, jest odrzucane; strona, curl i waiter przechodzą', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const port = app.server.address().port;
  const send = (method, p, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', reject);
    r.end(method === 'POST' ? '{}' : undefined);
  });
  assert.equal(await send('GET', '/api/state'), 200, 'curl and the waiter send no Origin');
  assert.equal(await send('POST', '/api/e2e', { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }),
    400, 'the page itself gets through (and is told it named no task)');
  assert.equal(await send('POST', '/api/orchestrator/launch', { origin: 'https://evil.example' }), 403);
  assert.equal(await send('GET', '/api/answer?taskId=t1', { 'sec-fetch-site': 'cross-site' }), 403,
    'an <img> on another site must not eat an answer');
  assert.equal(await send('GET', '/api/state', { host: `evil.example:${port}` }), 403, 'a name rebound to 127.0.0.1');
  assert.equal(await send('GET', '/', { 'sec-fetch-site': 'cross-site' }), 200, 'a link to the page still opens it');
  assert.equal(await send('GET', '/api/state', { host: `localhost:${port}`, origin: `http://localhost:${port}` }), 200);
});

test('the final review follows its own switch and runs, and its settings repeat nothing', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, { commitMessage: '  feat: hosts  ' });
  let task = await task0(base);
  assert.strictEqual(task.step1.finalReview, true, 'on unless switched off');
  assert.deepStrictEqual(task.step1.finalCodeReview, [{ flags: ['--since-last'] }]);
  assert.strictEqual(task.step1.commitMessage, 'feat: hosts');
  assert.strictEqual(stepOf(task, 9).enabled, true);
  await postState(base, { step: 1, status: 'completed' });
  const res = await (await step1(base, { commitMessage: 'feat: hosts and clusters', finalReview: false,
    finalCodeReview: [{ flags: ['--light'] }] })).json();
  assert.deepStrictEqual(res.revision.changed, ['finalCodeReview', 'commit']);
  assert.strictEqual(res.revision.restartAt, null, 'nothing before implementation reads them');
  task = await task0(base);
  assert.strictEqual(stepOf(task, 9).enabled, false);
  assert.strictEqual(task.step1.commitMessage, 'feat: hosts and clusters');
});

test('every helper of a step takes a model and effort of its own', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, { agents: { model: 'opus', roles: { reviewWalker: { model: 'sonnet', effort: 'low' },
    validationRunner: { model: 'haiku' }, finalFixer: { effort: 'high' }, bogus: { model: 'sonnet' } },
    steps: { 9: { model: 'sonnet' } } } });
  const { agents } = (await task0(base)).step1;
  assert.deepStrictEqual(agents.roles.reviewWalker, { model: 'sonnet', effort: 'low' });
  assert.deepStrictEqual(agents.roles.validationRunner, { model: 'haiku', effort: '' });
  assert.deepStrictEqual(agents.roles.finalFixer, { model: '', effort: 'high' });
  assert.strictEqual(agents.roles.bogus, undefined, 'only the roles the pipeline spawns');
  assert.deepStrictEqual(agents.steps['9'], { model: 'sonnet', effort: '' });
});

test('the base a task starts from is kept for its pull request', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.strictEqual((await postState(base, { base: 'master' })).status, 200);
  assert.strictEqual((await task0(base)).base, 'master');
});

test('the final review takes the E2E slot for its regression run and frees it when done', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/tasks', {});
  assert.deepStrictEqual(await (await post(base, '/api/e2e', { taskId: 't1' })).json(), { granted: true });
  await postState(base, { step: 5, status: 'in_progress' });
  await post(base, '/api/state', { taskId: 't2', step: 9, status: 'in_progress', activeStep: 9 });
  const queued = await (await post(base, '/api/e2e', { taskId: 't2', step: 9 })).json();
  assert.strictEqual(queued.granted, false);
  let t2 = (await getState(base)).tasks[1];
  assert.strictEqual(stepOf(t2, 9).status, 'in_progress', 'the review waits mid-step, it is not put back');
  assert.strictEqual(stepOf(t2, 9).currentOperation, 'Waiting for the E2E slot');
  await postState(base, { step: 5, status: 'completed' });
  assert.deepStrictEqual(await (await fetch(`${base}/api/answer?taskId=t2`)).json(), { answer: { kind: 'e2e', taskId: 't2' } });
  t2 = (await getState(base)).tasks[1];
  assert.strictEqual(stepOf(t2, 9).currentOperation, 'Took the E2E slot');
  await post(base, '/api/state', { taskId: 't2', step: 9, status: 'completed' });
  assert.strictEqual((await getState(base)).e2e.holder, null);
  assert.strictEqual((await post(base, '/api/e2e', { taskId: 't1', step: 6 })).status, 400, 'the first review runs no suite');
});

test('shutdown with a pull request reaches every finished task, and leaves a request file for each', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  assert.strictEqual((await post(base, '/api/answer', { taskId: 't1', kind: 'summary', decision: 'shutdown_pr' })).status, 409,
    'nothing finished, nothing to open');
  await post(base, '/api/tasks', {});
  await post(base, '/api/tasks', {});
  await step1(base, { commitMessage: 'feat: hosts', taskSplit: '1. model\n2. UI' });
  assert.strictEqual((await (await fetch(`${base}/api/answer?taskId=t1`)).json()).answer.kind, 'step1');
  await postState(base, { branch: 'feature/x', base: 'master', root: '/w/x', summary: { finalStatus: 'Completed' } });
  await post(base, '/api/state', { taskId: 't2', summary: { finalStatus: 'Failed at Implementation' } });
  const res = await (await post(base, '/api/answer', { taskId: 't2', kind: 'summary', decision: 'shutdown_pr' })).json();
  assert.deepStrictEqual(res, { ok: true, tasks: ['t1'] });
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'tasks', 't1', 'pr-request.json'), 'utf8'));
  assert.deepStrictEqual({ ...request, requestedAt: undefined },
    { requestedAt: undefined, taskId: 't1', branch: 'feature/x', base: 'master', root: '/w/x', commitMessage: 'feat: hosts',
      taskSplit: '1. model\n2. UI', splitBranch: 'feature/x' });
  assert.ok(!fs.existsSync(path.join(dir, 'tasks', 't2', 'pr-request.json')), 'a failed task gets no pull request');
  assert.deepStrictEqual(await (await fetch(`${base}/api/answer?taskId=t1`)).json(),
    { answer: { kind: 'summary', decision: 'shutdown_pr', taskId: 't1' } });
  assert.strictEqual((await (await fetch(`${base}/api/answer?taskId=t2`)).json()).answer, null);
});

test('the last mockup round can be approved while the agent reworks it', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await postState(base, { step: 3, status: 'in_progress', activeStep: 3, mockupReview: { text: 'r1', screens: [] } });
  await post(base, '/api/answer', { taskId: 't1', kind: 'mockup', decision: 'feedback', text: 'dark mode too' });
  assert.ok((await task0(base)).mockupReview.answered, 'the round is off the screen while reworked');
  await post(base, '/api/answer', { taskId: 't1', kind: 'mockup', decision: 'approve' });
  const task = await task0(base);
  assert.strictEqual(task.mockupReview, null);
  assert.strictEqual(stepOf(task, 3).currentOperation, 'Approved — dropping the rework, recording the approved round…');
  await nextAnswer(base);
  const approved = await nextAnswer(base);
  assert.strictEqual(approved.decision, 'approve');
  assert.strictEqual(approved.duringRework, true, 'the orchestrator stops the rework first');
});

test('the task split is kept, and a change to it revises the branches', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await step1(base, { commitMessage: 'feat: hosts' });
  let task = await task0(base);
  assert.strictEqual(task.step1.taskSplit, '', 'empty unless filled');
  await postState(base, { step: 1, status: 'completed' });
  const res = await (await step1(base, { commitMessage: 'feat: hosts', taskSplit: '  1. API\n2. UI  ' })).json();
  assert.deepStrictEqual(res.revision.changed, ['branch']);
  task = await task0(base);
  assert.strictEqual(task.step1.taskSplit, '1. API\n2. UI');
});

test('a mockup artifact request and its link stay on the task', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  await post(base, '/api/answer', { taskId: 't1', kind: 'mockup', decision: 'artifact' });
  let task = await task0(base);
  assert.deepStrictEqual(task.mockupArtifact, { requested: true, url: null });
  await postState(base, { mockupArtifact: 'https://claude.ai/artifact/abc' });
  task = await task0(base);
  assert.deepStrictEqual(task.mockupArtifact, { requested: true, url: 'https://claude.ai/artifact/abc' });
});
