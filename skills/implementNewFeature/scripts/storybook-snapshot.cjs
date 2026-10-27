#!/usr/bin/env node
'use strict';
// Stories of a built Storybook as the mockup agent's building blocks (references/mockup-agent.md,
// "The project's own styling"): each story is opened the way Storybook's canvas opens it
// (`iframe.html?id=<id>&viewMode=story`), and what it rendered is written down - its markup to
// `<task>/storybook-snapshots/<id>.html`, for the agent to read and paste into a screen, and the
// component styles the page injected (Angular's encapsulated `<style>` tags, its attribute
// selectors included) to `generated-mockups/story-<id>.css`, for the screen to link. The global
// bundle stays out: every screen links the project's own stylesheet (project-styles.cjs) for that.
//
// Usage: node storybook-snapshot.cjs --static=<built storybook> --out=<generated-mockups dir> --story=<id>[,<id>…] [--theme=<class>]
// Prints ONE line (FIXED IDENTIFIERS - the agent matches them):
//   STORY_SNAPSHOTS <count> <markup dir>[; failed: <id> (<reason>), …]
//   STORY_SNAPSHOTS_FAILED <reason>
//
// The browser is the skill's own Playwright. The build is served from disk under a made-up origin
// and every other request is aborted, so nothing leaves the machine.
const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = 'http://storybook.invalid';
const MARKUP_DIR = 'storybook-snapshots';
const VIEWPORT = { width: 1280, height: 800 };
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const firstLine = (e) => String((e && e.message) || e).split('\n')[0];
const safeName = (id) => String(id).replace(/[^\w.-]+/g, '-');

async function snapshotStories({ staticDir, out, ids, theme = null, timeoutMs = 30000 }) {
  const root = path.resolve(staticDir);
  if (!fs.existsSync(path.join(root, 'iframe.html'))) throw new Error(`no iframe.html in ${root} - not a built Storybook`);
  if (!ids || ids.length === 0) throw new Error('no story id given (--story=<id>[,<id>…], from storybook-index.json)');
  let chromium;
  try {
    ({ chromium } = require('@playwright/test'));
  } catch (e) {
    throw new Error(`the skill's Playwright is not installed (${firstLine(e)})`);
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    throw new Error(`Chromium did not start (${firstLine(e)})`);
  }
  const markupDir = path.join(path.dirname(path.resolve(out)), MARKUP_DIR);
  fs.mkdirSync(markupDir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const done = [];
  const failed = [];
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (path.relative(root, file).startsWith('..')) return route.abort();
      let body;
      try {
        body = fs.readFileSync(file);
      } catch {
        return route.fulfill({ status: 404, body: '' });
      }
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', body });
    });
    for (const id of ids) {
      const globals = theme ? `&globals=${encodeURIComponent(`theme:${theme}`)}` : '';
      try {
        await page.goto(`${ORIGIN}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story${globals}`, { waitUntil: 'load' });
        await page.waitForFunction(() => {
          const rendered = document.querySelector('#storybook-root') || document.querySelector('#root');
          return !!rendered && rendered.children.length > 0;
        }, null, { timeout: timeoutMs });
      } catch (e) {
        failed.push(`${id} (nothing rendered in ${timeoutMs / 1000} s: ${firstLine(e).slice(0, 80)})`);
        continue;
      }
      const { markup, css } = await page.evaluate(() => {
        const rendered = document.querySelector('#storybook-root') || document.querySelector('#root');
        // Only the <style> tags: the components' own styles. The linked global bundle is the
        // project stylesheet every screen already links.
        const sheets = [...document.querySelectorAll('style')].map((el) => {
          try {
            return [...el.sheet.cssRules].map((rule) => rule.cssText).join('\n');
          } catch {
            return el.textContent || '';
          }
        });
        return { markup: rendered.innerHTML, css: sheets.join('\n') };
      });
      fs.writeFileSync(path.join(markupDir, `${safeName(id)}.html`), `<!-- story ${id}${theme ? `, theme ${theme}` : ''}: its rendered markup -->\n${markup}\n`);
      fs.writeFileSync(path.join(out, `story-${safeName(id)}.css`), `/* story ${id}: the component styles it rendered with */\n${css}\n`);
      done.push(id);
    }
  } finally {
    await browser.close();
  }
  return { dir: markupDir, done, failed };
}

function parseArgs(argv) {
  const args = { staticDir: '', out: '', ids: [], theme: null };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'static') args.staticDir = m[2];
    else if (m[1] === 'out') args.out = m[2];
    else if (m[1] === 'story') args.ids = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'theme') args.theme = m[2] || null;
  }
  return args;
}

module.exports = { snapshotStories, parseArgs, MARKUP_DIR, ORIGIN };

if (require.main === module) {
  snapshotStories(parseArgs(process.argv.slice(2)))
    .then(({ dir, done, failed }) => {
      console.log(`STORY_SNAPSHOTS ${done.length} ${dir}${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
    })
    .catch((e) => {
      console.log(`STORY_SNAPSHOTS_FAILED ${firstLine(e)}`);
      process.exitCode = 1;
    });
}
