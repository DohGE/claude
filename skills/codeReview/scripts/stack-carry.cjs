'use strict';

// Verdicts a later part of a stack takes over from the earlier part that walked the same file.
// In a review of stacked branches a file the feature keeps changing is walked once per part: 27
// files of a four-part run were walked 79 times (2026-11-02), each walk against the whole plan.
// An item about a construct (a rulebook `subject`: a template element, an ARIA attribute, a
// subscription) cannot be settled differently by a diff that touches no such construct: when none
// of the lines the later part changed - with a few lines around them - matches the item's subject,
// the earlier part's verdict stands, its lines moved to where they are now. The script decides
// which items qualify (review-context.cjs, from the two revisions); the read hook takes the
// verdicts from the earlier part once it is on disk and leaves their text out of the bundle
// (review-hooks.cjs); the part check writes them into the part (check-part.cjs fillPart). A
// verdict whose lines the later part changed, a violation, a gate and an item the bundle points
// at are walked again.
//
// Pure functions but the file helpers at the end.

const fs = require('node:fs');
const path = require('node:path');
const rulebook = require('./rulebook.cjs');
const render = require('./render-report.cjs');

// FIXED IDENTIFIER: what a carried verdict's line and the bundle say of it - no digit, so a
// `brak wystąpień` range keeps reading as one (check-part.cjs refuses numbers on a range).
const carriedNote = 'przeniesione z poprzedniej części stosu';
// The lines around a changed one a subject is looked for in: an attribute added inside an
// element that opens a few lines above still changes that element.
const subjectMargin = 3;

// The hunks of a `git diff -U0` per new-side path: [[oldStart, oldCount, newStart, newCount], …].
function hunksOf(diff) {
  const files = {};
  let current = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t.*$/, '').trim();
      current = p === '/dev/null' ? null : p.replace(/^"|"$/g, '').replace(/^b\//, '');
      if (current && !files[current]) files[current] = [];
      continue;
    }
    const m = current ? line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/) : null;
    if (!m) continue;
    files[current].push([Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]);
  }
  return files;
}

// Where an old line is in the new revision, or null when the diff changed or removed it.
function mapLine(hunks, line) {
  let delta = 0;
  for (const [oldStart, oldCount, , newCount] of hunks) {
    if (oldCount === 0) {
      // An insertion after old line `oldStart`.
      if (line > oldStart) delta += newCount;
      else break;
      continue;
    }
    const end = oldStart + oldCount - 1;
    if (line < oldStart) break;
    if (line <= end) return null;
    delta += newCount - oldCount;
  }
  return line + delta;
}

// The new-side lines the hunks added or rewrote, widened by `margin`, as text.
function changedText(text, hunks, margin = subjectMargin) {
  const lines = String(text || '').split('\n');
  const take = new Set();
  for (const [, , newStart, newCount] of hunks) {
    if (newCount === 0) {
      for (let k = newStart - margin + 1; k <= newStart + margin; k++) take.add(k);
      continue;
    }
    for (let k = newStart - margin; k <= newStart + newCount - 1 + margin; k++) take.add(k);
  }
  return [...take].filter((k) => k >= 1 && k <= lines.length).sort((a, b) => a - b).map((k) => lines[k - 1]).join('\n');
}

// The items of a later part's plan whose earlier verdict may stand: an item with a subject that no
// changed line matches, which the script did not close, the rulebook did not answer in advance and
// the bundle points nothing at. `plan` the kind's steps, `bound` the file's bindings (bindFile).
function eligibleItems({ plan, instructions, bound = { items: {} }, text, hunks }) {
  const changed = changedText(text, hunks);
  const closed = new Set(bound.closed || []);
  const out = [];
  for (const step of plan || []) {
    const instruction = instructions.get(step.id);
    if (!instruction) continue;
    for (const n of step.numbers) {
      const address = `${step.id}#${n}`;
      const extra = instruction.extras.get(n);
      if (!extra || !extra.subject || extra.unverified || closed.has(address) || (bound.items || {})[address]) continue;
      // Its subject is in the file (else the script closed it) but on no changed line.
      if (!rulebook.subjectAbsent(extra, changed)) continue;
      out.push(address);
    }
  }
  return out;
}

const reSpan = /(?<![\p{L}\p{N}])(?:L(\d+)(?:\s*[-–]\s*L?(\d+))?|(\d+)\s*[-–]\s*L?(\d+))(?![\p{L}\p{N}])/gu;

// The evidence with every cited line moved to the new revision, or null when one of them changed.
function moveEvidence(evidence, hunks) {
  let lost = false;
  const moved = String(evidence).replace(reSpan, (whole, l1, l2, s1, s2) => {
    const from = Number(l1 || s1);
    const to = Number(l2 || s2 || from);
    const a = mapLine(hunks, from);
    const b = mapLine(hunks, to);
    if (a === null || b === null || b - a !== to - from) {
      lost = true;
      return whole;
    }
    if (l1) return l2 ? `L${a}-${b}` : `L${a}`;
    return `${a}-${b}`;
  });
  return lost ? null : moved;
}

const reVerdict = /\s[—–-]\s*(OK|NARUSZENIE|BRAMKA|NIEZWERYFIKOWANE)(?![\p{L}\p{N}_])(.*)$/u;

// The earlier part's verdicts on `eligible` items, each as the line the later part carries:
// `{ address: '[x] general#3 — OK (L14; przeniesione …)' }`. An OK and an item left open move; a
// violation, a gate and an OK whose lines the later part changed do not.
function carriedLines({ sourcePart, eligible, hunks }) {
  const wanted = new Set(eligible);
  const out = {};
  let inBlock = false;
  for (const raw of String(sourcePart || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!inBlock) {
      if (render.reChecklistOpen.test(line)) inBlock = true;
      continue;
    }
    const end = line.indexOf('-->');
    const content = (end === -1 ? line : line.slice(0, end)).trim();
    if (end !== -1) inBlock = false;
    const item = content.match(render.reChecklistItem);
    if (!item) continue;
    const [, box, id, spec, rest] = item;
    const verdict = (` ${rest}`).match(reVerdict);
    if (!verdict) continue;
    // The label in front of the verdict: `[ ] a#3 <label> — NIEZWERYFIKOWANE: …`.
    const label = rest.slice(0, Math.max(0, verdict.index - 1)).trim();
    const word = verdict[1];
    const after = verdict[2].trim();
    const addresses = render.expandItemSpec(spec).map((n) => `${id}#${n}`).filter((address) => wanted.has(address));
    if (addresses.length === 0) continue;
    if (word === 'OK' && box !== ' ') {
      const evidence = (after.match(/^\((.*)\)\s*$/) || [])[1];
      if (evidence === undefined) continue;
      if (/^brak wystąpień/i.test(evidence.trim())) {
        for (const address of addresses) out[address] = `[x] ${address} — OK (brak wystąpień; ${carriedNote})`;
        continue;
      }
      // Lines or a path are the evidence of one item.
      if (render.expandItemSpec(spec).length !== 1) continue;
      const moved = moveEvidence(evidence, hunks);
      if (moved !== null) out[addresses[0]] = `[x] ${addresses[0]} — OK (${moved}; ${carriedNote})`;
    } else if (word === 'NIEZWERYFIKOWANE' && box === ' ') {
      const reason = after.replace(/^:\s*/, '');
      const moved = moveEvidence(reason, hunks);
      if (!reason || moved === null) continue;
      for (const address of addresses) out[address] = `[ ] ${address}${label ? ` ${label}` : ''} — NIEZWERYFIKOWANE: ${moved}`;
    }
  }
  return out;
}

// The bundle as the later part's walker reads it: a carried item's text gives way to a line saying
// so and its skeleton entry goes, line for line - every line number stays, so its pages still hold.
function carryBundle(text, carried, from) {
  const addresses = new Set(Object.keys(carried));
  if (addresses.size === 0) return { text, count: 0 };
  let section = '';
  let skipping = false;
  let count = 0;
  const lines = String(text).split('\n').map((line) => {
    if (line.startsWith('## ')) {
      section = line.trim();
      skipping = false;
      return line;
    }
    if (section === '## Plan') {
      const item = line.match(/^- ([a-z0-9][a-z0-9-]*#\d+): /);
      if (item) {
        skipping = addresses.has(item[1]);
        if (!skipping) return line;
        count++;
        return `- ${item[1]}: werdykt z ${from} (${carriedNote}) - wpisze go hook, nie przechodzisz`;
      }
      if (line.startsWith('### ')) skipping = false;
      return skipping && line.startsWith('  ') ? '' : line;
    }
    if (section === '## Zapis części') {
      const entry = line.match(/^(\s*\[x\] )([a-z0-9][a-z0-9-]*)#([\d,#\s-]+?)( — ….*)$/);
      if (!entry) return line;
      const numbers = render.expandItemSpec(entry[3].replace(/#/g, '')).filter((n) => !addresses.has(`${entry[2]}#${n}`));
      if (numbers.length === 0) return '';
      return `${entry[1]}${entry[2]}#${rulebook.formatItemSpec(numbers).replace(/,/g, ',#')}${entry[4]}`;
    }
    return line;
  });
  return { text: lines.join('\n'), count };
}

// Where the hook leaves the verdicts it carried for a part, for the part check to write in.
const carriedPathOf = (workDir, number, width = 2) => `${String(workDir).replace(/\\/g, '/')}/carried${String(number).padStart(width, '0')}.json`;

function readCarried(workDir, number, width) {
  try {
    const data = JSON.parse(fs.readFileSync(carriedPathOf(workDir, number, width), 'utf8'));
    return data && typeof data === 'object' && data.lines ? data : null;
  } catch {
    return null;
  }
}

// What the read hook does with a bundle of a file `file` (its context entry, with `carry`) of
// `target`: the source part's verdicts, the bundle text without their items, and the record on
// disk. Null when there is nothing to carry or the source part is not written yet.
function carryForRead({ context, target, file, number, text, readFile = (p) => fs.readFileSync(p, 'utf8') }) {
  const carry = file && file.carry;
  if (!carry || !Array.isArray(carry.eligible) || carry.eligible.length === 0) return null;
  const source = (context.targets || [])[carry.target];
  if (!source) return null;
  const n = (source.files || []).length;
  const width = Math.max(2, String(n + 2).length);
  const partPath = `${String(source.reportPath).replace(/\\/g, '/').replace(/\.md$/i, '')}.part${String(carry.number).padStart(width, '0')}.md`;
  let sourcePart;
  try {
    sourcePart = readFile(partPath);
  } catch {
    return null;
  }
  const carried = carriedLines({ sourcePart, eligible: carry.eligible, hunks: carry.hunks || [] });
  if (Object.keys(carried).length === 0) return null;
  const result = carryBundle(text, carried, source.branch || path.basename(String(source.reportPath)));
  const ownWidth = Math.max(2, String((target.files || []).length + 2).length);
  return { ...result, carried, record: { from: source.branch || null, part: partPath, lines: carried }, recordPath: carriedPathOf(target.workDir, number, ownWidth) };
}

module.exports = { carriedNote, subjectMargin, hunksOf, mapLine, changedText, eligibleItems, moveEvidence, carriedLines, carryBundle, carriedPathOf, readCarried, carryForRead };
