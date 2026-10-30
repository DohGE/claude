'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, postRound } = require('./mockup-round.cjs');

function taskDir(t, { summary = 'Two views, light and dark.', screens = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-round-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mockups = path.join(dir, 'generated-mockups');
  fs.mkdirSync(mockups);
  fs.writeFileSync(path.join(mockups, 'manifest.json'), JSON.stringify({ screens: screens || [
    { id: '0.0', view: 'Media', title: 'List', file: '0-media.html', extra: 'dropped' },
    { id: '0.1', view: 'Media', title: 'List (dark)', file: '0-media.html' }] }));
  if (summary) fs.writeFileSync(path.join(mockups, 'round.md'), `${summary}\n`);
  return dir;
}

const base = (dir, extra = {}) => ({ taskDir: dir, port: 9999, task: 't2', round: 2, artifactUrl: '', artifactNote: '', allowExternal: false, ...extra });

test('one call posts the screens of the manifest, the round\'s summary and the progress', async (t) => {
  const dir = taskDir(t);
  let sent = null;
  const lines = await postRound(base(dir, { artifactUrl: 'https://claude.ai/artifact/x' }), {
    screenshots: () => ({ shot: 'SCREENSHOTS 2 /s/mockup-screenshots', external: '' }),
    post: async (port, body) => { sent = { port, body }; return { status: 200, text: '{"ok":true}' }; },
  });
  assert.deepStrictEqual(lines, ['ROUND_POSTED 2', 'SCREENSHOTS 2 /s/mockup-screenshots']);
  assert.strictEqual(sent.port, 9999);
  assert.deepStrictEqual(sent.body.mockupReview.screens.map((s) => Object.keys(s).join(',')), ['id,view,title,file', 'id,view,title,file']);
  assert.strictEqual(sent.body.mockupReview.text, 'Two views, light and dark.');
  assert.strictEqual(sent.body.progress, 40);
  assert.strictEqual(sent.body.mockupArtifact, 'https://claude.ai/artifact/x');
  assert.match(sent.body.mockupChat.text, /Claude artifact updated: https:\/\/claude\.ai\/artifact\/x$/);
});

test('a round that loads files it does not inline is held back unless allowed', async (t) => {
  const dir = taskDir(t);
  const shots = () => ({ shot: 'SCREENSHOTS 2 /s', external: 'EXTERNAL_REFS 1 project-dpx.css' });
  const held = await postRound(base(dir), { screenshots: shots, post: async () => assert.fail('never posted') });
  assert.deepStrictEqual(held, ['ROUND_HELD 1 project-dpx.css', 'SCREENSHOTS 2 /s']);
  let sent = null;
  const posted = await postRound(base(dir, { allowExternal: true }), { screenshots: shots,
    post: async (port, body) => { sent = body; return { status: 200, text: '' }; } });
  assert.strictEqual(posted[0], 'ROUND_POSTED 2');
  assert.match(sent.mockupChat.text, /project-dpx\.css/);
});

test('a failed screenshot run still posts the round, and says why', async (t) => {
  const dir = taskDir(t, { summary: '' });
  let sent = null;
  const lines = await postRound(base(dir, { round: 9 }), {
    screenshots: () => ({ shot: 'SCREENSHOTS_FAILED Chromium did not start (x)', external: '' }),
    post: async (port, body) => { sent = body; return { status: 200, text: '' }; },
  });
  assert.strictEqual(lines[0], 'ROUND_POSTED 2');
  assert.strictEqual(sent.progress, 90);
  assert.strictEqual(sent.mockupReview.text, 'Mockups, round 9.');
  assert.match(sent.mockupChat.text, /Screenshots could not be taken: Chromium did not start/);
});

test('no manifest, no round', async (t) => {
  const dir = taskDir(t, { screens: [] });
  assert.deepStrictEqual(await postRound(base(dir), { screenshots: () => assert.fail(), post: async () => assert.fail() }),
    ['ROUND_FAILED the manifest lists no screens']);
  assert.throws(() => parseArgs(['--task-dir=/s', '--port=9999', '--task=t1']), /--round/);
});
