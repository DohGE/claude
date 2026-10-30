#!/usr/bin/env node
'use strict';

// A first pass over the visual comparison of step 5, before any image reaches the agent. The
// agent shoots each state twice - `<id>-mockup.png` and `<id>-app.png` in its screenshots folder -
// and used to Read every pair: 23 pairs on one run, each pair two images in a context that is
// paid for again on every later call. This measures the share of pixels that differ in each pair
// and writes a diff picture: a pair under the threshold matches and is never opened, and for the
// rest the agent opens the diff and the app shot - where it differs is in red - instead of
// hunting through two full screens.
//
// Usage: node visual-diff.cjs --dir=<SESSION>/screenshots [--threshold=0.01]
// Prints per pair `MATCH <id> <ratio>` or `REVIEW <id> <ratio> <diff png>`, then
// `VISUAL_DIFF <pairs> <to review>`; or `VISUAL_DIFF_FAILED <reason>` (FIXED IDENTIFIERS).

const fs = require('node:fs');
const path = require('node:path');

// A channel may differ by this much before the pixel counts as different: anti-aliasing and
// font hinting move every edge by a few levels between two renderers of the same design.
const CHANNEL_TOLERANCE = 32;

function parseArgs(argv) {
  const args = { dir: '', threshold: 0.01 };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'dir') args.dir = m[2];
    else if (m[1] === 'threshold') args.threshold = Number(m[2]);
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!args.dir) throw new Error('--dir=<screenshots folder> is required');
  if (!(args.threshold >= 0 && args.threshold < 1)) throw new Error('--threshold is a share between 0 and 1');
  return args;
}

// The pairs in a folder: every `<id>-mockup.png` that has its `<id>-app.png`.
function pairsIn(dir) {
  const names = new Set(fs.readdirSync(dir));
  return [...names].filter((n) => n.endsWith('-mockup.png')).map((n) => n.slice(0, -'-mockup.png'.length))
    .filter((id) => names.has(`${id}-app.png`)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((id) => ({ id, mockup: path.join(dir, `${id}-mockup.png`), app: path.join(dir, `${id}-app.png`) }));
}

// Two RGBA buffers of the same width and height: how many pixels differ, and a diff picture -
// the app faded to grey, every differing pixel red. Pure, so it runs in the page and in a test.
function comparePixels(a, b, tolerance) {
  const out = new Uint8ClampedArray(a.length);
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    const diff = Math.abs(a[i] - b[i]) > tolerance || Math.abs(a[i + 1] - b[i + 1]) > tolerance
      || Math.abs(a[i + 2] - b[i + 2]) > tolerance || Math.abs(a[i + 3] - b[i + 3]) > tolerance;
    if (diff) {
      differing++;
      out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255;
    } else {
      const grey = Math.round((b[i] + b[i + 1] + b[i + 2]) / 3);
      out[i] = grey; out[i + 1] = grey; out[i + 2] = grey; out[i + 3] = 70;
    }
  }
  return { differing, total: a.length / 4, out };
}

async function diffAll({ dir, threshold }) {
  const pairs = pairsIn(dir);
  if (!pairs.length) return ['VISUAL_DIFF 0 0'];
  let chromium;
  try {
    ({ chromium } = require('@playwright/test'));
  } catch (e) {
    return [`VISUAL_DIFF_FAILED the skill's Playwright is not installed (${String(e.message).split('\n')[0]})`];
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    return [`VISUAL_DIFF_FAILED Chromium did not start (${String(e.message).split('\n')[0]})`];
  }
  const lines = [];
  let review = 0;
  try {
    const page = await browser.newPage();
    for (const pair of pairs) {
      const toUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
      // Different heights are compared on the larger canvas: what one shot has and the other
      // lacks is a difference too.
      const result = await page.evaluate(async ({ mockup, app, tolerance, compareSrc }) => {
        const compare = new Function(`return ${compareSrc}`)();
        const load = (src) => new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('unreadable image'));
          img.src = src;
        });
        const [m, a] = await Promise.all([load(mockup), load(app)]);
        const w = Math.max(m.width, a.width);
        const h = Math.max(m.height, a.height);
        const pixels = (img) => {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, w, h).data;
        };
        const { differing, total, out } = compare(pixels(m), pixels(a), tolerance);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
        return { ratio: differing / total, png: c.toDataURL('image/png') };
      }, { mockup: toUrl(pair.mockup), app: toUrl(pair.app), tolerance: CHANNEL_TOLERANCE, compareSrc: comparePixels.toString() });
      const ratio = result.ratio.toFixed(4);
      if (result.ratio <= threshold) {
        lines.push(`MATCH ${pair.id} ${ratio}`);
        continue;
      }
      const diffFile = path.join(dir, `${pair.id}-diff.png`);
      fs.writeFileSync(diffFile, Buffer.from(result.png.split(',')[1], 'base64'));
      lines.push(`REVIEW ${pair.id} ${ratio} ${diffFile.replace(/\\/g, '/')}`);
      review++;
    }
  } finally {
    await browser.close();
  }
  lines.push(`VISUAL_DIFF ${pairs.length} ${review}`);
  return lines;
}

if (require.main === module) {
  (async () => {
    let lines;
    try {
      lines = await diffAll(parseArgs(process.argv.slice(2)));
    } catch (err) {
      lines = [`VISUAL_DIFF_FAILED ${(err && err.message) || err}`];
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = lines.some((l) => l.startsWith('VISUAL_DIFF_FAILED')) ? 1 : 0;
  })();
}

module.exports = { parseArgs, pairsIn, comparePixels, diffAll, CHANNEL_TOLERANCE };
