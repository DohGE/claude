'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, waitPart, maxSeconds } = require('./wait-part.cjs');

test('a part already on disk is ready at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-wait-'));
  const file = path.join(dir, 'raport.part003.md');
  fs.writeFileSync(file, 'x');
  assert.strictEqual(await waitPart({ path: file, seconds: 5 }), `PART_READY ${file}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a part that appears during the wait is ready, one that never does is pending', async () => {
  let clock = 0;
  let written = false;
  const fake = { exists: () => written, now: () => clock, sleep: async (ms) => { clock += ms; if (clock >= 6000) written = true; } };
  assert.strictEqual(await waitPart({ path: 'p.md', seconds: 30 }, fake), 'PART_READY p.md');
  clock = 0;
  written = false;
  const never = { exists: () => false, now: () => clock, sleep: async (ms) => { clock += ms; } };
  assert.strictEqual(await waitPart({ path: 'p.md', seconds: 10 }, never), 'PART_PENDING p.md');
  assert.ok(clock >= 10000 && clock <= 12000, `waited ${clock} ms`);
});

test('--nonempty waits past the empty file a shell redirect creates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-wait-'));
  const file = path.join(dir, 'test.result.json');
  fs.writeFileSync(file, '');
  assert.strictEqual(await waitPart({ path: file, seconds: 0, nonempty: true }), `PART_PENDING ${file}`);
  fs.writeFileSync(file, '{"ok":true}');
  assert.strictEqual(await waitPart({ path: file, seconds: 0, nonempty: true }), `PART_READY ${file}`);
  assert.strictEqual(parseArgs(['--path=a', '--nonempty']).nonempty, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a slice never outlasts the prompt cache, and the path is required', () => {
  assert.strictEqual(parseArgs(['--path=a.md', '--seconds=9999']).seconds, maxSeconds);
  assert.ok(maxSeconds < 300);
  assert.throws(() => parseArgs([]), /required/);
  assert.throws(() => parseArgs(['--part=a.md']), /Unknown argument/);
});

test('several parts: the wait ends when the first lands, one line per part', async () => {
  let clock = 0;
  const ready = new Set();
  const fake = { exists: (p) => ready.has(p), now: () => clock, sleep: async (ms) => { clock += ms; if (clock >= 4000) ready.add('b.md'); } };
  assert.strictEqual(await waitPart({ paths: ['a.md', 'b.md', 'c.md'], seconds: 30 }, fake), 'PART_PENDING a.md\nPART_READY b.md\nPART_PENDING c.md');
  clock = 0;
  ready.clear();
  const never = { exists: () => false, now: () => clock, sleep: async (ms) => { clock += ms; } };
  assert.strictEqual(await waitPart({ paths: ['a.md', 'b.md'], seconds: 5 }, never), 'PART_PENDING a.md\nPART_PENDING b.md');
  assert.deepStrictEqual(parseArgs(['--path=a.md', '--path=b.md']).paths, ['a.md', 'b.md']);
  assert.strictEqual(parseArgs(['--path=a.md']).path, 'a.md', 'one path reads as before');
});
