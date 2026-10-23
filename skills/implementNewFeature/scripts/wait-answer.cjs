'use strict';

// The event loop's listener. The orchestrator starts it with `run_in_background` and ends
// its turn; the script long-polls `/api/answer` for up to 50 minutes and exits as soon as
// something arrives, which is what wakes the orchestrator again. An empty 290 s poll used
// to cost a whole turn - the full conversation re-read to learn "nothing yet" - while the
// user was reading a plan or typing credentials.
//
// Every task has an orchestrator of its own, and its waiter listens for that task alone. The
// poll names the session it runs in (CLAUDE_CODE_SESSION_ID), which is how the server tells
// the task's orchestrator from a second one: the first session to poll a task holds it for as
// long as it is alive.
//
// Output, one line each (FIXED IDENTIFIERS - the orchestrator matches them):
//   ANSWER <json>                   one per answer; every answer already queued is drained with it
//   WAIT_TIMEOUT                    nothing arrived within the window
//   SERVER_GONE                     the server does not answer: the run is over
//   WAITER_RUNNING <pid>            this session's other waiter for the task still listens; nothing to do
//   ORCHESTRATOR_RUNNING <session>  another session orchestrates this task; leave it to that one
//   TASK_GONE                       the server has no such task
//
// 50 minutes, not longer: a waiter that ends is also a turn that keeps the conversation's
// prompt cache warm, and the orchestrator re-arms it at once. `--minutes 0` asks once without
// waiting, for whatever is already queued.
//
// Usage: node wait-answer.cjs --port <port> --task <taskId> [--minutes 50] [--session <id>]

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
          resolve({ ...JSON.parse(body), status: res.statusCode });
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

// One waiter per task: two would split its answers between them, and the orchestrator would
// act on whichever woke it first. A lock older than its holder's window is stale whatever its
// pid says - the pid may have been reused.
function acquireLock(lockPath, windowMs, session) {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const heldFor = Number.isFinite(held.windowMs) ? held.windowMs : windowMs;
    if (held.pid !== process.pid && isAlive(held.pid) && Date.now() - held.startedAt < heldFor + 60000) {
      return held;
    }
  } catch {}
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), windowMs,
    session: session || null }));
  return null;
}

function releaseLock(lockPath) {
  try {
    if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid === process.pid) fs.unlinkSync(lockPath);
  } catch {}
}

async function waitAnswer({ port, task, session = process.env.CLAUDE_CODE_SESSION_ID, windowMs, pollS = pollSeconds,
  lockDir = os.tmpdir(), write = (line) => process.stdout.write(`${line}\n`) }) {
  const lockPath = path.join(lockDir, `doh-answer-waiter-${port}-${task}.json`);
  const holder = acquireLock(lockPath, windowMs, session);
  if (holder) {
    // Another session's waiter is that session's claim on the task, made before the server
    // could be asked.
    if (holder.session && session && holder.session !== session) {
      write(`ORCHESTRATOR_RUNNING ${holder.session}`);
      return 'ORCHESTRATOR_RUNNING';
    }
    write(`WAITER_RUNNING ${holder.pid}`);
    return 'WAITER_RUNNING';
  }
  const query = (waitS) => `?taskId=${encodeURIComponent(task)}`
    + (session ? `&session=${encodeURIComponent(session)}` : '') + (waitS ? `&wait=${waitS}` : '');
  // The server's no to the poll itself, as opposed to an empty one.
  const refused = (reply) => {
    if (reply.status === 409) {
      write(`ORCHESTRATOR_RUNNING ${reply.session || ''}`.trim());
      return 'ORCHESTRATOR_RUNNING';
    }
    if (reply.status === 400) {
      write('TASK_GONE');
      return 'TASK_GONE';
    }
    return null;
  };
  try {
    const deadline = Date.now() + windowMs;
    do {
      const waitS = windowMs > 0 ? Math.max(1, Math.min(pollS, Math.ceil((deadline - Date.now()) / 1000))) : 0;
      let reply;
      try {
        reply = await getJson(port, query(waitS), (waitS + 30) * 1000);
      } catch {
        write('SERVER_GONE');
        return 'SERVER_GONE';
      }
      const no = refused(reply);
      if (no) return no;
      if (!reply.answer) continue;
      write(`ANSWER ${JSON.stringify(reply.answer)}`);
      // Whatever else is already queued goes out in the same wake-up.
      for (;;) {
        let next;
        try {
          next = await getJson(port, query(0), 30000);
        } catch {
          break;
        }
        if (!next.answer) break;
        write(`ANSWER ${JSON.stringify(next.answer)}`);
      }
      return 'ANSWER';
    } while (Date.now() < deadline);
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
  let task = '';
  let session;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') port = Number(argv[++i]);
    else if (arg === '--minutes') minutes = Number(argv[++i]);
    else if (arg === '--task') task = String(argv[++i] || '');
    else if (arg === '--session') session = argv[++i];
  }
  // The task names the lock file, so only what a task id is made of gets that far.
  if (!port || !/^[A-Za-z0-9_-]+$/.test(task) || !(minutes >= 0)) {
    process.stderr.write('usage: node wait-answer.cjs --port <port> --task <taskId> [--minutes 50] [--session <id>]\n');
    process.exitCode = 2;
  } else {
    waitAnswer({ port, task, session, windowMs: minutes * 60000 });
  }
}

module.exports = { waitAnswer };
