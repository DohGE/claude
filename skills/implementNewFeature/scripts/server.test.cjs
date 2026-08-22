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

test('GET /api/state returns the 7-step pipeline with Mockups opt-in', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.deepEqual(state.steps.map(s => s.name),
    ['Requirements', 'Feature Refinement', 'Mockups', 'Implementation',
      'Validation & E2E', 'Code Review', 'Mockoon Mocks']);
  assert.ok(state.steps.every(s => s.status === 'waiting'));
  // Mockups is the only step the stepper hides until the step-1 toggle enables it.
  assert.deepEqual(state.steps.filter(s => s.enabled === false).map(s => s.id), [3]);
  assert.equal(state.activeStep, 1);
  assert.equal(state.mockupReview, null);
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
  await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 3, enabled: true, status: 'in_progress',
      activeStep: 3, mockupReview: review })
  });
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.steps[2].enabled, true);
  assert.deepEqual(state.mockupReview, review);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-state.json'), 'utf8'));
  assert.equal(onDisk.steps[2].enabled, true);

  await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mockupReview: null })
  });
  assert.equal((await (await fetch(`${base}/api/state`)).json()).mockupReview, null);
});

function writeMockup(dir, name, body) {
  const d = path.join(dir, 'generated-mockups');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), body);
}

test('GET /generated-mockups/<file> serves the mockup uncached', async t => {
  const dir = tmpDir();
  writeMockup(dir, 'login.html', '<h1>Logowanie</h1>');
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/generated-mockups/login.html?rev=3`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  // The agent rewrites the same filenames between chat rounds.
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), '<h1>Logowanie</h1>');
});

test('GET /generated-mockups rejects traversal, unknown types and missing files', async t => {
  const dir = tmpDir();
  writeMockup(dir, 'login.html', 'ok');
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"login":"u","password":"s3cret"}');
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const blocked = ['/generated-mockups/..%2Fauth.json', '/generated-mockups/..%5Cauth.json',
    '/generated-mockups/auth.json', '/generated-mockups/missing.html',
    '/generated-mockups/notes.txt', '/generated-mockups/.env'];
  for (const p of blocked) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, `expected 404 for ${p}`);
    assert.ok(!(await res.text()).includes('s3cret'), `${p} leaked credentials`);
  }
  const malformed = await fetch(`${base}/generated-mockups/%zz.html`);
  assert.equal(malformed.status, 400);
});

test('POST /api/state merges updates and persists to pipeline-state.json', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 3, status: 'in_progress', progress: 40,
      currentOperation: 'Task 2/5', logEntry: 'started task 2', activeStep: 3 })
  });
  assert.equal(res.status, 200);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.steps[2].status, 'in_progress');
  assert.equal(state.steps[2].progress, 40);
  assert.equal(state.steps[2].currentOperation, 'Task 2/5');
  assert.equal(state.steps[2].log.length, 1);
  assert.equal(state.activeStep, 3);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-state.json'), 'utf8'));
  assert.equal(onDisk.steps[2].status, 'in_progress');
});

test('createApp reloads persisted state after restart', async t => {
  const dir = tmpDir();
  const app1 = createApp(dir);
  const base1 = await listen(app1);
  await fetch(`${base1}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 1, status: 'completed' })
  });
  await new Promise(r => app1.server.close(r));
  const app2 = createApp(dir);
  const base2 = await listen(app2);
  t.after(() => app2.server.close());
  const state = await (await fetch(`${base2}/api/state`)).json();
  assert.equal(state.steps[0].status, 'completed');
});

test('POST /api/state with unknown step returns 400', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 9, status: 'completed' })
  });
  assert.equal(res.status, 400);
});

test('answer queue is FIFO and empties', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const post = a => fetch(`${base}/api/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(a)
  });
  await post({ kind: 'answer', text: 'first' });
  await post({ kind: 'answer', text: 'second' });
  const a1 = await (await fetch(`${base}/api/answer`)).json();
  const a2 = await (await fetch(`${base}/api/answer`)).json();
  const a3 = await (await fetch(`${base}/api/answer`)).json();
  assert.equal(a1.answer.text, 'first');
  assert.equal(a2.answer.text, 'second');
  assert.equal(a3.answer, null);
});

test('GET /api/answer?wait=2 long-polls until an answer arrives', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  setTimeout(() => {
    fetch(`${base}/api/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'decision', decision: 'approve' })
    });
  }, 300);
  const started = Date.now();
  const got = await (await fetch(`${base}/api/answer?wait=2`)).json();
  assert.equal(got.answer.decision, 'approve');
  assert.ok(Date.now() - started >= 250, 'should have waited for the POST');
});

test('POST /api/upload writes sanitized file into session dir', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'mockups', filename: '..\\..\\evil.png',
      dataBase64: Buffer.from('img-bytes').toString('base64') })
  });
  assert.equal(res.status, 200);
  const saved = path.join(dir, 'mockups', 'evil.png');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'img-bytes');
});

test('POST /api/auth writes credentials to auth.json in the session dir', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: ' qa@example.com ', password: 'Zażółć!7' })
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
  // login is trimmed; the password is stored verbatim (spaces may be legal in it)
  assert.deepEqual(saved, { login: 'qa@example.com', password: 'Zażółć!7' });
});

test('POST /api/auth rejects missing or blank credentials with 400', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const bad = [{}, { login: 'user' }, { password: 'pass' },
    { login: '   ', password: 'pass' }, { login: 'user', password: '   ' }];
  for (const body of bad) {
    const res = await fetch(`${base}/api/auth`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'auth.json')), 'auth.json must not be created');
});

test('credentials are not readable back over HTTP (no GET /api/auth)', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  await fetch(`${base}/api/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'user', password: 'secret' })
  });
  const res = await fetch(`${base}/api/auth`);
  assert.equal(res.status, 404);
});

test('POST /api/upload rejects unknown category', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'secrets', filename: 'x', dataBase64: 'aa' })
  });
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

test('POST /api/shutdown deletes auth.json from the session dir', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => {
    try {
      if (app.server.closeAllConnections) app.server.closeAllConnections();
      app.server.close(() => {});
    } catch (_e) { /* already closed */ }
  });
  await fetch(`${base}/api/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'user', password: 'secret' })
  });
  assert.ok(fs.existsSync(path.join(dir, 'auth.json')));
  const closed = new Promise(r => app.server.on('close', r));
  await fetch(`${base}/api/shutdown`, { method: 'POST' });
  await closed;
  assert.ok(!fs.existsSync(path.join(dir, 'auth.json')),
    'auth.json must be wiped on shutdown');
});

test('GET /api/mockoon serves the environment file the step-7 agent wrote', async t => {
  const dir = tmpDir();
  const app = createApp(dir);
  const base = await listen(app);
  t.after(() => app.server.close());
  const env = JSON.stringify({ name: 'Feature mocks', port: 3000, hostname: 'localhost' }, null, 2);
  fs.writeFileSync(path.join(dir, 'mockoon.json'), env, 'utf8');
  const res = await fetch(`${base}/api/mockoon`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  // Byte-for-byte: the user copies exactly what the agent formatted.
  assert.equal(await res.text(), env);
});

test('GET /api/mockoon returns 404 before the mocks are generated', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
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
    cp1250Bytes(JSON.stringify({ step: 3, currentOperation: text })));
  assert.equal(res.status, 200);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.steps[2].currentOperation, text);
});

test('POST /api/state decodes UTF-16LE BOM bodies (PowerShell Out-File default)', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const text = 'Zażółć gęślą jaźń';
  const json = JSON.stringify({ step: 2, currentOperation: text });
  const res = await postRaw(base, '/api/state',
    Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(json, 'utf16le')]));
  assert.equal(res.status, 200);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.steps[1].currentOperation, text);
});

test('POST /api/state strips a UTF-8 BOM before parsing', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const json = JSON.stringify({ step: 1, currentOperation: 'Wymagania — zapisuję' });
  const res = await postRaw(base, '/api/state',
    Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(json, 'utf8')]));
  assert.equal(res.status, 200);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.steps[0].currentOperation, 'Wymagania — zapisuję');
});

test('POST /api/state passes valid UTF-8 Polish text through unchanged', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const text = 'Pchnąć w tę łódź jeża lub ośm skrzyń fig';
  const res = await postRaw(base, '/api/state',
    Buffer.from(JSON.stringify({ step: 4, logEntry: text }), 'utf8'));
  assert.equal(res.status, 200);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.steps[3].log[0].text, text);
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

test('POST /api/state bumps questionSeq even when the question id repeats', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const post = (body) => fetch(`${base}/api/state`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const seq = async () => (await (await fetch(`${base}/api/state`)).json()).questionSeq;
  assert.strictEqual(await seq(), 0);
  await post({ question: { id: 'q1', text: 'first' } });
  assert.strictEqual(await seq(), 1);
  await post({ question: null });
  await post({ question: { id: 'q1', text: 'second' } });
  assert.strictEqual(await seq(), 3, 'every question POST moves the counter the UI re-renders on');
});
