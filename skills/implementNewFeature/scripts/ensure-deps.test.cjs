'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { ensureDeps } = require('./ensure-deps.cjs');

const skillDir = path.join('plugin', 'skills', 'implementNewFeature');
const cli = path.join(skillDir, 'node_modules', '@playwright', 'test', 'cli.js');

// A machine as the checks see it: which files exist, and what each install adds or fails with.
function machine({ files = [], browser = null, fail = {} }) {
  const present = new Set(files);
  const calls = [];
  return {
    calls,
    exists: (p) => present.has(p),
    browserPath: () => browser,
    exec: (command, args) => {
      const what = command === 'npm' ? 'npm' : 'chromium';
      calls.push(what);
      if (fail[what]) return { ok: false, reason: fail[what] };
      if (what === 'npm') present.add(cli);
      else present.add(browser);
      return { ok: true, reason: '' };
    },
  };
}

test('a plugin with its runner and browser in place installs nothing', () => {
  const m = machine({ files: [cli, 'chrome.exe'], browser: 'chrome.exe' });
  assert.strictEqual(ensureDeps({ skillDir, ...m }), 'DEPS_READY');
  assert.deepStrictEqual(m.calls, []);
});

test('an upgraded plugin gets its package; the browser it finds in the shared cache stays', () => {
  const m = machine({ files: ['chrome.exe'], browser: 'chrome.exe' });
  assert.strictEqual(ensureDeps({ skillDir, ...m }), 'DEPS_INSTALLED playwright');
  assert.deepStrictEqual(m.calls, ['npm']);
});

test('a machine without the browser gets it after the package', () => {
  const m = machine({ browser: 'chrome.exe' });
  assert.strictEqual(ensureDeps({ skillDir, ...m }), 'DEPS_INSTALLED playwright,chromium');
  assert.deepStrictEqual(m.calls, ['npm', 'chromium']);
});

test('a failed install says which one and why, and goes no further', () => {
  const offline = machine({ browser: 'chrome.exe', fail: { npm: 'npm ERR! network request failed' } });
  assert.strictEqual(ensureDeps({ skillDir, ...offline }), 'DEPS_FAILED npm install: npm ERR! network request failed');
  assert.deepStrictEqual(offline.calls, ['npm']);
  const noBrowser = machine({ files: [cli], browser: 'chrome.exe', fail: { chromium: 'download failed' } });
  assert.strictEqual(ensureDeps({ skillDir, ...noBrowser }), 'DEPS_FAILED chromium install: download failed');
});
