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
// Usage: node task-processes.cjs register --task-dir=<SESSION>/tasks/<id> --port=<n> [--what=<label>]
//        node task-processes.cjs cleanup  --task-dir=<SESSION>/tasks/<id>
// Prints `REGISTERED <port>`, or per port `STOPPED <port> <pid>` / `NOT_RUNNING <port>`; `NONE`
// when nothing was registered (FIXED IDENTIFIERS).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FILE = 'processes.json';
// The stepper itself, which no task may stop.
const PROTECTED_PORTS = new Set([9999]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['register', 'cleanup'].includes(command)) throw new Error('usage: node task-processes.cjs register|cleanup --task-dir=<dir> [--port=<n>] [--what=<label>]');
  const args = { command, taskDir: '', port: 0, what: '' };
  for (const arg of rest) {
    const m = arg.match(/^--(task-dir|port|what)=(.+)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'task-dir') args.taskDir = m[2];
    else if (m[1] === 'port') args.port = Number(m[2]);
    else if (m[1] === 'what') args.what = m[2];
  }
  if (!args.taskDir) throw new Error('--task-dir is required');
  if (command === 'register' && !(args.port > 0 && args.port < 65536)) throw new Error('--port=<n> is required');
  if (PROTECTED_PORTS.has(args.port)) throw new Error(`port ${args.port} is the stepper's - never a task's process`);
  return args;
}

const read = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
  } catch {
    return [];
  }
};

function register({ taskDir, port, what }) {
  const list = read(taskDir).filter((p) => p.port !== port);
  list.push({ port, what: what || 'process', registeredAt: new Date().toISOString() });
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, FILE), JSON.stringify(list, null, 2));
  return [`REGISTERED ${port}`];
}

// The pids listening on a TCP port, by the OS's own table.
function listeners(port, platform = process.platform, exec = execFileSync) {
  try {
    if (platform === 'win32') {
      const out = exec('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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

function cleanup({ taskDir }, seams = {}) {
  const list = read(taskDir);
  if (!list.length) return ['NONE'];
  const lines = [];
  for (const { port } of list) {
    if (PROTECTED_PORTS.has(port)) continue;
    const pids = (seams.listeners || listeners)(port);
    if (!pids.length) lines.push(`NOT_RUNNING ${port}`);
    for (const pid of pids) if ((seams.stop || stop)(pid)) lines.push(`STOPPED ${port} ${pid}`);
  }
  fs.writeFileSync(path.join(taskDir, FILE), '[]');
  return lines.length ? lines : ['NONE'];
}

if (require.main === module) {
  let lines;
  try {
    const args = parseArgs(process.argv.slice(2));
    lines = args.command === 'register' ? register(args) : cleanup(args);
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exit(2);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

module.exports = { parseArgs, register, cleanup, listeners, stop };
