'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { waitAnswer } = require('./wait-answer.cjs');

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

test('every poll names the task and the session it is for', async (t) => {
  const seen = [];
  const port = await fakeServer(t, [{ kind: 'answer', taskId: 't2', value: 'a' }], { seen });
  await waitAnswer({ port, task: 't2', session: 's 2', windowMs: 5000, pollS: 7, lockDir: lockDir(t), write: () => {} });
  assert.deepStrictEqual(seen, ['/api/answer?taskId=t2&session=s%202&wait=5',
    '/api/answer?taskId=t2&session=s%202']);
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

test('a second waiter for the same task steps aside while the first is alive', async (t) => {
  const dir = lockDir(t);
  // The parent process stands in for a live holder, ten minutes into its 50.
  fs.writeFileSync(path.join(dir, 'doh-answer-waiter-4567-t1.json'),
    JSON.stringify({ pid: process.ppid, startedAt: Date.now() - 600000, windowMs: 3000000, session: 's1' }));
  const lines = [];
  assert.strictEqual(await waitAnswer({ port: 4567, task: 't1', session: 's1', windowMs: 5000, lockDir: dir, write: (l) => lines.push(l) }), 'WAITER_RUNNING');
  // A drain judges the holder by the holder's window, not by its own one of 0.
  assert.strictEqual(await waitAnswer({ port: 4567, task: 't1', session: 's1', windowMs: 0, lockDir: dir, write: (l) => lines.push(l) }), 'WAITER_RUNNING');
  // Another session's waiter means another session's task.
  assert.strictEqual(await waitAnswer({ port: 4567, task: 't1', session: 's2', windowMs: 5000, lockDir: dir, write: (l) => lines.push(l) }), 'ORCHESTRATOR_RUNNING');
  assert.deepStrictEqual(lines, [`WAITER_RUNNING ${process.ppid}`, `WAITER_RUNNING ${process.ppid}`, 'ORCHESTRATOR_RUNNING s1']);
});

test('a waiter for another task of the same server does not wait for this one', async (t) => {
  const dir = lockDir(t);
  const port = await fakeServer(t, [{ kind: 'answer', taskId: 't2', value: 'a' }]);
  fs.writeFileSync(path.join(dir, `doh-answer-waiter-${port}-t1.json`),
    JSON.stringify({ pid: process.ppid, startedAt: Date.now(), windowMs: 3000000 }));
  assert.strictEqual(await waitAnswer({ port, task: 't2', windowMs: 5000, lockDir: dir, write: () => {} }), 'ANSWER');
});
