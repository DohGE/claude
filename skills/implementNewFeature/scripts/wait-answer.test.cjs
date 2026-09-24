'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { waitAnswer } = require('./wait-answer.cjs');

// The real server's contract: `{answer}` per GET, `null` once the wait runs out.
function fakeServer(t, queue, { delayMs = 0 } = {}) {
  const server = http.createServer((req, res) => {
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
  const port = await fakeServer(t, [{ kind: 'answer', taskId: 't1', value: 'a' }, { kind: 'message', taskId: 't2', text: 'b' }]);
  const lines = [];
  const result = await waitAnswer({ port, windowMs: 5000, lockDir: lockDir(t), write: (l) => lines.push(l) });
  assert.strictEqual(result, 'ANSWER');
  assert.deepStrictEqual(lines, [
    'ANSWER {"kind":"answer","taskId":"t1","value":"a"}',
    'ANSWER {"kind":"message","taskId":"t2","text":"b"}',
  ]);
});

test('an empty window ends in WAIT_TIMEOUT and releases the lock', async (t) => {
  const port = await fakeServer(t, [], { delayMs: 300 });
  const dir = lockDir(t);
  const lines = [];
  assert.strictEqual(await waitAnswer({ port, windowMs: 1500, pollS: 1, lockDir: dir, write: (l) => lines.push(l) }), 'WAIT_TIMEOUT');
  assert.deepStrictEqual(lines, ['WAIT_TIMEOUT']);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a server that is gone ends in SERVER_GONE', async (t) => {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const lines = [];
  assert.strictEqual(await waitAnswer({ port: freePort, windowMs: 5000, lockDir: lockDir(t), write: (l) => lines.push(l) }), 'SERVER_GONE');
  assert.deepStrictEqual(lines, ['SERVER_GONE']);
});

test('a second waiter for the same port steps aside while the first is alive', async (t) => {
  const dir = lockDir(t);
  // The parent process stands in for a live holder.
  fs.writeFileSync(path.join(dir, 'doh-answer-waiter-4567.json'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
  const lines = [];
  assert.strictEqual(await waitAnswer({ port: 4567, windowMs: 5000, lockDir: dir, write: (l) => lines.push(l) }), 'WAITER_RUNNING');
  assert.deepStrictEqual(lines, [`WAITER_RUNNING ${process.ppid}`]);
});
