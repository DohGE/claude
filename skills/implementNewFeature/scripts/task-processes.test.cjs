'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, register, cleanup, listeners } = require('./task-processes.cjs');

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

test('the stepper\'s own port is never a task process', () => {
  assert.throws(() => parseArgs(['register', '--task-dir=x', '--port=9999']), /stepper's/);
  assert.throws(() => parseArgs(['register', '--task-dir=x']), /--port/);
});

test('the listener table of each OS is read for that port only', () => {
  const netstat = [
    '  TCP    0.0.0.0:4317           0.0.0.0:0              LISTENING       5150',
    '  TCP    [::1]:4317             [::]:0                 LISTENING       5150',
    '  TCP    127.0.0.1:43170        0.0.0.0:0              LISTENING       77',
    '  TCP    127.0.0.1:4317         127.0.0.1:50000        ESTABLISHED     88',
  ].join('\r\n');
  assert.deepStrictEqual(listeners(4317, 'win32', () => netstat), [5150]);
  assert.deepStrictEqual(listeners(4317, 'linux', () => '42\n43\n'), [42, 43]);
  assert.deepStrictEqual(listeners(4317, 'linux', () => { throw new Error('no lsof'); }), []);
});
