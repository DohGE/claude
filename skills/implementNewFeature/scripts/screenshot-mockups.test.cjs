'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { fileNameOf, screenIds } = require('./screenshot-mockups.cjs');

const SCRIPT = path.join(__dirname, 'screenshot-mockups.cjs');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
// A PNG's height, from its IHDR chunk.
const pngHeight = file => fs.readFileSync(file).readUInt32BE(20);

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

test('a screenshot is named <id>-<lm|dm>-<view>-<state>, lowercase ASCII kebab', () => {
  assert.strictEqual(fileNameOf({ view: 'Login', title: 'Empty form' }, '0.0'), '0.0-lm-login-empty-form.png');
  assert.strictEqual(fileNameOf({ view: 'Tape library', title: 'Dialog (dark)' }, '1.1'), '1.1-dm-tape-library-dialog.png',
    'a dark twin says dm, and loses its (dark) suffix');
  assert.strictEqual(fileNameOf({ view: 'Lista: zamówienia', title: 'Błąd <500>?' }, '1.12'),
    '1.12-lm-lista-zamowienia-blad-500.png');
  assert.strictEqual(fileNameOf({ view: 'Raport', title: 'Raport' }, '2.0'), '2.0-lm-raport.png',
    'a view with one state is not named twice');
  assert.strictEqual(fileNameOf({ title: 'Stary manifest.' }, '3.0'), '3.0-lm-stary-manifest.png');
});

test('ids are the manifest\'s own while they are <view>.<state> from 0.0, else numbered afresh', () => {
  const ids = (...list) => screenIds(list.map(id => ({ id, view: 'V', file: 'v.html' })));
  assert.deepStrictEqual(ids('0.0', '0.1', '0.10', '0.99', '9.0'), ['0.0', '0.1', '0.10', '0.99', '9.0']);
  for (const bad of ['10.0', '0.100', '0.01', '00.1', '1', 'login', '', undefined]) {
    assert.deepStrictEqual(ids('0.0', bad), ['0.0', '0.1'], `${bad} is not an id`);
  }
  assert.deepStrictEqual(ids('0.0', '0.0'), ['0.0', '0.1'], 'an id used twice names no file');
  // A manifest from before the numbering: views by name, else by file, in order of first sight.
  assert.deepStrictEqual(screenIds([
    { id: 'login', view: 'Login', file: 'login.html' },
    { id: 'list', file: 'list.html' },
    { id: 'login-error', view: 'Login', file: 'login.html' },
    { file: 'list.html' },
  ]), ['0.0', '1.0', '0.1', '1.1']);
});

test('every state of the manifest becomes one PNG, and the folder holds only this round', t => {
  const task = tempDir(t);
  const mockups = path.join(task, 'generated-mockups');
  fs.mkdirSync(mockups, { recursive: true });
  // One file holds both states of the login view and reads which one to show from the
  // fragment, on load only - so the second state shows only if the page loaded again.
  fs.writeFileSync(path.join(mockups, '0-login.html'), '<h1 id="h">Login</h1><script>'
    + 'h.style.height = location.hash === "#0.1" ? "2000px" : "100px";</script>');
  // The list view reaches for a CDN: the request is aborted, not waited on.
  fs.writeFileSync(path.join(mockups, '1-list.html'),
    '<link rel="stylesheet" href="https://cdn.example.com/x.css"><h1>List</h1>');
  fs.writeFileSync(path.join(mockups, 'manifest.json'), JSON.stringify({ screens: [
    { id: '0.0', view: 'Login', title: 'Empty', file: '0-login.html' },
    { id: '0.1', view: 'Login', title: 'Error', file: '0-login.html' },
    { id: '1.0', view: 'List', title: 'List', file: '1-list.html' },
  ] }));
  const shots = path.join(task, 'mockup-screenshots');
  fs.mkdirSync(shots);
  fs.writeFileSync(path.join(shots, 'stale.png'), 'old round');
  const res = run(task);
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.strictEqual(res.stdout.trim(), `SCREENSHOTS 3 ${shots}`);
  assert.deepStrictEqual(fs.readdirSync(shots).sort(),
    ['0.0-lm-login-empty.png', '0.1-lm-login-error.png', '1.0-lm-list.png']);
  for (const f of fs.readdirSync(shots)) {
    assert.ok(fs.readFileSync(path.join(shots, f)).subarray(0, 4).equals(PNG), `${f} is a PNG`);
  }
  assert.strictEqual(pngHeight(path.join(shots, '0.0-lm-login-empty.png')), 800);
  assert.ok(pngHeight(path.join(shots, '0.1-lm-login-error.png')) > 2000, 'the error state is the one shot');
});

test('without a manifest the script says so on its one line', t => {
  const res = run(tempDir(t));
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /^SCREENSHOTS_FAILED no readable generated-mockups\/manifest\.json/);
});
