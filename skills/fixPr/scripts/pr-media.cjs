#!/usr/bin/env node
'use strict';

// The screenshots and recordings reviewers attach to their comments, downloaded next to the
// comments file so the fixing agent can look at them (the Read tool shows an image; a video
// becomes a few still frames it can show the same way).
//
// Why: on 2026-11-05 a review of DPXN-11967 part-4 said "add padding to the checkbox details"
// over a screenshot and "the selected row should remain highlighted" over a screen recording.
// The agent read two sentences and a URL; the user had to send the same pictures again by hand
// before the fix landed where the reviewer meant.
//
// Everything here is synchronous towards its caller (pr-comments.cjs is), so the network and
// the browser run in a child copy of this file, as github.cjs does for the API.
//
// Child modes (internal):
//   node pr-media.cjs --fetch   < {"url","dest","token","maxBytes"}   -> one JSON line
//   node pr-media.cjs --frames  < {"video","outDir","max","playwright"} -> one JSON line

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const maxBytesDefault = 40 * 1024 * 1024;
const maxMediaPerPr = 12;
const maxFrames = 8;
const fetchTimeoutMs = 90000;

// Hosts GitHub serves attachments from. The token goes only to github.com itself: a signed
// S3 URL rejects an extra Authorization header, and nothing else should ever see the token.
const attachmentHost = /^https:\/\/(?:github\.com\/(?:user-attachments\/(?:assets|files)\/|[^/\s]+\/[^/\s]+\/(?:assets|files)\/)|(?:private-)?user-images\.githubusercontent\.com\/|objects\.githubusercontent\.com\/|camo\.githubusercontent\.com\/)/i;
const tokenHost = /^https:\/\/(?:github\.com|api\.github\.com)\//i;
const videoExt = /\.(?:mp4|mov|webm|mkv|m4v|avi)(?:[?#]|$)/i;
const imageExt = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#]|$)/i;

const kindOf = (url, contentType = '') => {
  if (/^video\//i.test(contentType) || videoExt.test(url)) return 'video';
  if (/^image\//i.test(contentType) || imageExt.test(url)) return 'image';
  return 'unknown';
};

// Every attachment a comment body points at, in order, once: `<img src>`, `<video src>`,
// `<source src>`, markdown `![..](..)`, and the bare `user-attachments` URL a dropped video
// becomes in the editor.
function mediaUrls(body) {
  const text = String(body || '');
  const found = [];
  const add = (raw, hint) => {
    const url = String(raw || '').trim().replace(/[)>.,;]+$/, '');
    if (!attachmentHost.test(url) || found.some((f) => f.url === url)) return;
    found.push({ url, kind: hint || kindOf(url) });
  };
  const patterns = [
    [/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi, 'image'],
    [/<video\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi, 'video'],
    [/<source\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi, 'video'],
    [/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, 'image'],
    [/(https:\/\/[^\s"'<>()\]]+)/g, null],
  ];
  // Positions keep the body's order across the patterns.
  const hits = [];
  for (const [re, hint] of patterns) {
    for (const m of text.matchAll(re)) hits.push({ at: m.index, url: m[1], hint });
  }
  hits.sort((a, b) => a.at - b.at || (a.hint ? -1 : 1));
  for (const h of hits) add(h.url, h.hint);
  return found;
}

// The signed, short-lived URLs GitHub renders into a body's HTML for a private repository -
// `private-user-images.githubusercontent.com/...?jwt=...` - in the order they appear.
function signedUrlsFromHtml(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/\b(?:src|href|data-canonical-src)\s*=\s*["'](https:\/\/[^"']+)["']/gi)) {
    const url = m[1].replace(/&amp;/g, '&');
    if (/^https:\/\/(?:private-user-images|user-images|objects)\.githubusercontent\.com\//i.test(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

const extOf = (contentType, url, kind) => {
  const byType = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
  }[String(contentType || '').split(';')[0].trim().toLowerCase()];
  if (byType) return byType;
  const m = String(url).split(/[?#]/)[0].match(/\.(png|jpe?g|gif|webp|svg|mp4|mov|webm|mkv)$/i);
  if (m) return `.${m[1].toLowerCase()}`;
  return kind === 'video' ? '.mp4' : '.png';
};

function child(mode, payload, timeout) {
  const res = spawnSync(process.execPath, [__filename, mode], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  try {
    return JSON.parse(String(res.stdout || '').trim().split(/\r?\n/).pop());
  } catch {
    return { ok: false, error: String(res.stderr || res.error || `child exited ${res.status}`).trim().split(/\r?\n/).pop() };
  }
}

// One download into `dest`, following redirects. The answer says what came back, so a login
// page served with 200 (`text/html`) is told apart from the picture that was asked for.
function fetchFile({ url, dest, token, maxBytes = maxBytesDefault }) {
  return child('--fetch', { url, dest, token: tokenHost.test(url) ? token || null : null, maxBytes }, fetchTimeoutMs + 5000);
}

// Where a browser that plays H.264 can come from: the plugin's own Playwright, driving the
// installed Chrome first (GitHub recordings are mp4/H.264, which Playwright's Chromium lacks).
function playwrightCore(skillDir) {
  const candidates = [
    path.join(skillDir, '..', 'implementNewFeature', 'node_modules', 'playwright-core'),
    path.join(skillDir, 'node_modules', 'playwright-core'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'package.json'))) || null;
}

function ffmpegBinary() {
  if (process.env.DOH_FFMPEG && fs.existsSync(process.env.DOH_FFMPEG)) return process.env.DOH_FFMPEG;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  const first = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return probe.status === 0 && first ? first : null;
}

// Up to `max` still frames of a recording, as PNG files the Read tool can show. ffmpeg when the
// machine has one (or DOH_FFMPEG names it); otherwise a browser seeks the video and draws it.
function extractFrames(video, outDir, { max = maxFrames, skillDir = path.resolve(__dirname, '..') } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(video).replace(/\.[^.]+$/, '');
  const ffmpeg = ffmpegBinary();
  if (ffmpeg) {
    const pattern = path.join(outDir, `${base}-frame-%02d.png`);
    const res = spawnSync(ffmpeg, ['-v', 'error', '-y', '-i', video, '-vf', "fps=1,scale='min(1280,iw)':-2", '-frames:v', String(max), pattern], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const frames = fs.readdirSync(outDir).filter((f) => f.startsWith(`${base}-frame-`) && f.endsWith('.png')).sort().map((f) => path.join(outDir, f));
    if (res.status === 0 && frames.length > 0) return { frames, via: 'ffmpeg', error: null };
  }
  const core = playwrightCore(skillDir);
  if (!core) return { frames: [], via: null, error: 'no ffmpeg on PATH (or DOH_FFMPEG) and no Playwright in the plugin to draw the frames with' };
  const answer = child('--frames', { video, outDir, base, max, playwright: core }, 180000);
  return { frames: answer.frames || [], via: answer.via || null, error: answer.ok ? null : answer.error || 'the browser could not play the video' };
}

// The rendered HTML of a comment, a thread reply or a review: where a private repository's
// attachments come signed. `kind`: issue-comment | review-comment | review.
function bodyHtmlOf(project, { slug, prNumber, kind, id }, request) {
  if (!slug || id == null) return null;
  const pathFor = {
    'issue-comment': `/repos/${slug.owner}/${slug.repo}/issues/comments/${id}`,
    'review-comment': `/repos/${slug.owner}/${slug.repo}/pulls/comments/${id}`,
    review: `/repos/${slug.owner}/${slug.repo}/pulls/${prNumber}/reviews/${id}`,
  }[kind];
  if (!pathFor) return null;
  const res = request(project, { path: pathFor, accept: 'application/vnd.github.full+json' });
  return res && res.ok && res.json ? res.json.body_html || null : null;
}

// Downloads the attachments of `items` (`{ key, kind, id, body }`) into `dir` and answers a
// Map key -> media entries: `{ url, kind, path, frames?, framesVia?, error? }`. Never throws:
// an attachment that cannot be fetched travels with its `error`, and the agent still has the
// words of the comment.
function collectMedia({ project, slug, prNumber, items, dir, token = null, request, fetch = fetchFile, frames = extractFrames, limit = maxMediaPerPr }) {
  const out = new Map();
  const warnings = [];
  let budget = limit;
  let cleared = false;
  for (const item of items) {
    const urls = mediaUrls(item.body);
    if (urls.length === 0) continue;
    if (!cleared) {
      // The folder is this run's alone: a stale picture of an earlier run must not pose as one
      // of this review's.
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      cleared = true;
    }
    let signed = null;
    const entries = [];
    urls.forEach((found, index) => {
      if (budget <= 0) {
        entries.push({ url: found.url, kind: found.kind, path: null, error: `not downloaded: more than ${limit} attachments on this pull request` });
        return;
      }
      budget -= 1;
      const stem = `${String(item.key).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40)}-${index + 1}`;
      const tmp = path.join(dir, `${stem}.download`);
      let got = fetch({ url: found.url, dest: tmp, token: tokenHost.test(found.url) ? token : null });
      const html = got && /text\/html/i.test(String(got.contentType || ''));
      if (!got || !got.ok || html) {
        // A private repository answers the plain URL with a login page or 404; the comment's
        // rendered HTML holds a signed copy of the same attachment, in the same order.
        if (signed === null) signed = signedUrlsFromHtml(request ? bodyHtmlOf(project, { slug, prNumber, kind: item.kind, id: item.id }, request) : null);
        const alt = signed[index] || (signed.length === 1 ? signed[0] : null);
        if (alt) got = fetch({ url: alt, dest: tmp, token: null });
      }
      if (!got || !got.ok || /text\/html/i.test(String(got.contentType || ''))) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* nothing written */ }
        entries.push({ url: found.url, kind: found.kind, path: null, error: (got && got.error) || `HTTP ${(got && got.status) || 0}${html ? ' (a page, not the attachment: the token may not see it)' : ''}` });
        return;
      }
      const kind = kindOf(found.url, got.contentType) === 'unknown' ? found.kind : kindOf(found.url, got.contentType);
      const file = path.join(dir, `${stem}${extOf(got.contentType, found.url, kind)}`);
      fs.renameSync(tmp, file);
      const entry = { url: found.url, kind, path: file.replace(/\\/g, '/') };
      if (kind === 'video') {
        const shot = frames(file, path.join(dir, `${stem}-frames`));
        entry.frames = shot.frames.map((f) => f.replace(/\\/g, '/'));
        if (shot.via) entry.framesVia = shot.via;
        if (shot.error) entry.error = `no frames: ${shot.error}`;
      }
      entries.push(entry);
    });
    if (entries.some((e) => e.error)) warnings.push(`${item.key}: ${entries.filter((e) => e.error).length} of ${entries.length} attachment(s) could not be prepared (${entries.find((e) => e.error).error}).`);
    out.set(item.key, entries);
  }
  return { media: out, warnings };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function serveFetch() {
  let out;
  try {
    const req = JSON.parse(await readStdin());
    const headers = { 'user-agent': 'doh-fixpr-media', accept: '*/*' };
    if (req.token) headers.authorization = `Bearer ${req.token}`;
    const res = await fetch(req.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(fetchTimeoutMs) });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      out = { ok: false, status: res.status, contentType, error: `HTTP ${res.status}` };
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > req.maxBytes) {
        out = { ok: false, status: res.status, contentType, error: `larger than ${Math.round(req.maxBytes / 1048576)} MB` };
      } else {
        fs.mkdirSync(path.dirname(req.dest), { recursive: true });
        fs.writeFileSync(req.dest, buf);
        out = { ok: true, status: res.status, contentType, bytes: buf.length, finalUrl: res.url };
      }
    }
  } catch (err) {
    out = { ok: false, status: 0, error: String((err && err.message) || err) };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

async function serveFrames() {
  let out = { ok: false, frames: [], error: 'not started' };
  let browser = null;
  try {
    const req = JSON.parse(await readStdin());
    const { chromium } = require(req.playwright);
    const tries = [{ channel: 'chrome', via: 'chrome' }, { channel: 'msedge', via: 'msedge' }, { via: 'chromium' }];
    let lastError = null;
    for (const t of tries) {
      try {
        browser = await chromium.launch(t.channel ? { channel: t.channel } : {});
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        // A page of its own next to the video, opened as a file: a video under file:// does not
        // load into about:blank, and a screenshot of the element needs no canvas (which a
        // file:// video would taint).
        const html = path.join(req.outDir, `${req.base}-player.html`);
        fs.writeFileSync(html, `<html><body style="margin:0;background:#000"><video id="v" muted preload="auto" style="display:block;max-width:1280px;max-height:800px" src="${encodeURI(path.basename(req.video))}"></video></body></html>`);
        fs.copyFileSync(req.video, path.join(req.outDir, path.basename(req.video)));
        await page.goto(`file:///${html.replace(/\\/g, '/').replace(/^\/+/, '')}`);
        const meta = await page.evaluate(() => new Promise((resolve) => {
          const v = document.getElementById('v');
          const done = () => resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight, error: v.error ? v.error.code : null });
          if (v.readyState >= 1) done();
          v.addEventListener('loadedmetadata', done, { once: true });
          v.addEventListener('error', done, { once: true });
          setTimeout(done, 15000);
        }));
        if (!meta.duration || !meta.width) throw new Error(`the browser could not decode it (${t.via}${meta.error ? `, media error ${meta.error}` : ''})`);
        const count = Math.max(1, Math.min(req.max, Math.ceil(meta.duration)));
        const frames = [];
        for (let i = 0; i < count; i += 1) {
          const at = count === 1 ? 0 : (meta.duration * (i + 0.5)) / count;
          await page.evaluate((time) => new Promise((resolve) => {
            const v = document.getElementById('v');
            v.addEventListener('seeked', () => resolve(), { once: true });
            setTimeout(resolve, 5000);
            v.currentTime = time;
          }), at);
          const file = path.join(req.outDir, `${req.base}-frame-${String(i + 1).padStart(2, '0')}.png`);
          await page.locator('#v').screenshot({ path: file });
          frames.push(file);
        }
        fs.rmSync(html, { force: true });
        fs.rmSync(path.join(req.outDir, path.basename(req.video)), { force: true });
        out = { ok: true, frames, via: t.via };
        break;
      } catch (err) {
        lastError = String((err && err.message) || err).split(/\r?\n/)[0];
        if (browser) await browser.close().catch(() => {});
        browser = null;
      }
    }
    if (!out.ok) out = { ok: false, frames: [], error: lastError || 'no browser could play the video' };
  } catch (err) {
    out = { ok: false, frames: [], error: String((err && err.message) || err).split(/\r?\n/)[0] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

module.exports = { mediaUrls, signedUrlsFromHtml, collectMedia, fetchFile, extractFrames, bodyHtmlOf, kindOf, extOf, maxMediaPerPr };

if (require.main === module) {
  if (process.argv[2] === '--fetch') serveFetch();
  else if (process.argv[2] === '--frames') serveFrames();
}
