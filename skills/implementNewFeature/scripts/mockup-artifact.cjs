#!/usr/bin/env node
'use strict';
// The round of mockups on screen as a Claude artifact (references/steps/3-mockups.md, the
// "Create Claude artifact" button): one gallery page - the views and their states as tabs, a
// desktop and a mobile width, each state framed the way the stepper's preview frames it
// (`<file>#<id>`, sandboxed scripts) - and the files it frames: every view of the manifest and
// every stylesheet a view links by bare name (the project's own, a story's component styles).
// Only the orchestrator can publish an artifact; this writes what it publishes.
//
// Usage: node mockup-artifact.cjs <taskDir> [--title=<text>]
// Prints ONE line of JSON: { page, files: { "<published name>": "<path>" }, screens } - the
// Artifact tool's `file_path` and `files` - or { error } with exit code 1.
const fs = require('node:fs');
const path = require('node:path');

const MOCKUP_DIR = 'generated-mockups';
const ARTIFACT_DIR = 'mockup-artifact';
// What a view may link by bare name and the gallery carries along.
const reLinked = /(?:href|src)\s*=\s*["']([^"'/\\?#]+\.(?:css|png|svg|jpe?g|webp|gif|woff2?))["']/gi;
const VIEWPORTS = { Desktop: { width: 1280, height: 800 }, Mobile: { width: 390, height: 780 } };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bare = (name) => typeof name === 'string' && name !== '' && name === path.basename(name) && !name.startsWith('.');

function galleryPage({ title, screens }) {
  const data = JSON.stringify({ screens, viewports: VIEWPORTS }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mockup Gallery</title>
<style>
:root { --bg: #f6f7f9; --surface: #ffffff; --fg: #1d2330; --muted: #5f6b7a; --border: #d9dee5; --accent: #2557d6; --accent-fg: #ffffff; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #12151b; --surface: #1b2029; --fg: #e8ebf0; --muted: #9aa5b4; --border: #2e3542; --accent: #7aa2ff; --accent-fg: #0d1117; }
}
:root[data-theme="dark"] { --bg: #12151b; --surface: #1b2029; --fg: #e8ebf0; --muted: #9aa5b4; --border: #2e3542; --accent: #7aa2ff; --accent-fg: #0d1117; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { max-width: 1312px; margin: 0 auto 12px; }
h1 { font-size: 20px; margin: 0 0 4px; overflow-wrap: anywhere; }
header p { margin: 0; color: var(--muted); }
nav { max-width: 1312px; margin: 0 auto 8px; display: flex; flex-wrap: wrap; gap: 6px; }
nav button { border: 1px solid var(--border); background: var(--surface); color: var(--fg); border-radius: 6px; padding: 6px 10px; font: inherit; cursor: pointer; }
nav button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.stage { max-width: 1312px; margin: 0 auto; overflow-x: auto; }
iframe { display: block; margin: 0 auto; max-width: 100%; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
</style>
</head>
<body>
<header>
<h1>${esc(title)}</h1>
<p>${screens.length} state${screens.length === 1 ? '' : 's'} of ${new Set(screens.map((s) => s.file)).size} view${new Set(screens.map((s) => s.file)).size === 1 ? '' : 's'} - pick a view, a state and a width.</p>
</header>
<nav id="views" aria-label="Views"></nav>
<nav id="states" aria-label="States"></nav>
<nav id="widths" aria-label="Width"></nav>
<div class="stage"><iframe id="screen" title="Mockup" sandbox="allow-scripts"></iframe></div>
<script>
const { screens, viewports } = ${data};
const views = [...new Map(screens.map((s) => [s.file, s.view])).entries()];
let file = views.length ? views[0][0] : null;
let id = screens.length ? screens[0].id : null;
let width = 'Desktop';
const buttons = (el, items, pressed, pick) => {
  el.replaceChildren(...items.map(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(key === pressed));
    b.addEventListener('click', () => pick(key));
    return b;
  }));
};
function draw() {
  buttons(document.getElementById('views'), views, file, (key) => { file = key; id = screens.find((s) => s.file === key).id; draw(); });
  buttons(document.getElementById('states'), screens.filter((s) => s.file === file).map((s) => [s.id, s.id + ' ' + s.title]), id, (key) => { id = key; draw(); });
  buttons(document.getElementById('widths'), Object.keys(viewports).map((k) => [k, k]), width, (key) => { width = key; draw(); });
  const frame = document.getElementById('screen');
  frame.width = viewports[width].width;
  frame.height = viewports[width].height;
  if (file) frame.src = encodeURIComponent(file) + '?state=' + encodeURIComponent(id) + '#' + encodeURIComponent(id);
}
draw();
</script>
</body>
</html>
`;
}

function buildArtifact(taskDir, { title = null } = {}) {
  const src = path.join(path.resolve(taskDir), MOCKUP_DIR);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  } catch (e) {
    throw new Error(`no readable ${MOCKUP_DIR}/manifest.json (${String(e.message).split('\n')[0]})`);
  }
  const screens = (Array.isArray(manifest && manifest.screens) ? manifest.screens : [])
    .filter((s) => s && bare(s.file) && fs.existsSync(path.join(src, s.file)))
    .map((s) => ({ id: String(s.id), view: String(s.view || s.file), title: String(s.title || s.id), file: s.file }));
  if (screens.length === 0) throw new Error('the manifest lists no screen this folder holds');
  const out = path.join(path.resolve(taskDir), ARTIFACT_DIR);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const names = new Set(screens.map((s) => s.file));
  for (const view of [...names]) {
    for (const m of fs.readFileSync(path.join(src, view), 'utf8').matchAll(reLinked)) {
      if (bare(m[1]) && fs.existsSync(path.join(src, m[1]))) names.add(m[1]);
    }
  }
  const files = {};
  for (const name of [...names].sort()) {
    fs.copyFileSync(path.join(src, name), path.join(out, name));
    files[name] = path.join(out, name);
  }
  const page = path.join(out, 'index.html');
  fs.writeFileSync(page, galleryPage({ title: title || 'Mockups', screens }));
  return { page, files, screens: screens.length };
}

module.exports = { buildArtifact, galleryPage, ARTIFACT_DIR };

if (require.main === module) {
  const argv = process.argv.slice(2);
  let title = null;
  const positional = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m && m[1] === 'title') title = m[2];
    else if (!m) positional.push(arg);
  }
  try {
    if (!positional[0]) throw new Error('usage: node mockup-artifact.cjs <taskDir> [--title=<text>]');
    process.stdout.write(`${JSON.stringify(buildArtifact(positional[0], { title }))}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: String(e.message).split('\n')[0] })}\n`);
    process.exitCode = 1;
  }
}
