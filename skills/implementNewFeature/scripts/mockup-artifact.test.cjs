'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ma = require('./mockup-artifact.cjs');

function tempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // best-effort temp cleanup
    }
  });
  return dir;
}

// A task folder after a round: two views of three states, each linking the project stylesheet,
// one of them a story's component styles too.
function round(t) {
  const task = tempDir(t, 'ma-task-');
  const dir = path.join(task, 'generated-mockups');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ screens: [
    { id: '0.0', view: 'Login', title: 'Empty form', file: '0-login.html' },
    { id: '0.1', view: 'Login', title: 'Wrong password', file: '0-login.html' },
    { id: '1.0', view: 'Users', title: 'List', file: '1-users.html' },
    { id: '1.1', view: 'Users', title: 'Escape', file: '../outside.html' },
  ] }));
  fs.writeFileSync(path.join(dir, '0-login.html'), '<link rel="stylesheet" href="project-web.css"><link rel="stylesheet" href="story-btn.css"><h1>Login</h1>');
  fs.writeFileSync(path.join(dir, '1-users.html'), '<link rel="stylesheet" href="project-web.css"><h1>Users</h1>');
  fs.writeFileSync(path.join(dir, 'project-web.css'), 'body { margin: 0; }');
  fs.writeFileSync(path.join(dir, 'story-btn.css'), '.btn { color: red; }');
  fs.writeFileSync(path.join(dir, 'unused.css'), '.x {}');
  return task;
}

test('a round becomes one gallery page and the screens and stylesheets it frames', (t) => {
  const task = round(t);
  const result = ma.buildArtifact(task, { title: 'feature/users' });
  const out = path.join(task, ma.ARTIFACT_DIR);
  assert.strictEqual(result.page, path.join(out, 'index.html'));
  assert.deepStrictEqual(Object.keys(result.files).sort(), ['0-login.html', '1-users.html', 'project-web.css', 'story-btn.css'], 'only what a screen links; nothing outside the folder');
  for (const [name, file] of Object.entries(result.files)) {
    assert.strictEqual(file, path.join(out, name));
    assert.ok(fs.existsSync(file), name);
  }
  assert.strictEqual(result.screens, 3);
  const page = fs.readFileSync(result.page, 'utf8');
  assert.match(page, /<title>Mockup Gallery<\/title>/);
  assert.match(page, /<h1>feature\/users<\/h1>/);
  assert.match(page, /sandbox="allow-scripts"/);
  assert.match(page, /prefers-color-scheme: dark/);
  assert.ok(page.includes('"id":"0.1"') && page.includes('"file":"0-login.html"'));
  assert.ok(!page.includes('outside.html'));
});

test('a task with no round has nothing to publish, and says so', (t) => {
  const task = tempDir(t, 'ma-empty-');
  assert.throws(() => ma.buildArtifact(task), /no readable generated-mockups\/manifest\.json/);
});
