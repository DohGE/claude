'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, pairsIn, comparePixels, CHANNEL_TOLERANCE } = require('./visual-diff.cjs');

test('pixels within the tolerance match; the rest are counted and painted red', () => {
  const a = new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255, 0, 0, 0, 255]);
  const b = new Uint8ClampedArray([10 + CHANNEL_TOLERANCE, 10, 10, 255, 20, 200, 200, 255, 0, 0, 0, 0]);
  const { differing, total, out } = comparePixels(a, b, CHANNEL_TOLERANCE);
  assert.strictEqual(total, 3);
  assert.strictEqual(differing, 2, 'a channel off by more than the tolerance, and a missing pixel');
  assert.deepStrictEqual([...out.slice(4, 8)], [255, 0, 0, 255]);
  assert.strictEqual(out[3], 70, 'a matching pixel is faded, not hidden');
});

test('only complete pairs are compared, in id order', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-diff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['0.10-mockup.png', '0.10-app.png', '0.2-mockup.png', '0.2-app.png', '1.0-mockup.png', 'notes.txt']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  assert.deepStrictEqual(pairsIn(dir).map((p) => p.id), ['0.2', '0.10']);
});

test('parseArgs takes the folder and a threshold share', () => {
  assert.deepStrictEqual(parseArgs(['--dir=/s/screenshots']), { dir: '/s/screenshots', threshold: 0.01 });
  assert.strictEqual(parseArgs(['--dir=/s', '--threshold=0.05']).threshold, 0.05);
  assert.throws(() => parseArgs(['--dir=/s', '--threshold=5']), /between 0 and 1/);
});
