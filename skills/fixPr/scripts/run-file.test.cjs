'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { updateRunFile } = require('./run-file.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

function runFile(t, targets) {
  const file = path.join(tempDir(t, 'fpc-runfile-'), 'fixpr-run-x.json');
  fs.writeFileSync(file, JSON.stringify({ project: '/p', targets: targets.map((branch) => ({ branch })) }));
  return file;
}

// Step 3 launches every target in the background, and each launch keeps `launch` on its target:
// without the lock, two launches a moment apart dropped whichever wrote first.
test('updates of one run file from processes running side by side all stay', async (t) => {
  const branches = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const file = runFile(t, branches);
  const script = `
    const { updateRunFile } = require(${JSON.stringify(path.join(__dirname, 'run-file.cjs'))});
    const branch = process.argv[1];
    for (let i = 0; i < 15; i += 1) {
      updateRunFile(${JSON.stringify(file)}, (data) => {
        const t = data.targets.find((x) => x.branch === branch);
        t.count = (t.count || 0) + 1;
      });
    }`;
  await Promise.all(branches.map((b) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, b], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  })));
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(data.targets.map((x) => [x.branch, x.count]), branches.map((b) => [b, 15]));
  assert.ok(!fs.existsSync(`${file}.lock`), 'the lock is gone after the last write');
});

test('a lock a crashed script left is taken over once it is stale, and the answer of mutate comes back', (t) => {
  const file = runFile(t, ['p1']);
  fs.mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(`${file}.lock`, old, old);
  const value = updateRunFile(file, (data) => {
    data.targets[0].launch = { at: 'now' };
    return 'kept';
  });
  assert.strictEqual(value, 'kept');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).targets[0].launch, { at: 'now' });
  assert.ok(!fs.existsSync(`${file}.lock`));
});
