'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { waitAnswer, EXIT_CODES } = require('./wait-answer.cjs');

// The real server's contract: `{answer}` per GET, `null` once the wait runs out; `status` and
// `body` stand in for its refusals. Every request's URL lands in `seen`.
function fakeServer(t, queue, { delayMs = 0, status = 200, body = {}, seen = [] } = {}) {
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (status !== 200) {
      res.statusCode = status;
      res.end(JSON.stringify(body));
      return;
    }
    const answer = queue.length ? queue.shift() : null;
    const wait = new URL(req.url, 'http://x').searchParams.get('wait');
    setTimeout(() => res.end(JSON.stringify({ answer })), answer || !wait ? 0 : delayMs);
  });
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function lockDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-answer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('an answer is printed with every answer queued behind it', async (t) => {
  const port = await fakeServer(t, [{ kind: 'answer', taskId: 't1', value: 'a' }, { kind: 'message', taskId: 't1', text: 'b' }]);
  const lines = [];
  const result = await waitAnswer({ port, task: 't1', windowMs: 5000, lockDir: lockDir(t), write: (l) => lines.push(l) });
  assert.strictEqual(result, 'ANSWER');
  assert.deepStrictEqual(lines, [
    'ANSWER {"kind":"answer","taskId":"t1","value":"a"}',
    'ANSWER {"kind":"message","taskId":"t1","text":"b"}',
  ]);
});

test('every poll names the task, the session and the waiter; only the first takes the task over', async (t) => {
  const seen = [];
  const port = await fakeServer(t, [{ kind: 'answer', taskId: 't2', value: 'a' }], { seen });
  await waitAnswer({ port, task: 't2', session: 's 2', windowMs: 5000, pollS: 7, lockDir: lockDir(t), waiterId: 'w1',
    write: () => {} });
  assert.deepStrictEqual(seen, ['/api/answer?taskId=t2&session=s%202&wait=5&waiter=w1&takeover=1',
    '/api/answer?taskId=t2&session=s%202&waiter=w1', '/api/answer?taskId=t2&session=s%202&wait=2&waiter=w1']);
});

test('a waiter a newer one took the task from leaves with WAITER_SUPERSEDED', async (t) => {
  const server = http.createServer((req, res) => res.end(JSON.stringify({ answer: null, superseded: true })));
  t.after(() => server.close());
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const dir = lockDir(t);
  const lines = [];
  assert.strictEqual(await waitAnswer({ port, task: 't1', windowMs: 5000, lockDir: dir, write: (l) => lines.push(l) }),
    'WAITER_SUPERSEDED');
  assert.deepStrictEqual([lines, fs.readdirSync(dir)], [['WAITER_SUPERSEDED'], []]);
});

test('an answer that arrives a moment after the first rides the same wake-up', async (t) => {
  // The first answer, an empty drain, then the settle poll that catches the second one.
  const replies = [{ kind: 'message', taskId: 't1', text: 'a' }, null, { kind: 'decision', taskId: 't1', decision: 'approve' }, null, null];
  const server = http.createServer((req, res) => res.end(JSON.stringify({ answer: replies.shift() || null })));
  t.after(() => server.close());
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const lines = [];
  assert.strictEqual(await waitAnswer({ port, task: 't1', windowMs: 5000, lockDir: lockDir(t), write: (l) => lines.push(l) }), 'ANSWER');
  assert.deepStrictEqual(lines.map((l) => JSON.parse(l.slice('ANSWER '.length)).kind), ['message', 'decision']);
});

test('an empty window ends in WAIT_TIMEOUT and releases the lock', async (t) => {
  const port = await fakeServer(t, [], { delayMs: 300 });
  const dir = lockDir(t);
  const lines = [];
  assert.strictEqual(await waitAnswer({ port, task: 't1', windowMs: 1500, pollS: 1, lockDir: dir, write: (l) => lines.push(l) }), 'WAIT_TIMEOUT');
  assert.deepStrictEqual(lines, ['WAIT_TIMEOUT']);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('--minutes 0 asks once, without waiting, and still drains what is queued', async (t) => {
  const seen = [];
  const port = await fakeServer(t, [], { delayMs: 3000, seen });
  const lines = [];
  assert.strictEqual(await waitAnswer({ port, task: 't1', session: null, windowMs: 0, lockDir: lockDir(t), write: (l) => lines.push(l) }), 'WAIT_TIMEOUT');
  assert.deepStrictEqual([seen, lines], [['/api/answer?taskId=t1'], ['WAIT_TIMEOUT']]);

  const queued = await fakeServer(t, [{ kind: 'message', taskId: 't1', text: 'a' }, { kind: 'message', taskId: 't1', text: 'b' }]);
  const drained = [];
  assert.strictEqual(await waitAnswer({ port: queued, task: 't1', windowMs: 0, lockDir: lockDir(t), write: (l) => drained.push(l) }), 'ANSWER');
  assert.strictEqual(drained.length, 2);
});

test('a server that is gone ends in SERVER_GONE', async (t) => {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const lines = [];
  assert.strictEqual(await waitAnswer({ port: freePort, task: 't1', windowMs: 5000, lockDir: lockDir(t), write: (l) => lines.push(l) }), 'SERVER_GONE');
  assert.deepStrictEqual(lines, ['SERVER_GONE']);
});

test('a task another session orchestrates is ORCHESTRATOR_RUNNING, a removed one TASK_GONE', async (t) => {
  const taken = await fakeServer(t, [], { status: 409, body: { error: 'task t2 has an orchestrator of its own', session: 's1' } });
  const lines = [];
  assert.strictEqual(await waitAnswer({ port: taken, task: 't2', session: 's2', windowMs: 5000, lockDir: lockDir(t), write: (l) => lines.push(l) }), 'ORCHESTRATOR_RUNNING');
  const gone = await fakeServer(t, [], { status: 400, body: { error: 'unknown task' } });
  assert.strictEqual(await waitAnswer({ port: gone, task: 't9', windowMs: 5000, lockDir: lockDir(t), write: (l) => lines.push(l) }), 'TASK_GONE');
  assert.deepStrictEqual(lines, ['ORCHESTRATOR_RUNNING s1', 'TASK_GONE']);
});

test('a live waiter of the same session is taken over; a drain steps aside, another session keeps it', async (t) => {
  const dir = lockDir(t);
  const seen = [];
  const port = await fakeServer(t, [{ kind: 'answer', taskId: 't1', value: 'a' }], { seen });
  const lock = path.join(dir, `doh-answer-waiter-${port}-t1.json`);
  // The parent process stands in for a live holder, ten minutes into its 50.
  const holder = JSON.stringify({ pid: process.ppid, startedAt: Date.now() - 600000, windowMs: 3000000, session: 's1' });
  fs.writeFileSync(lock, holder);
  const lines = [];
  // A drain judges the holder by the holder's window, not by its own one of 0.
  assert.strictEqual(await waitAnswer({ port, task: 't1', session: 's1', windowMs: 0, lockDir: dir, write: (l) => lines.push(l) }), 'WAITER_RUNNING');
  // Another session's waiter means another session's task.
  assert.strictEqual(await waitAnswer({ port, task: 't1', session: 's2', windowMs: 5000, lockDir: dir, write: (l) => lines.push(l) }), 'ORCHESTRATOR_RUNNING');
  assert.deepStrictEqual(seen, [], 'neither asked the server');
  // A waiter with a window is the orchestrator's newest: it takes the task over.
  assert.strictEqual(await waitAnswer({ port, task: 't1', session: 's1', windowMs: 5000, lockDir: dir, waiterId: 'w2', write: (l) => lines.push(l) }), 'ANSWER');
  assert.ok(seen[0].endsWith('&waiter=w2&takeover=1'), seen[0]);
  assert.deepStrictEqual(lines, [`WAITER_RUNNING ${process.ppid}`, 'ORCHESTRATOR_RUNNING s1', 'ANSWER {"kind":"answer","taskId":"t1","value":"a"}']);
});

test('the exit code says which line the waiter printed, and a waiter whose output goes nowhere never starts', async (t) => {
  const script = path.join(__dirname, 'wait-answer.cjs');
  const run = (args, stdout) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', stdout, 'pipe'] });
    let err = '';
    let out = '';
    child.stderr.on('data', (d) => { err += d; });
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const seen = [];
  const port = await fakeServer(t, [], { seen });
  const task = `x${process.pid}`;
  const timeout = await run(['--port', String(port), '--task', task, '--minutes', '0'], 'pipe');
  assert.deepStrictEqual([timeout.code, timeout.out], [EXIT_CODES.WAIT_TIMEOUT, 'WAIT_TIMEOUT\n']);
  const discarded = await run(['--port', String(port), '--task', task, '--minutes', '0'], 'ignore');
  assert.strictEqual(discarded.code, 2);
  assert.match(discarded.err, /run_in_background/);
  assert.strictEqual(seen.length, 1, 'the discarded one took nothing off the server');
});

test('a waiter for another task of the same server does not wait for this one', async (t) => {
  const dir = lockDir(t);
  const port = await fakeServer(t, [{ kind: 'answer', taskId: 't2', value: 'a' }]);
  fs.writeFileSync(path.join(dir, `doh-answer-waiter-${port}-t1.json`),
    JSON.stringify({ pid: process.ppid, startedAt: Date.now(), windowMs: 3000000 }));
  assert.strictEqual(await waitAnswer({ port, task: 't2', windowMs: 5000, lockDir: dir, write: () => {} }), 'ANSWER');
});
