#!/usr/bin/env node
'use strict';

// The validation checklist, read and ticked by a script instead of an agent.
//
// `checklist.md` holds one line per requirement: `- [ ] R<n> | <requirement> | verify: e2e|visual|manual`,
// ticked as `- [x] … | evidence: <what proves it>`. Compliance is ticks over lines, and the step
// passes at 99. Two things went wrong with an agent keeping it by hand:
//
// - Ticking 100 `verify: e2e` lines against a test run is clerical work done at the end of the
//   step, in the agent's largest context - and an agent's reading of a run, not the run's record.
//   `tick` does it from Playwright's own JSON report: a line is ticked when every test whose title
//   names its id passed, unticked when one failed. Name a test after the line it proves
//   (`test('R12 the status pill shows Unreachable', …)`; one test may name several ids).
// - A line the user has since overruled - a mockup round removed that window, a chat message
//   changed that text - could only stay unticked, so a feature with 99 of 99 tests green failed
//   its gate at 73% on 35 such lines. `supersede` marks one `- [~] … | superseded: <source>`; once
//   the user confirmed the list (`confirm`) those lines leave the denominator. Until then they
//   count as open, so nothing is waved through on an agent's word.
//
// Usage: node checklist.cjs status    --file=<checklist.md>
//        node checklist.cjs tick      --file=<checklist.md> --report=<e2e-report.json> [--report=…] [--authors-dir=<dir>]
//        node checklist.cjs mark      --file=<checklist.md> --id=R<n> --evidence=<text>   (a visual or manual line; --untick takes the tick back)
//        node checklist.cjs supersede --file=<checklist.md> --id=R<n>[,R<m>…] --source=<the later decision>
//        node checklist.cjs confirm   --file=<checklist.md> (--ids=R<n>,… | --all)
//        node checklist.cjs reopen    --file=<checklist.md> --ids=R<n>,…                   (the user did not agree: a requirement again)
// Prints one JSON line: { total, ticked, compliance, open, superseded: { confirmed, unconfirmed }, untagged, … }.

const fs = require('node:fs');
const path = require('node:path');

const COMMANDS = ['status', 'tick', 'mark', 'supersede', 'confirm', 'reopen'];
const LINE = /^(\s*-\s*\[)([ xX~])(\]\s*)(R\d+)\b(.*)$/;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new Error(`usage: node checklist.cjs ${COMMANDS.join('|')} --file=<checklist.md> …`);
  const args = { command, file: '', reports: [], authorsDir: '', ids: [], all: false, evidence: '', source: '', untick: false };
  for (const arg of rest) {
    if (arg === '--all') { args.all = true; continue; }
    if (arg === '--untick') { args.untick = true; continue; }
    const m = arg.match(/^--([a-z-]+)=([\s\S]*)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'file') args.file = m[2];
    else if (m[1] === 'report') args.reports.push(m[2]);
    else if (m[1] === 'authors-dir') args.authorsDir = m[2];
    else if (m[1] === 'id' || m[1] === 'ids') args.ids.push(...m[2].split(',').map((s) => s.trim()).filter(Boolean));
    else if (m[1] === 'evidence') args.evidence = m[2].trim();
    else if (m[1] === 'source') args.source = m[2].trim();
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!args.file) throw new Error('--file=<checklist.md> is required');
  const bad = args.ids.filter((id) => !/^R\d+$/.test(id));
  if (bad.length) throw new Error(`not a checklist id: ${bad.join(', ')} (expected R<number>)`);
  if (command === 'tick' && !args.reports.length) throw new Error('tick needs --report=<e2e-report.json>');
  if (command === 'mark' && (args.ids.length !== 1 || (!args.untick && !args.evidence))) throw new Error('mark needs --id=R<n> and --evidence=<text> (or --untick)');
  if (command === 'supersede' && (!args.ids.length || !args.source)) throw new Error('supersede needs --id=R<n> and --source=<the later decision that overruled it>');
  if (command === 'confirm' && !args.all && !args.ids.length) throw new Error('confirm needs --ids=R<n>,… or --all');
  if (command === 'reopen' && !args.ids.length) throw new Error('reopen needs --ids=R<n>,…');
  return args;
}

// One checklist line taken apart; everything else in the file passes through untouched.
function parseLine(text) {
  const m = LINE.exec(text);
  if (!m) return null;
  const segments = m[5].split('|').map((s) => s.trim());
  const find = (prefix) => {
    const hit = segments.find((s) => s.toLowerCase().startsWith(prefix));
    return hit === undefined ? null : hit.slice(prefix.length).trim();
  };
  const verify = (find('verify:') || '').toLowerCase();
  return {
    id: m[4], mark: m[2] === 'X' ? 'x' : m[2], head: m[1], tail: m[3], segments,
    verify: ['e2e', 'visual', 'manual'].includes(verify) ? verify : '',
    evidence: find('evidence:'), superseded: find('superseded:'),
    confirmed: segments.some((s) => s.toLowerCase() === 'confirmed'),
  };
}

const withoutSegments = (line, ...prefixes) => line.segments.filter((s) => {
  const low = s.toLowerCase();
  return !prefixes.some((p) => (p.endsWith(':') ? low.startsWith(p) : low === p));
});

function render(line, mark, segments) {
  // The first segment is whatever followed the id up to the first `|` (usually nothing).
  const [first, ...rest] = segments;
  const parts = rest.filter((s) => s !== '');
  return `${line.head}${mark}${line.tail}${line.id}${first ? ` ${first}` : ''}${parts.length ? ` | ${parts.join(' | ')}` : ''}`;
}

function readChecklist(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  // Every carriage return goes, not only the one before a line feed: an agent that appended
  // ` | evidence: …` to a CRLF line left the `\r` in the middle of it, and 99 ticked lines of one
  // checklist then read as no line at all.
  return { eol, lines: raw.split('\n').map((line) => line.replace(/\r/g, '')) };
}

function writeChecklist(file, { eol, lines }) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join(eol), 'utf8');
  fs.renameSync(tmp, file);
}

function statusOf(lines) {
  const items = lines.map(parseLine).filter(Boolean);
  const confirmed = items.filter((l) => l.mark === '~' && l.confirmed);
  const unconfirmed = items.filter((l) => l.mark === '~' && !l.confirmed);
  const ticked = items.filter((l) => l.mark === 'x');
  const counted = items.length - confirmed.length;
  const byVerify = {};
  for (const kind of ['e2e', 'visual', 'manual']) {
    const of = items.filter((l) => l.verify === kind && !(l.mark === '~' && l.confirmed));
    byVerify[kind] = { total: of.length, ticked: of.filter((l) => l.mark === 'x').length };
  }
  return {
    total: items.length, counted, ticked: ticked.length,
    // The gate's number: confirmed superseded lines are no requirement any more; unconfirmed
    // ones still are, so they keep it down until the user has said yes.
    compliance: counted ? Math.floor((100 * ticked.length) / counted) : 0,
    open: items.filter((l) => l.mark === ' ').map((l) => l.id),
    superseded: { confirmed: confirmed.map((l) => l.id), unconfirmed: unconfirmed.map((l) => l.id) },
    untagged: items.filter((l) => !l.verify).map((l) => l.id),
    byVerify,
  };
}

// Every test of a Playwright JSON report as { file, title, outcome }, the title with its
// describe blocks in front: an id in a `describe('R12 …')` covers the tests under it.
function testsOf(report) {
  const out = [];
  const walk = (suite, trail) => {
    for (const spec of suite.specs || []) {
      const tests = spec.tests || [];
      const statuses = tests.map((t) => t.status);
      const passed = tests.some((t) => (t.results || []).some((r) => r.status === 'passed'));
      let outcome = 'failed';
      if (tests.length && statuses.every((s) => s === 'skipped')) outcome = 'skipped';
      else if (tests.length && statuses.every((s) => s === 'expected' || s === 'skipped') && passed) outcome = 'passed';
      out.push({ file: path.basename(String(spec.file || suite.file || '')), title: [...trail, spec.title].filter(Boolean).join(' › '), outcome });
    }
    for (const child of suite.suites || []) walk(child, child.file && child.title === child.file ? trail : [...trail, child.title]);
  };
  for (const suite of (report && report.suites) || []) walk(suite, []);
  return out;
}

// { R12: 'GET /app/api/nodes/scan', … } from the authors' result files: which lines were proven
// against a faked endpoint, so the tick says so.
function mockedLines(dir) {
  const map = {};
  if (!dir) return map;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return map;
  }
  for (const name of names) {
    try {
      const mocked = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).mocked;
      if (mocked && typeof mocked === 'object') for (const [id, route] of Object.entries(mocked)) map[id] = String(route);
    } catch { /* an author's file that does not parse says nothing about mocks */ }
  }
  return map;
}

function tick(lines, tests, mocked = {}) {
  const failed = [];
  const noTest = [];
  let changed = 0;
  const next = lines.map((text) => {
    const line = parseLine(text);
    if (!line || line.verify !== 'e2e' || line.mark === '~') return text;
    // A line ticked on the rulebook's word (a file this feature may not change) has no test.
    if (line.mark === 'x' && /^rulebook\b/i.test(line.evidence || '')) return text;
    const named = new RegExp(`\\b${line.id}\\b`);
    const hits = tests.filter((t) => named.test(t.title) && t.outcome !== 'skipped');
    if (!hits.length) {
      if (line.mark === ' ') noTest.push(line.id);
      return text;
    }
    const red = hits.find((t) => t.outcome === 'failed');
    let out;
    if (red) {
      failed.push({ id: line.id, test: `${red.file} › ${red.title}` });
      out = render(line, ' ', withoutSegments(line, 'evidence:'));
    } else {
      const note = mocked[line.id] ? ` (mock: ${mocked[line.id]})` : ((line.evidence || '').match(/\s\(mock: [^)]*\)/) || [''])[0];
      const evidence = `evidence: ${hits[0].file} › ${hits[0].title}${hits.length > 1 ? ` (+${hits.length - 1} more)` : ''}${note}`;
      out = render(line, 'x', [...withoutSegments(line, 'evidence:'), evidence]);
    }
    if (out !== text) changed++;
    return out;
  });
  return { lines: next, changed, failed, noTest };
}

function edit(lines, ids, change) {
  const missing = new Set(ids);
  const next = lines.map((text) => {
    const line = parseLine(text);
    if (!line || !missing.has(line.id)) return text;
    missing.delete(line.id);
    return change(line, text);
  });
  return { lines: next, missing: [...missing] };
}

function run(args) {
  const doc = readChecklist(args.file);
  let extra = {};
  let lines = doc.lines;
  if (args.command === 'tick') {
    const tests = args.reports.flatMap((file) => testsOf(JSON.parse(fs.readFileSync(file, 'utf8'))));
    const ticked = tick(lines, tests, mockedLines(args.authorsDir));
    lines = ticked.lines;
    extra = { tests: tests.length, changed: ticked.changed, failed: ticked.failed, noTest: ticked.noTest };
  } else if (args.command === 'mark') {
    const done = edit(lines, args.ids, (line) => (args.untick
      ? render(line, ' ', withoutSegments(line, 'evidence:'))
      : render(line, 'x', [...withoutSegments(line, 'evidence:', 'superseded:', 'confirmed'), `evidence: ${args.evidence}`])));
    ({ lines } = done);
    extra = { missing: done.missing };
  } else if (args.command === 'supersede') {
    const done = edit(lines, args.ids, (line) => render(line, '~',
      [...withoutSegments(line, 'evidence:', 'superseded:', 'confirmed'), `superseded: ${args.source}`]));
    ({ lines } = done);
    extra = { missing: done.missing };
  } else if (args.command === 'confirm') {
    const ids = args.all ? lines.map(parseLine).filter((l) => l && l.mark === '~').map((l) => l.id) : args.ids;
    const done = edit(lines, ids, (line, text) => (line.mark === '~' && !line.confirmed ? render(line, '~', [...line.segments, 'confirmed']) : text));
    ({ lines } = done);
    extra = { missing: done.missing };
  } else if (args.command === 'reopen') {
    const done = edit(lines, args.ids, (line, text) => (line.mark === '~' ? render(line, ' ', withoutSegments(line, 'superseded:', 'confirmed')) : text));
    ({ lines } = done);
    extra = { missing: done.missing };
  }
  if (args.command !== 'status' && lines.some((l, i) => l !== doc.lines[i])) writeChecklist(args.file, { eol: doc.eol, lines });
  return { ...statusOf(lines), ...extra };
}

if (require.main === module) {
  let result;
  try {
    result = run(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.errors ? 1 : 0;
}

module.exports = { parseArgs, parseLine, statusOf, testsOf, tick, run };
