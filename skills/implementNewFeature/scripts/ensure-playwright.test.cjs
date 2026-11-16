'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ep = require('./ensure-playwright.cjs');

// 2026-11-16: a fix agent's visual check found no Playwright in the plugin, ran `npm install` and
// `playwright install chromium` itself - a minute of its run - and got no verdict.
test('a missing toolchain is installed once: the package, then the browser', () => {
  const calls = [];
  const out = ep.ensure({ dir: '/k/implementNewFeature' }, {
    exists: () => false,
    run: (cmd, args) => { calls.push([path.basename(cmd), ...args].join(' ')); return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.deepStrictEqual(out.ready, true);
  assert.deepStrictEqual(out.steps, ['npm install', 'chromium']);
  assert.match(calls[0], /^npm(\.cmd)? --prefix .*implementNewFeature install --no-audit --no-fund/);
  assert.match(calls[1], /cli\.js install chromium$/);
});

test('a present toolchain only checks the browser, and a failed install says why', () => {
  const calls = [];
  const ready = ep.ensure({ dir: '/k/implementNewFeature' }, { exists: () => true, run: (cmd, args) => { calls.push(args.join(' ')); return { status: 0 }; } });
  assert.deepStrictEqual(ready.steps, ['chromium']);
  assert.strictEqual(calls.length, 1);
  const failed = ep.ensure({ dir: '/k/implementNewFeature' }, { exists: () => false, run: () => ({ status: 1, stderr: 'ETIMEDOUT registry.npmjs.org' }) });
  assert.strictEqual(failed.ready, false);
  assert.match(failed.errors[0], /ETIMEDOUT/);
  assert.throws(() => ep.parseArgs(['--dirr=x']), /Unknown argument/);
});
