#!/usr/bin/env node
'use strict';
// Screenshots of every screen of one task's mockups, for the user to keep or share outside
// the stepper: <taskDir>/mockup-screenshots/<id> <view> - <case>.png, one per screen of
// generated-mockups/manifest.json, at desktop width and the whole page long. The folder is
// emptied first, so it always holds exactly the round the review panel shows.
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

// `1.0 Login - Empty form.png`. Windows refuses a handful of characters and a trailing dot
// or space, so they go; the id in front keeps two screens with the same titles apart.
function fileNameOf(screen, index) {
  const id = String(screen.id || index + 1);
  const words = [screen.view, screen.title].map(v => String(v || '').trim()).filter(Boolean);
  const label = words.length === 2 && words[0] === words[1] ? [words[0]] : words;
  const name = `${id} ${label.join(' - ')}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 150).replace(/[. ]+$/, '');
  return `${name || index + 1}.png`;
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
    for (const [i, screen] of screens.entries()) {
      await page.goto(`${ORIGIN}/${encodeURIComponent(screen.file)}`, { waitUntil: 'load' });
      await page.screenshot({ path: path.join(out, fileNameOf(screen, i)), fullPage: true });
    }
  } finally {
    await browser.close();
  }
  console.log(`SCREENSHOTS ${screens.length} ${out}`);
}

module.exports = { fileNameOf };
if (require.main === module) {
  main().catch(e => {
    console.log(`SCREENSHOTS_FAILED ${firstLine(e)}`);
    process.exitCode = 1;
  });
}
