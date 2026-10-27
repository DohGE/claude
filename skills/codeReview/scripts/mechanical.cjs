'use strict';

// Which files of a target the diff changed only mechanically (references/walk.md, the
// mechanical-change gate): renamed or moved, imports repointed, reformatted, or the words the
// target's own renames replaced, replaced. Such a file is walked by the gate's two questions,
// not by its checklist - but its walker used to find that out alone, from a full bundle, on the
// session's model: a 52-file rename branch whose 45 files were mechanical took 46% of a run's
// tokens for three Medium findings (2026-10-27). The script says so first; the walker checks it.
//
// Conservative by design: a word is learned only from a renamed path, a line counts only when
// the whole file is explained, and anything else is behaviour - a wrong "mechanical" would skip
// a logic review, a missed one costs only a fuller walk.

// The shortest word a rename may teach: `v1` -> `v2` would rewrite half the identifiers.
const minWordLength = 3;
// How many places of the old words a bundle names.
const leftoverLimit = 12;

const wordsOf = (segment) => segment.split(/[-_.]/).filter(Boolean);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `{ old: new }`, lower case, from every rename whose old and new path have the same folders
// and words but some: `minio-volume/minio-volume.component.ts` -> `s3-volume/...` teaches minio -> s3.
// A word replaced two ways teaches nothing.
function substitutionMap(files) {
  const learned = new Map();
  const ambiguous = new Set();
  for (const file of files) {
    if (!file.oldPath || !/^[RC]/.test(file.status || '')) continue;
    const from = file.oldPath.split('/');
    const to = file.path.split('/');
    if (from.length !== to.length) continue;
    from.forEach((segment, i) => {
      if (segment === to[i]) return;
      const a = wordsOf(segment);
      const b = wordsOf(to[i]);
      if (a.length !== b.length) return;
      a.forEach((word, k) => {
        const old = word.toLowerCase();
        const neu = b[k].toLowerCase();
        if (old === neu || old.length < minWordLength) return;
        if (learned.has(old) && learned.get(old) !== neu) ambiguous.add(old);
        learned.set(old, neu);
      });
    });
  }
  for (const word of ambiguous) learned.delete(word);
  return Object.fromEntries(learned);
}

// `line` with every old word replaced, in the casing of the spot: `MINIO` -> `S3`, `MinIO` and
// `Minio` -> `S3`, `minio` -> `s3`.
function applyMap(line, map) {
  let out = line;
  for (const [old, neu] of Object.entries(map)) {
    out = out.replace(new RegExp(escape(old), 'gi'), (spot) => {
      if (spot.length > 1 && spot === spot.toUpperCase()) return neu.toUpperCase();
      if (spot[0] !== spot[0].toLowerCase()) return neu.charAt(0).toUpperCase() + neu.slice(1);
      return neu;
    });
  }
  return out;
}

// An import or re-export statement, or a line of a multi-line one that names only its source.
const isImportLine = (line) => /^\s*import\b/.test(line)
  || /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*['"]/.test(line)
  || /^\s*\}\s*from\s*['"][^'"]+['"];?\s*$/.test(line)
  || /^\s*@(?:use|import|forward)\s/.test(line);

// What the whole diff of one file did, or null when it may change behaviour: `rename` (no line
// changed), `imports` (only import lines), `format` (only whitespace and blank lines), or
// `substitution` (every changed line is its old line with the learned words replaced).
function classify({ status, removed, added }, map) {
  if (!status || status === 'A' || status === 'D') return null;
  if (removed.length === 0 && added.length === 0) return /^[RC]/.test(status) ? 'rename' : null;
  const norm = (line) => line.replace(/\s+/g, ' ').trim();
  const code = (lines) => lines.filter((line) => !isImportLine(line)).map(norm).filter((line) => line !== '');
  const before = code(removed);
  const after = code(added);
  if (before.length === 0 && after.length === 0) {
    return [...removed, ...added].some(isImportLine) ? 'imports' : 'format';
  }
  if (before.join('\n') === after.join('\n')) return 'format';
  if (Object.keys(map).length > 0 && before.map((line) => applyMap(line, map)).join('\n') === after.join('\n')) return 'substitution';
  return null;
}

// The lines a unified patch removes and adds - only inside its hunks, so a removed line that
// itself starts with `--` is not taken for a header.
function diffLines(patch) {
  const removed = [];
  const added = [];
  let inHunk = false;
  for (const line of String(patch || '').split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  return { removed, added };
}

// Where the reviewed revision still holds an old word: a reference the rename did not reach, the
// first thing the gate's "did the change break something" asks. `texts` maps a path to its text.
function leftovers(map, texts, limit = leftoverLimit) {
  const words = Object.keys(map);
  if (words.length === 0) return { total: 0, hits: [] };
  const pattern = new RegExp(words.map(escape).join('|'), 'i');
  const hits = [];
  let total = 0;
  for (const [file, text] of texts) {
    if (typeof text !== 'string' || !pattern.test(text)) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (!pattern.test(line)) return;
      total++;
      if (hits.length < limit) hits.push({ path: file, line: i + 1, text: line.trim().slice(0, 160) });
    });
  }
  return { total, hits };
}

module.exports = { minWordLength, leftoverLimit, substitutionMap, applyMap, isImportLine, classify, diffLines, leftovers };
