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
// Output, one line each (FIXED IDENTIFIERS - the orchestrator matches them), and the exit code
// that comes with it:
//   0  ANSWER <json>                   one per answer; every answer already queued is drained with it
//   3  WAIT_TIMEOUT                    nothing arrived within the window
//   4  WAITER_RUNNING <pid>            a drain while this session's waiter for the task still listens
//   4  WAITER_SUPERSEDED               a newer waiter of this session took the task over
//   5  ORCHESTRATOR_RUNNING <session>  another session orchestrates this task; leave it to that one
//   6  SERVER_GONE                     the server does not answer: the run is over
//   7  TASK_GONE                       the server has no such task
// The task notification carries the exit code, so a 3 or a 4 needs no Read of the output at all:
// on a run with a night in it, the wake-ups that only said WAIT_TIMEOUT were a quarter of the
// orchestrator's tokens, a third of each one spent reading that one line.
//
// The newest waiter owns the task. Its first poll takes the task over (`takeover=1`), the server
// ends the older waiter's parked poll and refuses its next one (`superseded`), and that waiter
// leaves with WAITER_SUPERSEDED. A waiter that held the lock used to turn every later one away
// instead, so one nobody read - started with its output thrown away - took the user's answer to
// a question and kept the orchestrator deaf for its whole window. Hence also the refusal below
// to start at all when the output goes nowhere.
//
// 50 minutes, not longer: a waiter that ends is also a turn that keeps the conversation's
// prompt cache warm, and the orchestrator re-arms it at once. `--minutes 0` asks once without
// waiting, for whatever is already queued, and never takes the task over.
//
// Usage: node wait-answer.cjs --port <port> --task <taskId> [--minutes 50] [--session <id>]

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const tty = require('node:tty');

const EXIT_CODES = { ANSWER: 0, WAIT_TIMEOUT: 3, WAITER_RUNNING: 4, WAITER_SUPERSEDED: 4, ORCHESTRATOR_RUNNING: 5,
  SERVER_GONE: 6, TASK_GONE: 7 };

const pollSeconds = 290;
// After an answer, how long one more poll waits for the next: a user who sends a line and then
// presses a gate a second later is one wake-up of the orchestrator, not two - and every wake-up
// re-reads its whole conversation.
const settleSeconds = 2;

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

// Where the lines of a waiter go: a file (`run_in_background`), a pipe or a terminal reach
// somebody; a null device - `&>/dev/null &`, `> NUL` - or a closed stdout does not.
function outputDiscarded(fd = 1) {
  let stat;
  try {
    stat = fs.fstatSync(fd);
  } catch {
    return true;
  }
  return stat.isCharacterDevice() && !tty.isatty(fd);
}

// One waiter per task: two would split its answers between them, and the orchestrator would
// act on whichever woke it first. A lock older than its holder's window is stale whatever its
// pid says - the pid may have been reused. A live holder of the same session is replaced by a
// waiter with a window (`takeover`) - the server then retires the holder's poll - and only a
// drain steps aside for it; another session's holder is that session's task either way.
function acquireLock(lockPath, windowMs, session, takeover) {
  try {
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const heldFor = Number.isFinite(held.windowMs) ? held.windowMs : windowMs;
    const otherSession = held.session && session && held.session !== session;
    if (held.pid !== process.pid && isAlive(held.pid) && Date.now() - held.startedAt < heldFor + 60000
      && (otherSession || !takeover)) {
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
  settleS = settleSeconds, lockDir = os.tmpdir(), waiterId = String(process.pid),
  write = (line) => process.stdout.write(`${line}\n`) }) {
  const lockPath = path.join(lockDir, `doh-answer-waiter-${port}-${task}.json`);
  const takeover = windowMs > 0;
  const holder = acquireLock(lockPath, windowMs, session, takeover);
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
  // Only the first poll takes the task over: a later one of this waiter - the next slice, a settle
  // poll - must not retire a waiter that started after it. A drain names no waiter: it owns
  // nothing, so it is never retired either, and the lock above already kept it off a live one.
  let first = takeover;
  const query = (waitS) => {
    const q = `?taskId=${encodeURIComponent(task)}`
      + (session ? `&session=${encodeURIComponent(session)}` : '') + (waitS ? `&wait=${waitS}` : '')
      + (takeover ? `&waiter=${encodeURIComponent(waiterId)}` : '') + (first ? '&takeover=1' : '');
    first = false;
    return q;
  };
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
      if (reply.superseded) {
        write('WAITER_SUPERSEDED');
        return 'WAITER_SUPERSEDED';
      }
      if (!reply.answer) continue;
      write(`ANSWER ${JSON.stringify(reply.answer)}`);
      // Whatever else is already queued goes out in the same wake-up, and so does what arrives
      // within `settleS` of the last one: the first empty poll of that length ends the wake-up.
      // A drain (`--minutes 0`) only takes what is there.
      const settleFor = windowMs > 0 ? settleS : 0;
      for (let settle = 0; ;) {
        let next;
        try {
          next = await getJson(port, query(settle), (settle + 30) * 1000);
        } catch {
          break;
        }
        if (next.superseded) break;
        if (!next.answer) {
          if (settle || !settleFor) break;
          settle = settleFor;
          continue;
        }
        write(`ANSWER ${JSON.stringify(next.answer)}`);
        settle = 0;
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
  } else if (outputDiscarded()) {
    // It would still take the answers off the server, and nobody would ever read them.
    process.stderr.write('wait-answer: stdout goes nowhere - start it with run_in_background instead '
      + '(never `&`, `> /dev/null`, nohup or Start-Process); nothing was taken from the server\n');
    process.exitCode = 2;
  } else {
    waitAnswer({ port, task, session, windowMs: minutes * 60000 }).then((result) => {
      process.exitCode = EXIT_CODES[result] ?? 0;
    });
  }
}

module.exports = { waitAnswer, outputDiscarded, EXIT_CODES };
