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

test('GET /api/state returns initial 5-step state', async t => {
  const app = createApp(tmpDir());
  const base = await listen(app);
  t.after(() => app.server.close());
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.steps.length, 5);
  assert.equal(state.steps[0].name, 'Requirements');
  assert.equal(state.steps[4].name, 'Code Review');
  assert.ok(state.steps.every(s => s.status === 'waiting'));
  assert.equal(state.activeStep, 1);
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
