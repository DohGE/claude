'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseReport } = require('./render-report.cjs');
const { score, formatScore } = require('./score-review.cjs');

const key = {
  bait: [
    { id: 'b01', file: 'src/app/layout.actions.ts', text: '`emptyProps()` where there is no payload is compliant.' },
  ],
  findings: [
    { id: 'v001', files: ['src/app/app.config.ts'], instructions: ['app-config'], severity: null, text: '`provideAnimations()` instead of `provideAnimationsAsync()`.' },
    { id: 'v002', files: ['src/app/app.config.ts'], instructions: ['security'], severity: 'critical', text: '`APP_CLIENT_SECRET` is a secret in the diff.' },
    { id: 'v003', files: ['src/main.ts'], instructions: ['general'], severity: null, text: 'the failure is swallowed by `.catch(() => {})`.' },
  ],
  crossFile: [
    { id: 'x01', text: 'Configuration values declared three times: `API_BASE_URL`/`POLL_INTERVAL_MS` in `app.config.ts`.' },
  ],
};

function finding(severity, lines, problem, rule) {
  return [severity, `- **Linia:** ${lines}`, `- **Problem:** ${problem}`, `- **Reguła:** ${rule}`, '- **Expected Result:** Poprawić.', ''];
}

const markdown = [
  '# Code Review: test', '',
  '## skills/codeReview/test-environment/src/app/app.config.ts', '',
  ...finding('🟡 **Medium**', '40', '`provideAnimations()` zamiast wersji async.', 'app-config#7'),
  ...finding('🔴 **High**', '12', 'Sekret `APP_CLIENT_SECRET` w kodzie.', 'security#1'),
  ...finding('⚪ **Low**', '8', '`API_BASE_URL` i `POLL_INTERVAL_MS` zdefiniowane lokalnie.', 'general#3'),
  '## skills/codeReview/test-environment/src/app/layout.actions.ts', '',
  ...finding('⚪ **Low**', '5', '`emptyProps()` zbędne.', 'ngrx-actions#2'),
].join('\n');

test('score matches findings to the key by file, instruction and quoted identifiers', () => {
  const result = score(parseReport(markdown), key);
  assert.deepStrictEqual(result.violations, { found: 2, total: 3 });
  assert.deepStrictEqual(result.crossFile, { found: 1, total: 1 }, 'identifiers alone carry a cross-file entry');
  assert.deepStrictEqual(result.misses.map((entry) => entry.id), ['v003']);
  assert.strictEqual(result.matched, 3);
  assert.deepStrictEqual(result.severityMismatches.map(({ entry, finding: f }) => `${entry.id} ${f.severity}`), ['v002 high']);
  assert.deepStrictEqual(result.baitHits.map(({ bait }) => bait.id), ['b01'], 'an unclaimed finding on compliant code is a bait hit');
  const text = formatScore(result, 5);
  assert.match(text, /^recall: 2\/3 violations \(66\.7%\), cross-file 1\/1$/m);
  assert.match(text, /v003 src\/main\.ts \[general\]/);
  assert.match(text, /layout\.actions\.ts:5 \[ngrx-actions\]/, 'paths are shown relative to the environment');
});

test('the shipped answer key covers only files the environment has', () => {
  const root = path.join(__dirname, '..');
  const shipped = JSON.parse(fs.readFileSync(path.join(root, 'test-key', 'answer-key.json'), 'utf8'));
  const missing = [];
  for (const entry of [...shipped.findings, ...shipped.bait]) {
    for (const file of entry.files || (entry.file ? [entry.file] : [])) {
      if (!fs.existsSync(path.join(root, 'test-environment', file))) missing.push(`${entry.id} ${file}`);
    }
  }
  assert.deepStrictEqual(missing, []);
  assert.ok(shipped.findings.every((entry) => entry.instructions.length), 'every violation names its instruction');
});

test('the shipped answer key expects a finding under every reviewable instruction', () => {
  const root = path.join(__dirname, '..');
  const inKey = new Set(JSON.parse(fs.readFileSync(path.join(root, 'test-key', 'answer-key.json'), 'utf8'))
    .findings.flatMap((entry) => entry.instructions));
  const ids = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith('.md')) ids.push(entry.name.replace(/\.md$/, ''));
    }
  })(path.join(root, 'instructions'));
  // `guidelines` is implement-audience: a review never loads it.
  assert.deepStrictEqual(ids.filter((id) => id !== 'guidelines' && !inKey.has(id)), []);
});
