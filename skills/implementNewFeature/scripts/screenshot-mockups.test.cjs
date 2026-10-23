'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { fileNameOf } = require('./screenshot-mockups.cjs');

const SCRIPT = path.join(__dirname, 'screenshot-mockups.cjs');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shots-')));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // best-effort temp cleanup
    }
  });
  return dir;
}

const run = taskDir => spawnSync(process.execPath, [SCRIPT, taskDir], { encoding: 'utf8', timeout: 120000 });

test('a screenshot is named <id> <view> - <case>, without what Windows refuses', () => {
  assert.strictEqual(fileNameOf({ id: '1.0', view: 'Login', title: 'Empty form' }, 0), '1.0 Login - Empty form.png');
  assert.strictEqual(fileNameOf({ id: '2.1', view: 'Lista: zamówienia', title: 'Błąd <500>?' }, 0),
    '2.1 Lista zamówienia - Błąd 500.png');
  assert.strictEqual(fileNameOf({ id: '3.0', view: 'Raport', title: 'Raport' }, 0), '3.0 Raport.png',
    'a view with one case is not named twice');
  assert.strictEqual(fileNameOf({ title: 'Stary manifest.' }, 4), '5 Stary manifest.png',
    'a screen from before the numbering still gets a unique name');
});

test('every screen of the manifest becomes one PNG, and the folder holds only this round', t => {
  const task = tempDir(t);
  const mockups = path.join(task, 'generated-mockups');
  fs.mkdirSync(mockups, { recursive: true });
  // The second screen reaches for a CDN: the request is aborted, not waited on.
  fs.writeFileSync(path.join(mockups, '1.0-login.html'), '<h1>Login</h1>');
  fs.writeFileSync(path.join(mockups, '1.1-login-error.html'),
    '<link rel="stylesheet" href="https://cdn.example.com/x.css"><h1 style="height:2000px">Error</h1>');
  fs.writeFileSync(path.join(mockups, 'manifest.json'), JSON.stringify({ screens: [
    { id: '1.0', view: 'Login', title: 'Empty', file: '1.0-login.html' },
    { id: '1.1', view: 'Login', title: 'Error', file: '1.1-login-error.html' },
  ] }));
  const shots = path.join(task, 'mockup-screenshots');
  fs.mkdirSync(shots);
  fs.writeFileSync(path.join(shots, 'stale.png'), 'old round');
  const res = run(task);
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.strictEqual(res.stdout.trim(), `SCREENSHOTS 2 ${shots}`);
  assert.deepStrictEqual(fs.readdirSync(shots).sort(), ['1.0 Login - Empty.png', '1.1 Login - Error.png']);
  for (const f of fs.readdirSync(shots)) {
    assert.ok(fs.readFileSync(path.join(shots, f)).subarray(0, 4).equals(PNG), `${f} is a PNG`);
  }
});

test('without a manifest the script says so on its one line', t => {
  const res = run(tempDir(t));
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /^SCREENSHOTS_FAILED no readable generated-mockups\/manifest\.json/);
});
