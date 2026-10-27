'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('./server.cjs');
const { parseArgs, postAll } = require('./post-state.cjs');

async function listen(t) {
  const app = createApp(fs.mkdtempSync(path.join(os.tmpdir(), 'post-state-')));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  return { app, port: app.server.address().port };
}

test('a step transition goes out as one call, in order, Polish intact', async (t) => {
  const { app, port } = await listen(t);
  const lines = [];
  const code = await postAll({ port, bodies: [
    { taskId: 't1', step: 1, status: 'completed', activeStep: 4 },
    { taskId: 't1', step: 4, status: 'in_progress', currentOperation: 'Implementacja w toku — zażółć' },
  ] }, (l) => lines.push(l));
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(lines, ['OK', 'OK']);
  const task = app.getState().tasks[0];
  assert.strictEqual(task.activeStep, 4);
  assert.strictEqual(task.steps.find((s) => s.id === 4).currentOperation, 'Implementacja w toku — zażółć');
});

test('the first refused body stops the rest', async (t) => {
  const { app, port } = await listen(t);
  const lines = [];
  const code = await postAll({ port, bodies: [
    { taskId: 't1', step: 4, statuss: 'completed' },
    { taskId: 't1', step: 4, status: 'completed' },
  ] }, (l) => lines.push(l));
  assert.strictEqual(code, 1);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^ERROR 400 unknown field\(s\) statuss/);
  assert.strictEqual(app.getState().tasks[0].steps.find((s) => s.id === 4).status, 'waiting');
});

test('every body names its task, and bodies come from arguments or a file', () => {
  assert.throws(() => parseArgs(['--port', '9999', '{"step":4}']), /without "taskId"/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'post-state-')), 'b.json');
  fs.writeFileSync(file, '﻿[{"taskId":"t1","step":4}]');
  assert.deepStrictEqual(parseArgs(['--port', '9999', '--file', file]).bodies, [{ taskId: 't1', step: 4 }]);
});
