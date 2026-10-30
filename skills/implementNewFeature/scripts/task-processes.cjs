#!/usr/bin/env node
'use strict';

// The long-lived processes a task's agents start - dev servers above all - recorded by the port
// they listen on, and stopped together when the step that needed them ends. A dev server an
// earlier step left behind held the app's port for the next task's validation, and nobody could
// stop it without a permission prompt; one per task left running is also what ran a machine out
// of memory mid-E2E. A port, not a pid: a Bash `$!` on Windows is an MSYS number, not the
// process Windows knows, while whatever listens on the port the agent picked is exactly the
// server it started.
//
// `start` is how an agent brings a dev server up: the port is recorded BEFORE the process exists,
// so an agent that dies mid-step - killed for memory, cut off - still leaves the record the
// orchestrator's cleanup stops it by. `wait` answers in under four minutes, so the agent waits in
// slices without blocking a tool call past its prompt cache. `kill` stops a stray listener the
// record does not know, but only one started from the task's own worktree: the user's own dev
// server on the same machine is never a task's to stop.
//
// Usage: node task-processes.cjs register --task-dir=<SESSION>/tasks/<id> --port=<n> [--what=<label>]
//        node task-processes.cjs start    --task-dir=<dir> --root=<worktree> --port=<n> --command="<line>" [--what=<label>]
//        node task-processes.cjs wait     --task-dir=<dir> --port=<n> [--timeout-ms=<n>]
//        node task-processes.cjs kill     --root=<worktree> --port=<n>
//        node task-processes.cjs cleanup  --task-dir=<dir>
// Prints (FIXED IDENTIFIERS): `REGISTERED <port>`; `STARTED <port> <pid> <log>` or
// `PORT_TAKEN <port>`; `READY <port>`, `PENDING <port>` or `EXITED <port>` and the log's last
// lines; per port `STOPPED <port> <pid>`, `NOT_RUNNING <port>`, `STILL_RUNNING <port> <pid>` or
// `NOT_OURS <port> <pid>`; `NONE` when nothing was registered.

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const FILE = 'processes.json';
// The stepper itself, which no task may stop.
const PROTECTED_PORTS = new Set([9999]);
const COMMANDS = ['register', 'start', 'wait', 'kill', 'cleanup'];
// Under the four minutes a tool call may block before the agent's prompt cache goes cold.
const WAIT_SLICE_MS = 210 * 1000;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) {
    throw new Error(`usage: node task-processes.cjs ${COMMANDS.join('|')} --task-dir=<dir> [--port=<n>] [--root=<dir>] [--command="<line>"] [--what=<label>] [--timeout-ms=<n>]`);
  }
  const args = { command, taskDir: '', port: 0, what: '', root: '', line: '', timeoutMs: WAIT_SLICE_MS };
  for (const arg of rest) {
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'task-dir') args.taskDir = m[2];
    else if (m[1] === 'port') args.port = Number(m[2]);
    else if (m[1] === 'what') args.what = m[2];
    else if (m[1] === 'root') args.root = m[2];
    else if (m[1] === 'command') args.line = m[2];
    else if (m[1] === 'timeout-ms') args.timeoutMs = Number(m[2]);
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (command !== 'kill' && !args.taskDir) throw new Error('--task-dir is required');
  if (command !== 'cleanup' && !(args.port > 0 && args.port < 65536)) throw new Error('--port=<n> is required');
  if (PROTECTED_PORTS.has(args.port)) throw new Error(`port ${args.port} is the stepper's - never a task's process`);
  if ((command === 'start' || command === 'kill') && !args.root) throw new Error('--root=<worktree> is required');
  if (command === 'start' && !args.line.trim()) throw new Error('--command="<line>" is required');
  if (!(args.timeoutMs > 0)) throw new Error('--timeout-ms must be a positive number');
  return args;
}

const read = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
  } catch {
    return [];
  }
};
const write = (dir, list) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(list, null, 2));
};

function register({ taskDir, port, what }, extra = {}) {
  const list = read(taskDir).filter((p) => p.port !== port);
  list.push({ port, what: what || 'process', registeredAt: new Date().toISOString(), ...extra });
  write(taskDir, list);
  return [`REGISTERED ${port}`];
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port);
  });
}

// Recorded first, spawned second: whatever happens to the agent after this line, the cleanup
// knows the port. The process is detached and owns no pipe of the caller's, so the tool call
// returns at once and the server outlives it - until the cleanup stops it.
async function start({ taskDir, root, port, line, what }, seams = {}) {
  if (!(await (seams.portFree || portFree)(port))) return [`PORT_TAKEN ${port}`];
  const logDir = path.join(taskDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `dev-server-${port}.log`);
  register({ taskDir, port, what: what || 'dev-server' }, { log, command: line });
  const out = fs.openSync(log, 'a');
  const child = (seams.spawn || spawn)(line, {
    cwd: root, shell: true, detached: true, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
  });
  fs.closeSync(out);
  if (child.unref) child.unref();
  register({ taskDir, port, what: what || 'dev-server' }, { log, command: line, pid: child.pid });
  return [`STARTED ${port} ${child.pid} ${log.replace(/\\/g, '/')}`];
}

// Any HTTP answer is a server that is up, on either loopback name: Angular's dev server binds
// `localhost`, which is `::1` alone on many Windows machines.
function answers(port, timeoutMs = 3000) {
  const ask = (host) => new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
  return Promise.all([ask('127.0.0.1'), ask('::1')]).then((r) => r.some(Boolean));
}

function alive(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const tail = (file, lines = 20) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(-lines);
  } catch {
    return [];
  }
};

async function wait({ taskDir, port, timeoutMs }, seams = {}) {
  const entry = read(taskDir).find((p) => p.port === port) || {};
  const deadline = Date.now() + Math.min(timeoutMs, WAIT_SLICE_MS);
  const sleep = seams.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    if (await (seams.answers || answers)(port)) return [`READY ${port}`];
    if (!(seams.alive || alive)(entry.pid)) return [`EXITED ${port}`, ...tail(entry.log)];
    if (Date.now() >= deadline) return [`PENDING ${port}`];
    await sleep(2000);
  }
}

// The pids listening on a TCP port, by the OS's own table. Every TCP row, IPv4 and IPv6 alike:
// `netstat -p TCP` lists IPv4 only, and a dev server bound to `[::1]` then looked stopped while
// it kept its port and its memory for the rest of the run.
function listeners(port, platform = process.platform, exec = execFileSync) {
  try {
    if (platform === 'win32') {
      const out = exec('netstat', ['-ano'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pids = new Set();
      for (const line of out.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3]) && new RegExp(`:${port}$`).test(cols[1])) pids.add(Number(cols[4]));
      }
      return [...pids].filter((pid) => pid > 0);
    }
    const out = exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map(Number).filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

function stop(pid, platform = process.platform, exec = execFileSync) {
  if (pid === process.pid || pid === process.ppid) return false;
  try {
    if (platform === 'win32') exec('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// The command line a process was started with, '' when the OS will not say.
function commandLine(pid, platform = process.platform, exec = execFileSync) {
  try {
    if (platform === 'win32') {
      return String(exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
    }
    return String(exec('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
  } catch {
    return '';
  }
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function kill({ root, port }, seams = {}) {
  const pids = (seams.listeners || listeners)(port);
  if (!pids.length) return [`NOT_RUNNING ${port}`];
  const lines = [];
  for (const pid of pids) {
    const cmd = norm((seams.commandLine || commandLine)(pid));
    if (!cmd.includes(norm(root))) {
      lines.push(`NOT_OURS ${port} ${pid}`);
      continue;
    }
    lines.push((seams.stop || stop)(pid) ? `STOPPED ${port} ${pid}` : `STILL_RUNNING ${port} ${pid}`);
  }
  return lines;
}

// What could not be stopped stays on the list, so the next cleanup tries again instead of
// forgetting a server that is still holding its port.
function cleanup({ taskDir }, seams = {}) {
  const list = read(taskDir);
  if (!list.length) return ['NONE'];
  const lines = [];
  const kept = [];
  for (const entry of list) {
    if (PROTECTED_PORTS.has(entry.port)) continue;
    const pids = (seams.listeners || listeners)(entry.port);
    if (!pids.length) lines.push(`NOT_RUNNING ${entry.port}`);
    let left = false;
    for (const pid of pids) {
      if ((seams.stop || stop)(pid)) lines.push(`STOPPED ${entry.port} ${pid}`);
      else {
        lines.push(`STILL_RUNNING ${entry.port} ${pid}`);
        left = true;
      }
    }
    if (left) kept.push(entry);
  }
  write(taskDir, kept);
  return lines.length ? lines : ['NONE'];
}

if (require.main === module) {
  (async () => {
    let lines;
    try {
      const args = parseArgs(process.argv.slice(2));
      if (args.command === 'register') lines = register(args);
      else if (args.command === 'start') lines = await start(args);
      else if (args.command === 'wait') lines = await wait(args);
      else if (args.command === 'kill') lines = kill(args);
      else lines = cleanup(args);
    } catch (err) {
      process.stderr.write(`${(err && err.message) || err}\n`);
      process.exit(2);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    const failed = /^(PORT_TAKEN|EXITED|NOT_OURS|STILL_RUNNING)/.test(lines[0] || '');
    process.exit(failed ? 1 : 0);
  })();
}

module.exports = { parseArgs, register, start, wait, kill, cleanup, listeners, stop, commandLine, answers };
