'use strict';

// The event loop's listener. The orchestrator starts it with `run_in_background` and ends
// its turn; the script long-polls `/api/answer` for up to 50 minutes and exits as soon as
// something arrives, which is what wakes the orchestrator again. An empty 290 s poll used
// to cost a whole turn - the full conversation re-read to learn "nothing yet" - while the
// user was reading a plan or typing credentials.
//
// Output, one line each (FIXED IDENTIFIERS - the orchestrator matches them):
//   ANSWER <json>        one per answer; every answer already queued is drained with it
//   WAIT_TIMEOUT         nothing arrived within the window
//   SERVER_GONE          the server does not answer: the run is over
//   WAITER_RUNNING <pid> another waiter for this port is still listening; nothing to do
//
// 50 minutes, not longer: a waiter that ends is also a turn that keeps the conversation's
// prompt cache warm, and the orchestrator re-arms it at once.
//
// Usage: node wait-answer.cjs --port <port> [--minutes 50]

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const pollSeconds = 290;

function getJson(port, query, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/answer${query}`, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('poll timed out')));
    req.on('error', reject);
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// One waiter per server: two would split the answers between them, and the orchestrator
// would act on whichever woke it first. A lock older than its own window is stale
// whatever its pid says - the pid may have been reused.
function acquireLock(lockPath, windowMs) {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (held.pid !== process.pid && isAlive(held.pid) && Date.now() - held.startedAt < windowMs + 60000) {
      return held.pid;
    }
  } catch {}
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  return null;
}

function releaseLock(lockPath) {
  try {
    if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid === process.pid) fs.unlinkSync(lockPath);
  } catch {}
}

async function waitAnswer({ port, windowMs, pollS = pollSeconds, lockDir = os.tmpdir(), write = (line) => process.stdout.write(`${line}\n`) }) {
  const lockPath = path.join(lockDir, `doh-answer-waiter-${port}.json`);
  const holder = acquireLock(lockPath, windowMs);
  if (holder) {
    write(`WAITER_RUNNING ${holder}`);
    return 'WAITER_RUNNING';
  }
  try {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      const waitS = Math.max(1, Math.min(pollS, Math.ceil((deadline - Date.now()) / 1000)));
      let reply;
      try {
        reply = await getJson(port, `?wait=${waitS}`, (waitS + 30) * 1000);
      } catch {
        write('SERVER_GONE');
        return 'SERVER_GONE';
      }
      if (!reply.answer) continue;
      write(`ANSWER ${JSON.stringify(reply.answer)}`);
      // Whatever else is already queued goes out in the same wake-up.
      for (;;) {
        let next;
        try {
          next = await getJson(port, '', 30000);
        } catch {
          break;
        }
        if (!next.answer) break;
        write(`ANSWER ${JSON.stringify(next.answer)}`);
      }
      return 'ANSWER';
    }
    write('WAIT_TIMEOUT');
    return 'WAIT_TIMEOUT';
  } finally {
    releaseLock(lockPath);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  let port = 0;
  let minutes = 50;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') port = Number(argv[++i]);
    else if (arg === '--minutes') minutes = Number(argv[++i]);
  }
  if (!port) {
    process.stderr.write('usage: node wait-answer.cjs --port <port> [--minutes 50]\n');
    process.exitCode = 2;
  } else {
    waitAnswer({ port, windowMs: minutes * 60000 });
  }
}

module.exports = { waitAnswer };
