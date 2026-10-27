'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snap = require('./storybook-snapshot.cjs');

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

// A built Storybook in miniature: the global bundle as a linked sheet, a component's styles
// injected at render the way Angular does, and the story picked by `?id=`.
function staticStorybook(t) {
  const dir = tempDir(t, 'sb-static-');
  fs.writeFileSync(path.join(dir, 'styles.css'), '.global-bundle { color: green; }\n');
  fs.writeFileSync(path.join(dir, 'iframe.html'), [
    '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body>',
    '<div id="storybook-root"></div>',
    '<script>',
    "const id = new URLSearchParams(location.search).get('id');",
    "const theme = (new URLSearchParams(location.search).get('globals') || '').replace('theme:', '');",
    "if (theme) document.body.classList.add(theme);",
    "const s = document.createElement('style'); s.textContent = '.btn[_ngcontent-ng-c1] { color: red; }'; document.head.appendChild(s);",
    "if (id !== 'components-broken--default') document.getElementById('storybook-root').innerHTML = '<button _ngcontent-ng-c1 class=\"btn ' + (document.body.className) + '\">' + id + '</button>';",
    '</script></body></html>',
  ].join('\n'));
  return dir;
}

test('a story becomes its rendered markup and the component styles it injected - the global bundle stays out', async (t) => {
  const staticDir = staticStorybook(t);
  const task = tempDir(t, 'sb-task-');
  const out = path.join(task, 'generated-mockups');
  let result;
  try {
    result = await snap.snapshotStories({ staticDir, out, ids: ['components-button--primary', 'components-broken--default'], theme: 'dark-mode', timeoutMs: 1500 });
  } catch (err) {
    if (/Chromium did not start|Playwright is not installed/.test(err.message)) return t.skip(err.message);
    throw err;
  }
  assert.strictEqual(result.dir, path.join(task, snap.MARKUP_DIR));
  assert.deepStrictEqual(result.done, ['components-button--primary']);
  assert.strictEqual(result.failed.length, 1);
  assert.match(result.failed[0], /^components-broken--default \(nothing rendered/);
  const markup = fs.readFileSync(path.join(result.dir, 'components-button--primary.html'), 'utf8');
  assert.match(markup, /<button _ngcontent-ng-c1="" class="btn dark-mode">components-button--primary<\/button>/, 'rendered in the theme asked for');
  const css = fs.readFileSync(path.join(out, 'story-components-button--primary.css'), 'utf8');
  assert.match(css, /\.btn\[_ngcontent-ng-c1\]/);
  assert.doesNotMatch(css, /global-bundle/, 'the screens link the project stylesheet for that');
});

test('a folder that is no built Storybook is a failure of the script, said at once', async (t) => {
  const dir = tempDir(t, 'sb-empty-');
  await assert.rejects(snap.snapshotStories({ staticDir: dir, out: dir, ids: ['a--b'] }), /no iframe\.html/);
  await assert.rejects(snap.snapshotStories({ staticDir: staticStorybook(t), out: dir, ids: [] }), /no story id/);
});
