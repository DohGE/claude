'use strict';

// Writes `lines` into every entry of `answer-key.json`: per file of the entry, the
// line ranges of `test-environment/` where the code the entry quotes in backticks
// stands. score-review.cjs pairs a finding with an entry whose lines its own lines
// overlap, so the match no longer rests on the report quoting the same names.
// An entry that quotes nothing locatable ("no spec", "no landmarks") gets no lines
// for that file and is matched as before. Rerun after editing the key or the
// environment.
//
// Usage: node locate-lines.cjs [--check]   (--check exits 1 when the key is stale)

const fs = require('node:fs');
const path = require('node:path');

const keyPath = path.join(__dirname, 'answer-key.json');
// The environment lives at the repository root of the test-environment branch.
const envDir = path.join(__dirname, '..', '..', '..', 'test-environment');
// A quote found on more lines than this names something everywhere in the file
// (`svc`, `users`), not the defect's place.
const maxHitsPerQuote = 4;

function toRanges(lineNumbers) {
  const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
  const ranges = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n <= last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

function locate(text, source) {
  const lines = source.split(/\r?\n/);
  const found = [];
  for (const [, quote] of String(text).matchAll(/`([^`]+)`/g)) {
    // A quote spanning a line break in the source is looked up by its first line.
    // An elided quote (`'as_live_…'`) is looked up by what precedes the ellipsis.
    const needle = quote.split(/\r?\n/)[0].split('…')[0].trim();
    if (needle.length < 3) continue;
    const hits = [];
    lines.forEach((line, i) => {
      if (line.includes(needle)) hits.push(i + 1);
    });
    if (hits.length && hits.length <= maxHitsPerQuote) found.push(...hits);
  }
  return toRanges(found);
}

function annotate(key) {
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, fs.readFileSync(path.join(envDir, file), 'utf8'));
      } catch {
        cache.set(file, null);
      }
    }
    return cache.get(file);
  };
  for (const entry of key.findings) {
    const lines = {};
    for (const file of entry.files) {
      const source = read(file);
      const ranges = source === null ? [] : locate(entry.text, source);
      if (ranges.length) lines[file] = ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
    }
    if (Object.keys(lines).length) entry.lines = lines;
    else delete entry.lines;
  }
  return key;
}

function main(argv) {
  const before = fs.readFileSync(keyPath, 'utf8');
  const after = `${JSON.stringify(annotate(JSON.parse(before)), null, 1)}\n`;
  if (argv.includes('--check')) return before === after ? 0 : 1;
  fs.writeFileSync(keyPath, after);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { locate, toRanges, annotate };
