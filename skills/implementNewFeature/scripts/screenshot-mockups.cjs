#!/usr/bin/env node
'use strict';
// Screenshots of every state of one task's mockups, for the user to keep or share outside
// the stepper: <taskDir>/mockup-screenshots/<id>-<lm|dm>-<view>-<state>.png, one per entry of
// generated-mockups/manifest.json - every state of every view, numbered <view>.<state> from
// 0.0 - at desktop width and the whole page long. A view's file renders all of its states
// and the URL fragment picks one (references/mockup-agent.md). The folder is emptied
// first, so it always holds exactly the round the review panel shows.
//
// Usage: node screenshot-mockups.cjs <taskDir>
// Prints ONE line (FIXED IDENTIFIERS - the orchestrator matches them):
//   SCREENSHOTS <count> <dir>
//   SCREENSHOTS_FAILED <reason>
//
// The browser is the skill's own Playwright, resolved from this folder, never the
// project's. The screens are served from disk under a made-up origin and every other
// request is aborted - the same promise the review iframe's policy keeps: a screen that
// reaches for a CDN shows the gap here too, and nothing leaves the machine.
const fs = require('fs');
const path = require('path');
const { MOCKUP_DIR, MOCKUP_TYPES, SCREENSHOT_DIR } = require('./server.cjs');

const ORIGIN = 'http://mockups.invalid';
const VIEWPORT = { width: 1280, height: 800 };

// A state's id: <view>.<state>, both counted from 0 - at most 10 views of 100 states each.
// FIXED IDENTIFIER, shared with references/mockup-agent.md.
const SCREEN_ID = /^\d\.(?:\d|[1-9]\d)$/;

// The manifest's own ids when every one is a <view>.<state> and none repeats. Otherwise
// all of them are numbered afresh - views in the order they first appear, states in order
// within each view - so the names still sort and never collide.
function screenIds(screens) {
  const ids = screens.map(s => String(s.id || ''));
  if (ids.every(id => SCREEN_ID.test(id)) && new Set(ids).size === ids.length) return ids;
  const views = [];
  const states = [];
  return screens.map(s => {
    const key = String(s.view || s.file);
    let view = views.indexOf(key);
    if (view < 0) {
      view = views.push(key) - 1;
      states[view] = 0;
    }
    return `${view}.${states[view]++}`;
  });
}

// The dark twin of a state: its title ends in `(dark)` (mockup-agent.md).
const DARK = /\s*\(dark\)\s*$/i;

// `0.0-lm-login-empty-form.png`, `1.1-dm-tape-library-dialog.png`: the id, the theme (lm light,
// dm dark), then the view and state as lowercase ASCII kebab - nothing any file system refuses,
// and the id in front keeps two states with the same titles apart.
function fileNameOf(screen, id) {
  const title = String(screen.title || '');
  const mode = DARK.test(title) ? 'dm' : 'lm';
  const words = [screen.view, title.replace(DARK, '')].map(v => String(v || '').trim()).filter(Boolean);
  const label = words.length === 2 && words[0] === words[1] ? [words[0]] : words;
  const slug = label.join(' ').replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFD')
    .replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 120).replace(/-+$/, '');
  return `${[id, mode, slug].filter(Boolean).join('-')}.png`;
}

// Thrown, never process.exit(): on a pipe the line printed just before an exit can be lost.
const firstLine = e => String(e && e.message || e).split('\n')[0];
function fail(reason) {
  throw new Error(reason);
}

async function main() {
  const taskDir = process.argv[2];
  if (!taskDir) fail('usage: node screenshot-mockups.cjs <taskDir>');
  const src = path.resolve(taskDir, MOCKUP_DIR);
  const out = path.resolve(taskDir, SCREENSHOT_DIR);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  } catch (e) {
    fail(`no readable ${MOCKUP_DIR}/manifest.json (${e.message})`);
  }
  const screens = (Array.isArray(manifest && manifest.screens) ? manifest.screens : [])
    .filter(s => s && typeof s.file === 'string' && s.file === path.basename(s.file));
  if (!screens.length) fail('the manifest lists no screens');
  let chromium;
  try {
    ({ chromium } = require('@playwright/test'));
  } catch (e) {
    fail(`the skill's Playwright is not installed (${firstLine(e)})`);
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    fail(`Chromium did not start (${firstLine(e)})`);
  }
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      const name = decodeURIComponent(url.pathname.slice(1));
      const type = MOCKUP_TYPES[path.extname(name).toLowerCase()];
      if (url.origin !== ORIGIN || !type || name !== path.basename(name)) return route.abort();
      let body;
      try {
        body = fs.readFileSync(path.join(src, name));
      } catch (_e) {
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 200, contentType: type, body });
    });
    const ids = screenIds(screens);
    for (const [i, screen] of screens.entries()) {
      // The states of a view share its file. A new fragment alone would not load the page
      // again, so the query - which the route above ignores - makes every state a fresh load.
      const id = encodeURIComponent(ids[i]);
      await page.goto(`${ORIGIN}/${encodeURIComponent(screen.file)}?state=${id}#${id}`,
        { waitUntil: 'load' });
      await page.screenshot({ path: path.join(out, fileNameOf(screen, ids[i])), fullPage: true });
    }
  } finally {
    await browser.close();
  }
  console.log(`SCREENSHOTS ${screens.length} ${out}`);
}

module.exports = { fileNameOf, screenIds };
if (require.main === module) {
  main().catch(e => {
    console.log(`SCREENSHOTS_FAILED ${firstLine(e)}`);
    process.exitCode = 1;
  });
}
