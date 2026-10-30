'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, register, start, wait, kill, cleanup, listeners } = require('./task-processes.cjs');

const taskDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-proc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a registered dev server is stopped by its port, and the list is emptied', (t) => {
  const dir = taskDir(t);
  assert.deepStrictEqual(register({ taskDir: dir, port: 4317, what: 'ng serve' }), ['REGISTERED 4317']);
  register({ taskDir: dir, port: 3000, what: 'mockoon' });
  const stopped = [];
  const lines = cleanup({ taskDir: dir }, {
    listeners: (port) => (port === 4317 ? [1234] : []),
    stop: (pid) => { stopped.push(pid); return true; },
  });
  assert.deepStrictEqual(lines, ['STOPPED 4317 1234', 'NOT_RUNNING 3000']);
  assert.deepStrictEqual(stopped, [1234]);
  assert.deepStrictEqual(cleanup({ taskDir: dir }), ['NONE']);
});

test('a server the cleanup could not stop stays on the list for the next one', (t) => {
  const dir = taskDir(t);
  register({ taskDir: dir, port: 4317 });
  assert.deepStrictEqual(cleanup({ taskDir: dir }, { listeners: () => [55], stop: () => false }), ['STILL_RUNNING 4317 55']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'processes.json'), 'utf8')).map((p) => p.port), [4317]);
});

test('the stepper\'s own port is never a task process', () => {
  assert.throws(() => parseArgs(['register', '--task-dir=x', '--port=9999']), /stepper's/);
  assert.throws(() => parseArgs(['register', '--task-dir=x']), /--port/);
  assert.throws(() => parseArgs(['start', '--task-dir=x', '--port=4317', '--root=/w']), /--command/);
  assert.throws(() => parseArgs(['kill', '--port=4317']), /--root/);
  assert.deepStrictEqual(parseArgs(['start', '--task-dir=x', '--root=/w', '--port=4317', '--command=npm start -- --port 4317']).line,
    'npm start -- --port 4317');
});

test('the listener table of each OS is read for that port only, IPv6 included', () => {
  const netstat = [
    '  TCP    [::1]:4317             [::]:0                 LISTENING       5150',
    '  TCP    127.0.0.1:43170        0.0.0.0:0              LISTENING       77',
    '  TCP    127.0.0.1:4317         127.0.0.1:50000        ESTABLISHED     88',
    '  UDP    0.0.0.0:4317           *:*                                    99',
  ].join('\r\n');
  let asked = null;
  assert.deepStrictEqual(listeners(4317, 'win32', (cmd, args) => { asked = args; return netstat; }), [5150]);
  assert.deepStrictEqual(asked, ['-ano'], 'never `-p TCP`: it hides every IPv6 listener');
  assert.deepStrictEqual(listeners(4317, 'linux', () => '42\n43\n'), [42, 43]);
  assert.deepStrictEqual(listeners(4317, 'linux', () => { throw new Error('no lsof'); }), []);
});

test('start records the port before the process exists, and refuses a taken port', async (t) => {
  const dir = taskDir(t);
  let spawned = null;
  const fake = (line, opts) => {
    spawned = { line, opts, recorded: JSON.parse(fs.readFileSync(path.join(dir, 'processes.json'), 'utf8')) };
    return { pid: 4242, unref() {} };
  };
  const lines = await start({ taskDir: dir, root: '/w/t2', port: 4317, line: 'npx ng serve --port 4317' },
    { portFree: async () => true, spawn: fake });
  assert.match(lines[0], /^STARTED 4317 4242 .*dev-server-4317\.log$/);
  assert.deepStrictEqual(spawned.recorded.map((p) => p.port), [4317], 'recorded before the spawn');
  assert.strictEqual(spawned.opts.cwd, '/w/t2');
  assert.strictEqual(spawned.opts.detached, true);
  const entry = JSON.parse(fs.readFileSync(path.join(dir, 'processes.json'), 'utf8'))[0];
  assert.strictEqual(entry.pid, 4242);
  assert.deepStrictEqual(await start({ taskDir: dir, root: '/w/t2', port: 4317, line: 'x' }, { portFree: async () => false }),
    ['PORT_TAKEN 4317']);
});

test('wait answers READY, PENDING after its slice, or EXITED with the log tail', async (t) => {
  const dir = taskDir(t);
  const log = path.join(dir, 'dev.log');
  fs.writeFileSync(log, 'compiling\nError: Cannot find module x\n');
  register({ taskDir: dir, port: 4317 }, { pid: 7, log });
  const sleep = async () => {};
  assert.deepStrictEqual(await wait({ taskDir: dir, port: 4317, timeoutMs: 1 }, { answers: async () => true, sleep }), ['READY 4317']);
  assert.deepStrictEqual(await wait({ taskDir: dir, port: 4317, timeoutMs: 1 }, { answers: async () => false, alive: () => true, sleep }),
    ['PENDING 4317']);
  assert.deepStrictEqual(await wait({ taskDir: dir, port: 4317, timeoutMs: 1 }, { answers: async () => false, alive: () => false, sleep }),
    ['EXITED 4317', 'compiling', 'Error: Cannot find module x']);
});

test('kill stops only a listener started from the task\'s own worktree', () => {
  const stopped = [];
  const lines = kill({ root: 'C:\\w\\DPXN-1-t2', port: 4317 }, {
    listeners: () => [11, 12],
    commandLine: (pid) => (pid === 11 ? 'node C:/w/DPXN-1-t2/node_modules/@angular/cli/bin/ng.js serve' : 'node C:/Projects/app/server.js'),
    stop: (pid) => { stopped.push(pid); return true; },
  });
  assert.deepStrictEqual(lines, ['STOPPED 4317 11', 'NOT_OURS 4317 12']);
  assert.deepStrictEqual(stopped, [11]);
  assert.deepStrictEqual(kill({ root: '/w', port: 4317 }, { listeners: () => [] }), ['NOT_RUNNING 4317']);
});
