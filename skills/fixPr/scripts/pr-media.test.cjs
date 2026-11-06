'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const media = require('./pr-media.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

test('mediaUrls finds every attachment once, in the order of the body, and nothing else', () => {
  const body = [
    'During testing:',
    '<img width="1031" alt="Image" src="https://github.com/user-attachments/assets/d7106ca0-1" />',
    '![shot](https://user-images.githubusercontent.com/1/2.png)',
    'https://github.com/user-attachments/assets/f0d9-video',
    'docs: https://angular.dev/guide and again https://github.com/user-attachments/assets/d7106ca0-1',
    '<video src="https://github.com/acme/app/assets/12/abc.mp4"></video>',
  ].join('\n');
  assert.deepStrictEqual(media.mediaUrls(body), [
    { url: 'https://github.com/user-attachments/assets/d7106ca0-1', kind: 'image' },
    { url: 'https://user-images.githubusercontent.com/1/2.png', kind: 'image' },
    { url: 'https://github.com/user-attachments/assets/f0d9-video', kind: 'unknown' },
    { url: 'https://github.com/acme/app/assets/12/abc.mp4', kind: 'video' },
  ]);
  assert.deepStrictEqual(media.mediaUrls('no pictures, https://example.com/a.png'), []);
});

test('signedUrlsFromHtml keeps the signed copies a private repository renders, in order', () => {
  const html = '<p><a href="https://private-user-images.githubusercontent.com/1/a.png?jwt=x&amp;y=1"><img src="https://private-user-images.githubusercontent.com/1/a.png?jwt=x&amp;y=1"></a>'
    + '<video src="https://private-user-images.githubusercontent.com/1/b.mp4?jwt=z"></video><a href="https://example.com">x</a></p>';
  assert.deepStrictEqual(media.signedUrlsFromHtml(html), [
    'https://private-user-images.githubusercontent.com/1/a.png?jwt=x&y=1',
    'https://private-user-images.githubusercontent.com/1/b.mp4?jwt=z',
  ]);
});

test('collectMedia falls back to the signed copy, turns a video into frames and reports what failed', (t) => {
  const dir = path.join(fs.realpathSync(tempDir(t, 'fpm-')), 'media');
  const calls = [];
  const fetch = ({ url, dest, token }) => {
    calls.push([url, token]);
    if (url.startsWith('https://github.com/')) return { ok: true, status: 200, contentType: 'text/html; charset=utf-8' };
    if (url.includes('missing')) return { ok: false, status: 404, error: 'HTTP 404' };
    fs.writeFileSync(dest, 'bytes');
    return { ok: true, status: 200, contentType: url.includes('.mp4') ? 'video/mp4' : 'image/png' };
  };
  const request = (project, req) => ({ ok: true, json: { body_html: req.path === '/repos/o/r/pulls/7/reviews/3' ? '<img src="https://private-user-images.githubusercontent.com/1/a.png?jwt=1"><video src="https://private-user-images.githubusercontent.com/1/b.mp4?jwt=2"></video>' : '<p>no attachments rendered</p>' } });
  const frames = (file, out) => ({ frames: [path.join(out, 'f-01.png')], via: 'ffmpeg', error: null });
  const { media: out, warnings } = media.collectMedia({
    project: '/p', slug: { owner: 'o', repo: 'r' }, prNumber: 7, dir, token: 'T', request, fetch, frames,
    items: [
      { key: 'review-3', kind: 'review', id: 3, body: '<img src="https://github.com/user-attachments/assets/a1">\nhttps://github.com/user-attachments/assets/v2' },
      { key: 'conversation-9', kind: 'issue-comment', id: 9, body: '![x](https://user-images.githubusercontent.com/missing.png)' },
    ],
  });
  const review = out.get('review-3');
  assert.deepStrictEqual(review.map((e) => e.kind), ['image', 'video']);
  assert.ok(review[0].path.endsWith('/review-3-1.png'));
  assert.ok(review[1].path.endsWith('/review-3-2.mp4'));
  assert.strictEqual(review[1].frames.length, 1);
  assert.strictEqual(review[1].framesVia, 'ffmpeg');
  assert.ok(fs.existsSync(review[0].path));
  // The token goes to github.com only, never to a signed URL.
  assert.deepStrictEqual(calls.filter(([u]) => !u.startsWith('https://github.com/')).map(([, tok]) => tok), [null, null, null]);
  assert.match(out.get('conversation-9')[0].error, /HTTP 404/);
  assert.strictEqual(warnings.length, 1);
});

test('collectMedia stops downloading past the per-pull-request cap and says so', (t) => {
  const dir = path.join(fs.realpathSync(tempDir(t, 'fpm-')), 'media');
  const fetch = ({ dest }) => { fs.writeFileSync(dest, 'b'); return { ok: true, status: 200, contentType: 'image/png' }; };
  const body = [1, 2, 3].map((n) => `![](https://user-images.githubusercontent.com/${n}.png)`).join(' ');
  const { media: out } = media.collectMedia({ project: '/p', slug: null, prNumber: 1, dir, fetch, items: [{ key: 'c', kind: 'issue-comment', id: 1, body }], limit: 2 });
  assert.deepStrictEqual(out.get('c').map((e) => Boolean(e.path)), [true, true, false]);
  assert.match(out.get('c')[2].error, /more than 2 attachments/);
});
