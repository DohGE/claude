#!/usr/bin/env node
'use strict';

// Deterministic check of the part files a codeReview run writes (SKILL.md Step 3 point 4),
// against the context that planned them. Two entry points share one set of rules:
// - PreToolUse hook (no arguments): stdin carries a Write or Edit call. A `<stem>.partNN.md`
//   whose `<stem>.md` is a target of a run's `.review-context-*.json` is checked BEFORE
//   it lands, and exit 2 hands the problems back while that file's walk is still in front of
//   the reviewer. Anything else, and any failure of the checker itself, exits 0: a broken
//   check must never stop a Write.
// - Assembly (`--context=<contextPath> --report=<reportPath>`): every part on disk again, plus
//   what only the whole set shows - a file without a part, a numbering the shell glob would
//   put out of order, a clean target without its closing line. Exit 1 keeps the parts.
// Everything checked here is something the report format already demanded and nothing read
// back: a bare `OK`, a verdict deferred to another item, an OK whose lines answer thirty items
// at once or span the whole file, a violation ticked with no finding behind it, a gate closed
// for an instruction that has none, one finding carrying several items of one checklist or one
// file's defect split across two. Each of those passed the renderer, and each one hid a
// finding or doubled one.
// The file's bundle (facts.json, written with it by review-context.cjs) adds what the repository
// shows: an OK has to answer every line a FAKT, WSKAZÓWKA or SONDA points at, and a FAKT only
// yields to a reason. A refused part is kept as a draft in the work folder - fixed with Edit and
// moved into place by `--promote=<draft>` (review-hooks.cjs does it after the Edit) - and a part
// written within 2 s of the one before it is refused unless both are files of one batch
// (`target.batches`), so each part, or each batch of light files, is its own response. The
// rulebook's own rules (facts.json `rules`) add three: a prepared NIEZWERYFIKOWANE is never
// answered OK, a cross-file finding never repeats one a file's part reports, and at the assembly
// every finding takes the fixed severity of the items it names. The hook also refuses a shell
// command that prints a reviewed file: that text reaches the reviewer compressed and without
// Read's line numbers.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const render = require('./render-report.cjs');
const layout = require('./review-context.cjs');
const bundle = require('./review-bundle.cjs');
const rulebook = require('./rulebook.cjs');

const rePartName = /^(.*)\.part(\d+)\.md$/i;
const reContextName = /^\.review-context-[a-z]+\.json$/;
// The verdict is the first `— WORD` after the address: the label before it is the reviewer's
// own two to six words, the text after it the evidence or the reason.
const reVerdict = /(?:^|\s)[—–-]\s*(OK|NARUSZENIE|BRAMKA|NIEZWERYFIKOWANE)(?![\p{L}\p{N}_])/u;
const reAddress = /[a-z0-9][a-z0-9-]*#\d+/i;
// FIXED IDENTIFIERS (SKILL.md Step 3 point 4), matched here word for word: translated, each one
// reads as missing and every verdict carrying it is refused.
// - The one evidence an OK may give instead of lines.
const noOccurrence = 'brak wystąpień';
// - What an OK says when a FAKT of its bundle does not break its item, and the answer to the
//   bundle's second question (review-bundle.cjs prints the question with the same words).
const factNotApplicable = 'fakt nie dotyczy:';
const secondAnswer = bundle.linePrefix.second;
// - The three things a NIEZWERYFIKOWANE may lack: a tool that was not run, a file outside the
//   review, data only the running application has.
const unverifiedReasons = ['narzędzie:', 'poza recenzją:', 'działająca aplikacja:'];
// - The cross-file part's block answering, once for the target, each item left [ ] in
//   `unverifiedMinFiles` files or more.
const reUnverifiedOpen = render.reUnverifiedOpen;
const unverifiedMinFiles = bundle.unverifiedMinFiles;
// An OK whose lines cover this share of a file at least this long cites the file, not the
// place its verdict was read from.
const wholeFileShare = 0.5;
const wholeFileMinLines = 20;
const maxListed = 40;
// Parts written closer together than this came from one response - allowed within one batch.
const partGapMs = 2000;
const noRules = { severity: {}, sameAs: {}, prepared: {} };
const timingRefusal = 'jedna część na odpowiedź';
// Read cuts a line longer than this; `sed -n '<N>p'` is how the rest of it is seen.
const readLineLimit = 2000;

function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

function pad(number, digits) {
  return String(number).padStart(digits, '0');
}

// Whether files `a` and `b` are walked in one response: review-context.cjs lists every batch of
// two or more consecutive light files as [first, last].
function sameBatch(target, a, b) {
  return (target.batches || []).some(([first, last]) => a >= first && a <= last && b >= first && b <= last);
}

function rulesOf(facts) {
  const rules = facts && facts.rules;
  return rules ? { ...noRules, ...rules } : noRules;
}

// The lines a Linia field names - `12`, `L12-18`, lists of them; text in parentheses is a note.
function lineSet(value) {
  const lines = new Set();
  const text = String(value || '').replace(/\([^()]*\)/g, ' ');
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])L?(\d+)(?:\s*[-–]\s*L?(\d+))?(?![\p{L}\p{N}])/gu)) {
    const from = Number(m[1]);
    const to = Math.max(from, Number(m[2] || from));
    if (to - from > 5000) continue;
    for (let k = from; k <= to; k++) lines.add(k);
  }
  return lines;
}

function addressesOf(finding) {
  return (finding.tags || []).filter((tag) => tag.address).map((tag) => `${tag.address.id}#${tag.address.n}`);
}

// A part as the renderer reads it, under a header it lacks.
function partReport(text) {
  return render.parseReport(`# Code Review: part | 2000-01-01 00:00\n${text}`);
}

// `general#1-3,#5, component#2`: one line however many items a message names.
function compact(addresses) {
  const byId = new Map();
  for (const address of addresses) {
    const [id, n] = address.split('#');
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(Number(n));
  }
  return [...byId].map(([id, numbers]) => {
    const runs = [];
    for (const n of numbers.sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && n === last[1] + 1) last[1] = n;
      else runs.push([n, n]);
    }
    return `${id}#${runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',#')}`;
  }).join(', ');
}

function listParts(numbers, target, digits) {
  const shown = numbers.slice(0, 5).map((k) => `part${pad(k, digits)} (${target.files[k - 1].path})`);
  return shown.join(', ') + (numbers.length > shown.length ? `, … (${numbers.length} razem)` : '');
}

function numbersIn(value) {
  return (String(value || '').replace(/\([^()]*\)/g, ' ').match(/\d+/g) || []).map(Number);
}

// The line spans an OK's evidence cites: `L12`, `L12-18` and a bare `12-18`. A bare single
// number is left out - in evidence it is as often a size or a count (`24×24 px`) as a line.
function citedSpans(value) {
  const spans = [];
  const re = /(?<![\p{L}\p{N}])(?:L(\d+)(?:\s*[-–]\s*L?(\d+))?|(\d+)\s*[-–]\s*L?(\d+))(?![\p{L}\p{N}])/gu;
  for (const m of String(value).matchAll(re)) {
    const from = Number(m[1] || m[3]);
    spans.push([from, Math.max(from, Number(m[2] || m[4] || from))]);
  }
  return spans;
}

// Where a path a verdict names is looked up, in this order: the reviewed file's folder, the fact
// root (the folder the bundle's paths are relative to), the project root.
function pathFinder(context, file, root, factRoot) {
  const known = new Set((context.targets || []).flatMap((t) => (t.files || []).map((f) => f.path)));
  const bases = [...new Set([file ? path.posix.dirname(file.path) : '.', factRoot || '.', '.'])];
  const candidatesOf = (token) => bases
    .map((base) => path.posix.normalize(path.posix.join(base, token)).replace(/\/+$/, '') || '.')
    .filter((candidate) => candidate !== '..' && !candidate.startsWith('../'));
  const statOf = (candidate) => {
    try {
      return root ? fs.statSync(path.resolve(root, candidate)) : null;
    } catch {
      return null;
    }
  };
  return {
    // The file an OK's evidence names when the requirement is met outside the reviewed file - its
    // spec, the route that provides its facade - provided it exists: one of the review's files,
    // or one on disk.
    named(value) {
      for (const token of String(value).match(/[\w@+~.-]*(?:\/[\w@+~.-]+)*\.[A-Za-z][\w-]*/g) || []) {
        for (const candidate of candidatesOf(token)) {
          if (file && candidate === file.path) continue;
          if (known.has(candidate)) return candidate;
          const stat = statOf(candidate);
          if (stat && stat.isFile()) return candidate;
        }
      }
      return null;
    },
    // What a `poza recenzją: <path>` reason names: the first candidate that exists, and whether
    // the review holds it - a reviewed file, or a folder with one inside. Null when none exists.
    outside(token) {
      for (const candidate of candidatesOf(token)) {
        const inside = (p) => candidate === '.' || p === candidate || p.startsWith(`${candidate}/`);
        if (known.has(candidate)) return { path: candidate, reviewed: true };
        const stat = statOf(candidate);
        if (stat) return { path: candidate, reviewed: stat.isDirectory() && [...known].some(inside) };
      }
      return null;
    },
  };
}

// The path at the head of a reason: quotes and backticks dropped, a `:12` or `:3-9` line suffix
// and closing punctuation cut off.
function leadingPath(text) {
  const m = String(text).trim().match(/^[`'"]?([^\s`'",;()]+)/);
  return m ? m[1].replace(/:\d+(?:-\d+)?$/, '').replace(/[.:]+$/, '') : '';
}

function lineCountOf(file) {
  if (!file || !file.contentPath) return null;
  try {
    const text = fs.readFileSync(file.contentPath, 'utf8');
    const count = text.split('\n').length;
    return text.endsWith('\n') ? count - 1 : count;
  } catch {
    return null;
  }
}

function memoLineCount() {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file.path)) cache.set(file.path, lineCountOf(file));
    return cache.get(file.path);
  };
}

function hasFinding(text) {
  return text !== null && String(text).split(/\r?\n/).some((line) => render.reSeverity.test(line.trim()));
}

// Every `<id>#<n>` the file's plan hands it - what its block has to cover exactly once.
function planItems(context, file) {
  // A file no kind describes has nothing to tick.
  if (file.plan === null) return new Set();
  const plan = (context.checklistPlans || [])[file.plan];
  if (!plan || !Array.isArray(plan.checklist)) return null;
  const items = new Set();
  for (const entry of plan.checklist) {
    const at = String(entry).lastIndexOf(':');
    const id = String(entry).slice(0, at);
    for (const n of render.expandItemSpec(String(entry).slice(at + 1)) || []) items.add(`${id}#${n}`);
  }
  return items;
}

// The checklist lines, `<!-- unverified:` lines and coverage markers of one part, read line by
// line the way `parseReport` reads them - it keeps the ticks per item, the checks below need
// them per line. The renderer swallows an unverified block like any other comment.
function scanPart(text) {
  const markers = [];
  const blocks = [];
  const unverified = [];
  let block = null;
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (block) {
      const end = line.indexOf('-->');
      const content = (end === -1 ? line : line.slice(0, end)).trim();
      const item = content ? content.match(render.reChecklistItem) : null;
      if (item) {
        block.lines.push({
          lineNo: i + 1, ticked: item[1] !== ' ', id: item[2], spec: item[3],
          numbers: render.expandItemSpec(item[3]), rest: item[4].trim(),
        });
      }
      if (end !== -1) block = null;
      return;
    }
    const open = line.match(render.reChecklistOpen);
    if (open) {
      block = { path: open[1], lines: [] };
      blocks.push(block);
      return;
    }
    const across = line.match(reUnverifiedOpen);
    if (across) {
      unverified.push({ lineNo: i + 1, lines: [] });
      block = across[1] ? null : unverified[unverified.length - 1];
      return;
    }
    const marker = line.match(render.reCoverage);
    if (marker) markers.push({ path: marker[1], value: marker[2] });
  });
  return { markers, blocks, unverified, lines: blocks.flatMap((b) => b.lines) };
}

// The renderer's own parse, so every drift it would warn about at the end is named while the
// part can still be rewritten. A `sprawdzono N/M` warning is an honest `[ ]`, never a drift,
// and an `--only-md` run writes no PR fields at all. The marker's numbers are the assembly's to
// write (rewriteCoverage), and a missing, extra or doubled item is named below by its address,
// so the renderer's counts of them would only repeat it without saying which.
function parseWarnings(context, text) {
  const report = render.parseReport(`# Code Review: part | 2000-01-01 00:00\n${text}`);
  const warnings = report.warnings
    .filter((w) => !/: sprawdzono \d+\/\d+ pozycji checklist/.test(w))
    .filter((w) => !/: checklista ma \d+ z \d+ pozycji|: marker coverage mówi o \d+ sprawdzonych|: pozycja \S+ odchaczona dwa razy/.test(w))
    .filter((w) => context.outputFormat !== 'md' || !/znalezisko bez pola "PR (?:Problem|Expected|Locations)"/.test(w))
    .map((w) => w.replace(/\b([Ll]ini[ai])\s+(\d+)/g, (m, word, n) => `${word} ${Number(n) - 1}`));
  return { report, warnings };
}

function verdictOfLine(line) {
  const v = line.rest.match(reVerdict);
  return v ? { word: v[1], after: line.rest.slice(v.index + v[0].length).trim() } : null;
}

// A NIEZWERYFIKOWANE names what the reviewer could not have: a tool that was not run, a file
// outside the review (which exists, and which the review does not hold), data of the running
// application. Anything else was in front of them - and a requirement the project does not meet
// is a NARUSZENIE of the item that requires it, never a reason to skip the item.
function checkReason(at, reason, finder) {
  const prefix = unverifiedReasons.find((p) => reason.toLowerCase().startsWith(p));
  if (!prefix) {
    return [`${at}: powód NIEZWERYFIKOWANE zaczyna się od "${unverifiedReasons.join('", "')}" - od tego, czego zabrakło: narzędzia, którego nie uruchomiono, pliku spoza recenzji albo danych działającej aplikacji. Brak w projekcie czegoś, czego pozycja wymaga, to NARUSZENIE, nie powód.`];
  }
  const rest = reason.slice(prefix.length).trim();
  if (!rest) return [`${at}: "${prefix}" bez treści - powód mówi, czego dokładnie zabrakło.`];
  if (prefix !== unverifiedReasons[1] || !finder) return [];
  const token = leadingPath(rest);
  const found = token ? finder.outside(token) : null;
  if (!found) {
    return [`${at}: "${prefix} ${token || rest}" - nie ma takiej ścieżki (szukana od folderu pliku, od korzenia faktów i od korzenia projektu); ścieżka pliku spoza recenzji stoi zaraz po "${prefix}".`];
  }
  if (found.reviewed) return [`${at}: "${prefix} ${found.path}" - ta ścieżka należy do recenzji (sama albo pliki w niej): przeczytaj ją i daj pozycji werdykt.`];
  return [];
}

function checkTickLine(line, gates, count, finder = null) {
  const at = `${line.id}#${line.spec}`;
  const verdict = verdictOfLine(line);
  if (!verdict) {
    return [`${at}: brak werdyktu - po adresie i etykiecie stoi "— OK (…)", "— NARUSZENIE (…)", "— BRAMKA: …" albo "— NIEZWERYFIKOWANE: …".`];
  }
  const fileNamedIn = finder ? finder.named : () => null;
  const problems = [];
  const { word, after } = verdict;
  if (word === 'NIEZWERYFIKOWANE') {
    if (line.ticked) problems.push(`${at}: NIEZWERYFIKOWANE przy [x] - niesprawdzona pozycja ma puste pole [ ].`);
    const reason = after.match(/^:\s*(\S.*)$/);
    if (!reason) problems.push(`${at}: NIEZWERYFIKOWANE bez powodu - zapis to "— NIEZWERYFIKOWANE: <czego zabrakło>".`);
    else problems.push(...checkReason(at, reason[1].trim(), finder));
  } else if (!line.ticked) {
    problems.push(`${at}: werdykt ${word} przy pustym polu [ ] - [ ] należy tylko do NIEZWERYFIKOWANE.`);
  }
  if (word !== 'NARUSZENIE' && render.reViolationVerdict.test(line.rest)) {
    problems.push(`${at}: słowo NARUSZENIE w linii z werdyktem ${word} - renderer pokaże tę pozycję jako złamaną.`);
  }
  if (word === 'OK') {
    const evidence = after.match(/^\((.*)\)/);
    const inner = evidence ? evidence[1].trim() : '';
    const deferred = inner.match(reAddress);
    const absent = inner.toLowerCase().includes(noOccurrence);
    const numbered = /(^|[^\p{L}\p{N}])L?\d+/u.test(inner);
    const elsewhere = inner && !deferred ? fileNamedIn(inner) : null;
    const items = line.numbers ? line.numbers.length : 1;
    if (!inner) {
      problems.push(`${at}: OK bez dowodu - zapis to "— OK (L12, L18)" z liniami tego pliku, "— OK (tests/a.spec.ts)" ze ścieżką pliku, który spełnia wymaganie, albo "— OK (${noOccurrence})".`);
    } else if (deferred) {
      problems.push(`${at}: OK odsyła do ${deferred[0]} - kod, który łamie pozycję, nigdy jej nie spełnia: dostaje własne NARUSZENIE. Jej adres dochodzi do pola Reguła znaleziska ${deferred[0]} (najbardziej szczegółowy pierwszy), gdy to to samo wymaganie w innej instrukcji albo obie są pozycjami instrukcji z findings: per-file; inna pozycja tej samej instrukcji to inne wymaganie i własne znalezisko.`);
    } else if (items > 1 && (numbered || elsewhere || !absent)) {
      problems.push(`${at}: jedno OK na ${items} pozycji z dowodem "(${inner})" - linie i pliki są dowodem jednej pozycji. Każda pozycja, której przedmiot występuje w pliku, ma własną linię z liniami, z których odczytano jej werdykt; w jedną linię zwijają się tylko pozycje, których przedmiotu plik nie zawiera: "— OK (${noOccurrence})".`);
    } else if (!absent && !numbered && !elsewhere) {
      problems.push(`${at}: dowód OK "(${inner})" nie wskazuje linii tego pliku, istniejącego pliku ani "${noOccurrence}".`);
    } else if (!elsewhere && count) {
      const spans = citedSpans(inner);
      const beyond = [...new Set(spans.flat().filter((k) => k > count))];
      const covered = new Set();
      for (const [from, to] of spans) for (let k = Math.max(1, from); k <= Math.min(to, count); k++) covered.add(k);
      if (beyond.length) {
        problems.push(`${at}: dowód OK wskazuje linie ${beyond.join(', ')}, a plik ma ${count} linii - numery pochodzą z Read pliku contentPath.`);
      } else if (!absent && count >= wholeFileMinLines && covered.size >= count * wholeFileShare) {
        problems.push(`${at}: dowód OK "(${inner})" obejmuje ${covered.size} z ${count} linii pliku - to cały plik, nie miejsce, z którego odczytano werdykt. Podaj linie, które rozstrzygają tę pozycję: deklarację, wywołanie, wiązanie, element, a przy regule kolejności pierwszą linię każdego elementu. Zakaz, którego przedmiotu plik nie zawiera, to "— OK (${noOccurrence})", a wymaganie spełnione w innym pliku (spec, trasa) wskazuje ten plik ścieżką.`);
      }
    }
  }
  if (word === 'NARUSZENIE') {
    const evidence = after.match(/^\(([^()]*)\)/);
    const numbers = evidence ? numbersIn(evidence[1]) : [];
    if (numbers.length === 0) problems.push(`${at}: NARUSZENIE bez linii - zapis to "— NARUSZENIE (<linie z pola Linia znaleziska>)".`);
    const beyond = count ? numbers.filter((k) => k > count) : [];
    if (beyond.length) problems.push(`${at}: NARUSZENIE wskazuje linie ${beyond.join(', ')}, a plik ma ${count} linii.`);
  }
  if (word === 'BRAMKA') {
    if (!Object.prototype.hasOwnProperty.call(gates, line.id)) {
      problems.push(`${at}: BRAMKA dla instrukcji bez bramki - bramką zamyka się tylko instrukcję z checklistGates (${Object.keys(gates).join(', ') || 'żadna'}).`);
    }
    if (!/^:\s*\S/.test(after)) problems.push(`${at}: BRAMKA bez powodu - zapis to "— BRAMKA: <czego plik nie zawiera>".`);
  }
  return problems;
}

// The lines of this file the item's bundle points at: every FAKT, WSKAZÓWKA and SONDA line.
function pointedLines(bound) {
  const lines = [
    ...[...(bound.strong || []), ...(bound.hints || [])].flatMap((fact) => fact.lines || []),
    ...(bound.probes || []).map((probe) => probe.line),
  ];
  return [...new Set(lines.filter(Number.isInteger))].sort((a, b) => a - b);
}

// A verdict against what the file's bundle showed the item (facts.json): a clean verdict answers
// every line the bundle points at, a FAKT gives way only to a reason, and an OK answers the
// item's second question. A NARUSZENIE or a failed gate needs nothing more from the bundle.
function checkBinding(at, word, after, bound) {
  const strong = bound.strong || [];
  const pointed = pointedLines(bound);
  const spans = citedSpans(after);
  const unanswered = pointed.filter((k) => !spans.some(([from, to]) => k >= from && k <= to));
  const named = (lines) => lines.map((k) => `L${k}`).join(', ');
  const kinds = [...new Set(strong.map((fact) => fact.kind))].join(', ');
  const problems = [];
  if (word === 'OK') {
    if (pointed.length && after.toLowerCase().includes(noOccurrence)) {
      problems.push(`${at}: "${noOccurrence}", a paczka pliku wskazuje ${named(pointed)} - przedmiot pozycji jest w pliku, więc werdykt to NARUSZENIE albo OK z tymi liniami.`);
    } else if (unanswered.length) {
      problems.push(`${at}: OK nie odpowiada na ${named(unanswered)} z paczki pliku (FAKT, WSKAZÓWKA, SONDA) - dowód wymienia każdą z tych linii i mówi, czemu jej kod nie łamie pozycji; linia, która łamie, to NARUSZENIE.`);
    }
    if (strong.length && !after.toLowerCase().includes(factNotApplicable)) {
      problems.push(`${at}: FAKT [${kinds}] przeczy OK - pozycja dostaje NARUSZENIE, a OK tylko z "${factNotApplicable} <czemu fakt nie łamie tej pozycji>" w dowodzie.`);
    }
    if (bound.secondQuestion && !after.toLowerCase().includes(secondAnswer)) {
      problems.push(`${at}: OK bez odpowiedzi na drugie pytanie z paczki ("${bound.secondQuestion}") - dowód zawiera "${secondAnswer} <odpowiedź>".`);
    }
  } else if (word === 'NIEZWERYFIKOWANE') {
    if (strong.length) {
      problems.push(`${at}: NIEZWERYFIKOWANE przy FAKT [${kinds}] - fakt rozstrzyga pozycję: NARUSZENIE albo OK (${named(pointed)}; ${factNotApplicable} <powód>).`);
    } else if (unanswered.length) {
      problems.push(`${at}: NIEZWERYFIKOWANE pomija ${named(unanswered)} z paczki pliku - powód mówi, czego o tych liniach nie da się ustalić.`);
    }
  }
  return problems;
}

// facts.json of the target (review-bundle.cjs factsDocument). Missing or unreadable, a part is
// checked without it: the facts sharpen the check, they never gate a Write.
function readFacts(target) {
  if (!target || !target.factsPath) return null;
  try {
    const facts = JSON.parse(fs.readFileSync(target.factsPath, 'utf8'));
    return facts && facts.version === bundle.factsVersion && facts.files ? facts : null;
  } catch {
    return null;
  }
}

function lineBounds(report, files, lineCount) {
  const problems = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const section of report.files) {
    const file = byPath.get(section.path);
    const count = file ? lineCount(file) : null;
    if (!count) continue;
    for (const finding of section.findings) {
      const beyond = numbersIn(finding.lines).filter((k) => k > count);
      if (beyond.length) {
        problems.push(`${section.path}: pole Linia "${finding.lines}" wskazuje ${beyond.join(', ')}, a plik ma ${count} linii - numery pochodzą z Read pliku contentPath.`);
      }
    }
  }
  return problems;
}

// A checklist never states one requirement twice, so two of its items in one finding are two
// defects sharing a block - one severity, one expected result, one PR comment, one key hit.
// An instruction declaring `findings: per-file` turns that around: its items are facets of one
// requirement (a missing spec leaves every branch untested at once), so all the file breaks
// under it is one finding naming each broken item, and a second finding splits one defect.
function bundledFindings(report, perFile = new Set()) {
  const problems = [];
  for (const section of report.files) {
    const perFileLines = new Map();
    for (const finding of section.findings) {
      const byId = new Map();
      for (const tag of finding.tags || []) {
        if (!tag.address) continue;
        if (!byId.has(tag.address.id)) byId.set(tag.address.id, new Set());
        byId.get(tag.address.id).add(`${tag.address.id}#${tag.address.n}`);
      }
      for (const id of byId.keys()) {
        if (perFile.has(id)) perFileLines.set(id, [...(perFileLines.get(id) || []), finding.lines]);
      }
      const shared = [...byId].filter(([id, addresses]) => !perFile.has(id) && addresses.size > 1).flatMap(([, addresses]) => [...addresses]);
      if (shared.length) {
        problems.push(`${section.path}: znalezisko z pola Linia "${finding.lines}" łączy ${compact(shared)} - pozycje jednej instrukcji to różne wymagania, więc każda dostaje własne znalezisko z własnym Problem, Oczekiwane i liniami. Kilka adresów w polu Reguła należy tylko do tego samego wymagania zapisanego w różnych instrukcjach.`);
      }
    }
    for (const [id, lines] of perFileLines) {
      if (lines.length > 1) {
        problems.push(`${section.path}: ${lines.length} znaleziska instrukcji ${id} (pola Linia ${lines.map((l) => `"${l}"`).join(', ')}) - ${id} deklaruje findings: per-file, więc wszystko, co plik łamie w jej pozycjach, to jedno znalezisko: jego Problem wymienia każdy przypadek, a pole Reguła każdą złamaną pozycję.`);
      }
    }
  }
  return problems;
}

function checkFilePart(context, target, number, digits, scan, report, options) {
  const problems = [];
  const file = target.files[number - 1];
  if (options.sequential) {
    const missing = [];
    // A part of the same batch may still be on its way in this response, or waiting as a draft.
    for (let k = 1; k < number; k++) if (!sameBatch(target, k, number) && options.readPart(k) === null) missing.push(k);
    if (missing.length) {
      problems.push(`najpierw brakujące wcześniejsze części: ${listParts(missing, target, digits)} - pliki idą po kolei, a część każdego pliku (albo partii z paczki) jest zapisana, zanim otworzysz następny.`);
    }
  }
  if (scan.markers.length === 0) {
    problems.push(`brak markera coverage - część kończy linia "<!-- coverage: ${file.path} <sprawdzone>/${file.checklistTotal} -->" (liczby przelicza złożenie raportu).`);
  } else if (scan.markers.length > 1) {
    problems.push(`${scan.markers.length} markery coverage - część jednego pliku ma dokładnie jeden.`);
  }
  if (scan.blocks.length > 1) problems.push(`${scan.blocks.length} bloki checklisty - część jednego pliku ma najwyżej jeden.`);
  if (scan.unverified.length) {
    problems.push(`blok "<!-- unverified:" należy do części przejścia międzyplikowego (part${pad(target.files.length + 1, digits)}), nie do części pliku.`);
  }
  const name = `part${pad(number, digits)}`;
  for (const marker of scan.markers) {
    if (marker.path !== file.path) problems.push(`marker coverage nazywa "${marker.path}", a ${name} należy do pliku nr ${number} z target.files: "${file.path}".`);
  }
  for (const block of scan.blocks) {
    if (block.path !== file.path) problems.push(`blok checklisty nazywa "${block.path}", a ${name} należy do "${file.path}".`);
  }
  const marker = scan.markers[0];
  if (marker && marker.value === 'mechanical') {
    if (target.kind === 'folder') problems.push('marker "mechanical" w trybie folder - tam każdy plik jest dodany w całości i przechodzi pełną checklistę.');
    return problems;
  }
  const gates = context.checklistGates || {};
  const count = options.lineCount(file);
  const facts = options.facts;
  const finder = pathFinder(context, file, options.root, facts && facts.factRoot);
  const bound = (facts && facts.files[file.path] && facts.files[file.path].items) || {};
  const { prepared } = rulesOf(facts);
  const verdictOf = new Map();
  const wordsById = new Map();
  const firstLine = new Map();
  const doubled = new Map();
  for (const line of scan.lines) {
    problems.push(...checkTickLine(line, gates, count, finder));
    for (const k of line.numbers || []) {
      const address = `${line.id}#${k}`;
      if (!firstLine.has(address)) {
        firstLine.set(address, line.lineNo);
        continue;
      }
      const pair = `${firstLine.get(address)} i ${line.lineNo}`;
      doubled.set(pair, [...(doubled.get(pair) || []), address]);
    }
    const verdict = verdictOfLine(line);
    if (!verdict || !line.numbers) continue;
    for (const k of line.numbers) verdictOf.set(`${line.id}#${k}`, verdict.word);
    // No review can check what the rulebook answered in advance: an OK there is a guess.
    const ready = line.numbers.map((k) => `${line.id}#${k}`).filter((address) => prepared[address]);
    if (verdict.word === 'OK' && ready.length) {
      problems.push(`${compact(ready)}: OK przy pozycji z gotowym werdyktem w paczce - przepisz go bez zmian: "[ ] ${ready[0]} — NIEZWERYFIKOWANE: ${prepared[ready[0]]}".`);
    }
    if (!wordsById.has(line.id)) wordsById.set(line.id, new Set());
    wordsById.get(line.id).add(verdict.word);
    // What the bundle showed an item is answered on the item's own line.
    if (verdict.word !== 'OK' && verdict.word !== 'NIEZWERYFIKOWANE') continue;
    const answering = line.numbers.map((k) => `${line.id}#${k}`)
      .filter((a) => bound[a] && (verdict.word === 'OK' || pointedLines(bound[a]).length));
    if (answering.length && line.numbers.length > 1) {
      problems.push(`${line.id}#${line.spec}: ${compact(answering)} ma w paczce pliku FAKT, WSKAZÓWKĘ, SONDĘ albo drugie pytanie - taka pozycja dostaje własną linię z werdyktem, który na nie odpowiada.`);
    } else if (answering.length) {
      problems.push(...checkBinding(`${line.id}#${line.spec}`, verdict.word, verdict.after, bound[answering[0]]));
    }
  }
  for (const [pair, addresses] of doubled) {
    problems.push(`${compact(addresses)}: w dwóch liniach bloku (linie ${pair} części) - każda pozycja planu stoi w bloku dokładnie raz; usuń ją z jednej z tych linii.`);
  }
  // A failed gate answers every item of the instruction at once; a gate that held answers none.
  for (const [id, words] of wordsById) {
    if (words.has('BRAMKA') && words.size > 1) {
      problems.push(`${id}: BRAMKA obok innych werdyktów - bramka, która nie przeszła, zamyka wszystkie pozycje instrukcji z planu pliku; bramka, która przeszła, nie zamyka żadnej.`);
    }
  }
  const plan = planItems(context, file);
  if (plan && scan.blocks.length) {
    const walked = new Set(scan.lines.flatMap((line) => (line.numbers || []).map((k) => `${line.id}#${k}`)));
    const missing = [...plan].filter((a) => !walked.has(a));
    const extra = [...walked].filter((a) => !plan.has(a));
    if (missing.length) problems.push(`brak pozycji planu: ${compact(missing)} - blok obejmuje każdą pozycję z checklistPlans[${file.plan}] dokładnie raz.`);
    if (extra.length) problems.push(`pozycje spoza planu: ${compact(extra)} - pozycja, której plan pliku nie wymienia, nie dostaje linii.`);
  }

  // Ticks and findings are one record: a broken item points at its finding, and a finding
  // at the items it breaks.
  const cited = new Map();
  for (const section of report.files) {
    for (const finding of section.findings) {
      for (const tag of finding.tags || []) {
        if (!tag.address) continue;
        const address = `${tag.address.id}#${tag.address.n}`;
        if (!cited.has(address)) cited.set(address, new Set());
        cited.get(address).add(section.path);
      }
    }
  }
  for (const [address, word] of verdictOf) {
    if (word === 'NARUSZENIE' && !cited.has(address)) {
      problems.push(`${address}: NARUSZENIE bez znaleziska - żadne znalezisko tej części nie ma "${address}" w polu Reguła.`);
    }
  }
  for (const [address, paths] of cited) {
    const word = verdictOf.get(address);
    if (paths.has(file.path) && word && word !== 'NARUSZENIE') {
      problems.push(`${address}: znalezisko cytuje tę pozycję, a checklista daje jej ${word} - złamana pozycja ma werdykt NARUSZENIE.`);
    }
  }
  return problems;
}

// An item left [ ] in `unverifiedMinFiles` files or more is answered once more, in the
// cross-file part, for the whole target: what one file could not settle, all of them together
// often can (a view's consistency, one name across several files). Its block lists exactly
// those items, each with a verdict of its own.
// The items the cross-file block answers: [ ] in `unverifiedMinFiles` file parts or more, except
// the prepared ones - the rulebook already said no review can settle them. Each with its files.
function openAcross(target, readPart, prepared = {}) {
  const partsOf = new Map();
  (target.files || []).forEach((file, i) => {
    const text = readPart(i + 1);
    if (text === null) return;
    for (const line of scanPart(text).lines) {
      if (line.ticked || !line.numbers) continue;
      for (const k of line.numbers) {
        const address = `${line.id}#${k}`;
        if (!prepared[address]) partsOf.set(address, new Set([...(partsOf.get(address) || []), i + 1]));
      }
    }
  });
  return [...partsOf].filter(([, parts]) => parts.size >= unverifiedMinFiles)
    .map(([address, parts]) => ({ address, files: [...parts].map((k) => target.files[k - 1].path) }));
}

// What the cross bundle shows before the pass (review-hooks.cjs): every finding the file parts
// report, as `<addresses> (<lines>)`, and the items the block has to answer.
function reportedState(target, readPart, facts) {
  const reported = [];
  (target.files || []).forEach((file, i) => {
    const text = readPart(i + 1);
    if (text === null) return;
    for (const section of partReport(text).files) {
      const entries = section.findings.map((finding) => `${compact(addressesOf(finding)) || 'bez adresu'} (${finding.lines || '?'})`);
      if (entries.length) reported.push({ path: section.path, entries });
    }
  });
  const open = openAcross(target, readPart, rulesOf(facts).prepared).map(({ address, files }) => ({
    address,
    files: files.slice(0, 5).join(', ') + (files.length > 5 ? `, … (${files.length} razem)` : ''),
  }));
  return { reported, open };
}

// One defect, one finding: a cross-file finding whose lines a finding of that file's own part
// already covers, under the same address or its `sameAs` partner, reports it a second time.
function repeatedFindings(target, digits, report, readPart, rules) {
  const problems = [];
  for (const section of report.files) {
    const index = (target.files || []).findIndex((f) => f.path === section.path);
    const text = index === -1 ? null : readPart(index + 1);
    if (text === null) continue;
    const own = (partReport(text).files.find((s) => s.path === section.path) || { findings: [] }).findings;
    for (const finding of section.findings) {
      const lines = lineSet(finding.lines);
      const addresses = addressesOf(finding);
      if (lines.size === 0 || addresses.length === 0) continue;
      const wanted = new Set(addresses.flatMap((a) => [a, ...(rules.sameAs[a] || [])]));
      const twin = own.find((f) => {
        const covered = lineSet(f.lines);
        return addressesOf(f).some((a) => wanted.has(a)) && [...lines].every((k) => covered.has(k));
      });
      if (twin) {
        problems.push(`${section.path}: znalezisko z pola Linia "${finding.lines}" (${compact(addresses)}) powtarza znalezisko part${pad(index + 1, digits)} (Linia "${twin.lines}", ${compact(addressesOf(twin))}) - wada, którą zgłasza część pliku, nie wraca w przejściu międzyplikowym. Usuń je stąd; drugą stronę duplikacji dopisz najwyżej w polu Problem tamtego znaleziska nie tutaj.`);
      }
    }
  }
  return problems;
}

function checkCrossPart(context, target, digits, scan, report, options) {
  const problems = [];
  const rules = rulesOf(options.facts);
  problems.push(...repeatedFindings(target, digits, report, options.readPart, rules));
  const required = openAcross(target, options.readPart, rules.prepared).map(({ address }) => address);
  if (scan.unverified.length > 1) problems.push(`${scan.unverified.length} bloki "<!-- unverified:" - część przejścia ma najwyżej jeden.`);
  const block = scan.unverified[0];
  if (!block) {
    if (required.length) {
      problems.push(`brak bloku "<!-- unverified:" - ${compact(required)}: [ ] w co najmniej ${unverifiedMinFiles} plikach. Przejście międzyplikowe daje każdej z tych pozycji jeden werdykt dla całego celu, w tym bloku.`);
    }
    return problems;
  }
  const listed = new Map();
  const doubled = [];
  for (const line of block.lines) {
    for (const k of line.numbers || []) {
      const address = `${line.id}#${k}`;
      if (listed.has(address)) doubled.push(address);
      listed.set(address, line);
    }
  }
  if (doubled.length) problems.push(`${compact(doubled)}: w dwóch liniach bloku unverified - każda pozycja stoi w nim dokładnie raz.`);
  const missing = required.filter((address) => !listed.has(address));
  // A prepared item listed anyway is tolerated: its verdict is the rulebook's either way.
  const extra = [...listed.keys()].filter((address) => !required.includes(address) && !rules.prepared[address]);
  if (missing.length) problems.push(`brak w bloku unverified: ${compact(missing)} - każda pozycja [ ] w co najmniej ${unverifiedMinFiles} plikach dostaje tu werdykt.`);
  if (extra.length) problems.push(`w bloku unverified pozycje, które nie są [ ] w co najmniej ${unverifiedMinFiles} plikach: ${compact(extra)} - blok obejmuje dokładnie te, które są.`);
  const cited = new Set();
  for (const section of report.files) {
    for (const finding of section.findings) {
      for (const tag of finding.tags || []) if (tag.address) cited.add(`${tag.address.id}#${tag.address.n}`);
    }
  }
  const finder = pathFinder(context, null, options.root, options.facts && options.facts.factRoot);
  for (const line of block.lines) {
    const verdict = verdictOfLine(line);
    if (verdict && verdict.word === 'BRAMKA') {
      problems.push(`${line.id}#${line.spec}: BRAMKA w bloku unverified - bramka zamyka instrukcję w części pliku; tu werdykt to OK, NARUSZENIE albo NIEZWERYFIKOWANE.`);
      continue;
    }
    problems.push(...checkTickLine(line, {}, null, finder));
    if (!verdict || verdict.word !== 'NARUSZENIE') continue;
    for (const k of line.numbers || []) {
      const address = `${line.id}#${k}`;
      if (!cited.has(address)) problems.push(`${address}: NARUSZENIE w bloku unverified bez znaleziska - znalezisko tej części ma "${address}" w polu Reguła.`);
    }
  }
  return problems;
}

// `options.readPart(k)` returns the text of part k (null when it does not exist);
// `options.sequential` also demands every earlier file's part - the hook's view, where
// the parts are being written one by one - and, unless `options.timing` is false, a gap of
// `partGapMs` after the part before, read from `options.writtenAt(k)` against `options.now`.
function checkPart(context, target, partPath, text, options = {}) {
  const m = path.basename(partPath).match(rePartName);
  if (!m) return [];
  const files = target.files || [];
  const n = files.length;
  const number = Number(m[2]);
  const digits = m[2].length;
  const stem = path.join(path.dirname(partPath), m[1]);
  const partFile = (k) => `${stem}.part${pad(k, digits)}.md`;
  const opts = {
    sequential: !!options.sequential,
    timing: options.timing !== false,
    readPart: options.readPart || ((k) => {
      try {
        return fs.readFileSync(partFile(k), 'utf8');
      } catch {
        return null;
      }
    }),
    writtenAt: options.writtenAt || ((k) => {
      try {
        return fs.statSync(partFile(k)).mtimeMs;
      } catch {
        return null;
      }
    }),
    now: options.now === undefined ? Date.now() : options.now,
    lineCount: options.lineCount || memoLineCount(),
    facts: options.facts === undefined ? readFacts(target) : options.facts,
    // Where a path in OK evidence is looked up: the project the context was built for.
    root: context.project || options.root || process.cwd(),
  };
  const problems = [];
  const width = Math.max(2, String(n + 2).length);
  if (digits !== width) {
    problems.push(`numer części ma ${digits} cyfr(y), a ten cel numeruje części na ${width} (liczba plików + 2 = ${n + 2}) - glob złożenia ułożyłby je w złej kolejności.`);
  }
  const body = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (n === 0) {
    if (number !== 1) problems.push(`cel bez plików ma jedną część, part${pad(1, width)} - nie ma części nr ${number}.`);
    else if (body.join('\n') !== render.emptyBodies[1]) problems.push(`cel bez plików ma w jedynej części wyłącznie linię "${render.emptyBodies[1]}".`);
    return problems;
  }
  if (number < 1 || number > n + 2) {
    problems.push(`numer części ${number} poza zakresem - pliki mają części 1-${n}, przejście międzyplikowe ${n + 1}, linia zamykająca celu bez znalezisk ${n + 2}.`);
    return problems;
  }

  // One part per response: the Write of part N-1 rides with the Reads of file N's bundle and
  // content, and part N comes in a response of its own, after that file's walk. The parts of
  // one batch come together, in the order of its bundles.
  if (opts.sequential && opts.timing && number >= 2 && number <= n + 1 && !sameBatch(target, number - 1, number)) {
    const written = opts.writtenAt(number - 1);
    if (written !== null && opts.now - written < partGapMs) {
      problems.push(`part${pad(number - 1, digits)} zapisano ${Math.max(0, (opts.now - written) / 1000).toFixed(1)} s temu - ${timingRefusal} (razem tylko części jednej partii z paczki): ta część idzie w następnej odpowiedzi.`);
    }
  }
  const { report, warnings } = parseWarnings(context, text);
  problems.push(...warnings);
  problems.push(...lineBounds(report, files, opts.lineCount));
  problems.push(...bundledFindings(report, new Set(context.checklistPerFile || [])));
  const scan = scanPart(text);
  if (number <= n + 1) {
    const stray = body.find((line) => render.emptyBodies.includes(line));
    if (stray) problems.push(`linia "${stray}" należy tylko do ostatniej części celu - tu parser urwałby na niej czytanie raportu.`);
  }
  if (number <= n) {
    problems.push(...checkFilePart(context, target, number, digits, scan, report, opts));
  } else if (number === n + 1) {
    if (scan.markers.length || scan.blocks.length) {
      problems.push('część przejścia międzyplikowego nie ma bloku checklisty ani markera coverage - te należą do części plików.');
    }
    if (opts.sequential) {
      const missing = [];
      for (let k = 1; k <= n; k++) if (opts.readPart(k) === null) missing.push(k);
      if (missing.length) problems.push(`przejście międzyplikowe przed częściami wszystkich plików - brakuje: ${listParts(missing, target, digits)}.`);
    }
    problems.push(...checkCrossPart(context, target, digits, scan, report, opts));
  } else {
    if (body.join('\n') !== render.emptyBodies[0]) problems.push(`ostatnia część celu bez znalezisk to wyłącznie linia "${render.emptyBodies[0]}".`);
    const withFindings = [];
    for (let k = 1; k <= n + 1; k++) if (hasFinding(opts.readPart(k))) withFindings.push(`part${pad(k, digits)}`);
    if (withFindings.length) {
      problems.push(`"${render.emptyBodies[0]}" przy znaleziskach w ${withFindings.slice(0, 5).join(', ')}${withFindings.length > 5 ? ', …' : ''} - ta linia zamyka tylko cel, w którym nic nie znaleziono.`);
    }
  }
  return problems;
}

function checkAssembly(context, target) {
  const files = target.files || [];
  const n = files.length;
  const dir = path.dirname(target.reportPath);
  const stemName = path.basename(target.reportPath).replace(/\.md$/i, '');
  const problems = [];
  let header = '';
  try {
    header = fs.readFileSync(target.reportPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  } catch {}
  if (!render.reHeader.test(header)) problems.push(`${target.reportPath}: brak nagłówka raportu (Step 4) - zapisz go przed złożeniem.`);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return [...problems, `nie można odczytać folderu raportu ${dir} (${(err && err.message) || err}).`];
  }
  const byNumber = new Map();
  const widths = new Set();
  for (const name of names) {
    const m = name.match(rePartName);
    if (!m || m[1] !== stemName) continue;
    const number = Number(m[2]);
    widths.add(m[2].length);
    if (byNumber.has(number)) {
      problems.push(`dwie części o numerze ${number}: ${byNumber.get(number).name} i ${name}.`);
      continue;
    }
    byNumber.set(number, { name, file: path.join(dir, name) });
  }
  if (byNumber.size === 0) return [...problems, `brak części raportu obok ${target.reportPath}.`];
  if (widths.size > 1) problems.push(`części mają numery różnej szerokości (${[...widths].join(', ')} cyfr) - glob złożenia ułoży je w złej kolejności.`);
  const textOf = (k) => {
    const part = byNumber.get(k);
    if (!part) return null;
    if (part.text === undefined) {
      try {
        part.text = fs.readFileSync(part.file, 'utf8');
      } catch {
        part.text = null;
      }
    }
    return part.text;
  };
  const lineCount = memoLineCount();
  const facts = readFacts(target);
  for (const number of [...byNumber.keys()].sort((a, b) => a - b)) {
    const part = byNumber.get(number);
    const text = textOf(number);
    if (text === null) {
      problems.push(`${part.name}: nie można odczytać.`);
      continue;
    }
    for (const problem of checkPart(context, target, part.file, text, { readPart: textOf, lineCount, facts })) {
      problems.push(`${part.name}: ${problem}`);
    }
  }
  const width = Math.max(2, String(n + 2).length);
  if (n === 0) {
    if (!byNumber.has(1)) problems.push(`brak części part${pad(1, width)} z linią "${render.emptyBodies[1]}".`);
    return problems;
  }
  const missing = [];
  for (let k = 1; k <= n; k++) if (!byNumber.has(k)) missing.push(k);
  if (missing.length) problems.push(`brak części plików: ${listParts(missing, target, width)} - każdy plik z target.files ma własną część.`);
  if (!byNumber.has(n + 1)) {
    problems.push(`brak części przejścia międzyplikowego (part${pad(n + 1, width)}) - przejście jest obowiązkowe, a gdy nic nie znalazło, jego część jest pusta.`);
  }
  let anyFinding = false;
  for (let k = 1; k <= n + 1; k++) if (hasFinding(textOf(k))) anyFinding = true;
  if (!anyFinding && !byNumber.has(n + 2)) {
    problems.push(`cel bez znalezisk kończy część part${pad(n + 2, width)} z jedną linią "${render.emptyBodies[0]}".`);
  }
  return problems;
}

// The coverage numbers are counted, not trusted: once every part passed, each file's marker is
// rewritten with the ticked items of its block and the plan's total, so a miscount never
// reaches the report and never stops it. Returns how many parts changed.
function rewriteCoverage(target) {
  const files = target.files || [];
  const width = Math.max(2, String(files.length + 2).length);
  const stem = String(target.reportPath).replace(/\.md$/i, '');
  let changed = 0;
  files.forEach((file, i) => {
    const partPath = `${stem}.part${pad(i + 1, width)}.md`;
    let text;
    try {
      text = fs.readFileSync(partPath, 'utf8');
    } catch {
      return;
    }
    const scan = scanPart(text);
    if (scan.markers.length !== 1 || scan.markers[0].value === 'mechanical') return;
    const ticked = new Set();
    for (const line of scan.lines) if (line.ticked) for (const k of line.numbers || []) ticked.add(`${line.id}#${k}`);
    const marker = `<!-- coverage: ${file.path} ${ticked.size}/${file.checklistTotal} -->`;
    const next = text.split(/(\r?\n)/).map((chunk) => (render.reCoverage.test(chunk.trim()) ? marker : chunk)).join('');
    if (next === text) return;
    fs.writeFileSync(partPath, next);
    changed++;
  });
  return changed;
}

// The fixed severities (facts.json `rules.severity`, by item address or instruction id) settle
// each finding's severity line once every part passed: the highest one its addresses carry -
// and the reviewer's own, when an address carries none and the reviewer's is higher. Returns
// how many findings changed.
function fixedLevel(addresses, fixed, current) {
  const levels = addresses.map((address) => fixed[address] || fixed[address.split('#')[0]] || null);
  const known = levels.filter(Boolean);
  if (known.length === 0) return null;
  const candidates = levels.some((level) => !level) && current ? [...known, current] : known;
  return candidates.reduce((best, level) => (rulebook.severityRank[level] > rulebook.severityRank[best] ? level : best));
}

function rewriteSeverities(target, facts) {
  const fixed = rulesOf(facts).severity;
  if (Object.keys(fixed).length === 0) return 0;
  const n = (target.files || []).length;
  const width = Math.max(2, String(n + 2).length);
  const stem = String(target.reportPath).replace(/\.md$/i, '');
  const byEmoji = new Map(render.severities.map((severity) => [severity.emoji, severity]));
  const byKey = new Map(render.severities.map((severity) => [severity.key, severity]));
  let changed = 0;
  for (let k = 1; k <= n + 1; k++) {
    const partPath = `${stem}.part${pad(k, width)}.md`;
    let text;
    try {
      text = fs.readFileSync(partPath, 'utf8');
    } catch {
      continue;
    }
    // Line chunks sit at the even indexes; the separators between them stay as they were.
    const chunks = text.split(/(\r?\n)/);
    const leads = [];
    let lead = null;
    let inRule = false;
    let comment = false;
    for (let i = 0; i < chunks.length; i += 2) {
      const line = chunks[i].trim();
      if (comment) {
        if (line.includes('-->')) comment = false;
        continue;
      }
      if (line.startsWith('<!--')) {
        comment = !line.includes('-->');
        inRule = false;
        continue;
      }
      const severity = line.match(render.reSeverity);
      if (severity) {
        lead = { index: i, current: byEmoji.get(severity[1]).key, addresses: [] };
        leads.push(lead);
        inRule = false;
        continue;
      }
      if (/^##\s/.test(line)) {
        lead = null;
        inRule = false;
        continue;
      }
      const field = line.match(/^-\s+\*\*([^*]+):\*\*\s?(.*)$/);
      const ruleText = field ? (field[1] === 'Reguła' ? field[2] : null) : (inRule && line ? line : null);
      if (field) inRule = field[1] === 'Reguła';
      else if (!line) inRule = false;
      if (lead && ruleText) {
        for (const segment of ruleText.split(';')) {
          const address = segment.trim().match(/^([a-z0-9][a-z0-9-]*)#(\d+)$/);
          if (address) lead.addresses.push(`${address[1]}#${address[2]}`);
        }
      }
    }
    let touched = 0;
    for (const { index, current, addresses } of leads) {
      const level = fixedLevel(addresses, fixed, current);
      if (!level || level === current || !byKey.has(level)) continue;
      const { emoji, label } = byKey.get(level);
      chunks[index] = `${chunks[index].match(/^\s*(?:-\s+)?/)[0]}${emoji} **${label}**`;
      touched++;
    }
    if (touched === 0) continue;
    fs.writeFileSync(partPath, chunks.join(''));
    changed += touched;
  }
  return changed;
}

// The coverage the assembly prints once the markers are counted: the finished report keeps
// the markers only under --with-checklist, so this line is where the run's summary reads them.
// A file whose only open items are the rulebook's prepared NIEZWERYFIKOWANE is walked in full:
// nothing was left that a review could have checked.
function coverageLine(target, facts = readFacts(target)) {
  const files = target.files || [];
  if (files.length === 0) return '';
  const width = Math.max(2, String(files.length + 2).length);
  const stem = String(target.reportPath).replace(/\.md$/i, '');
  const gaps = [];
  const { prepared } = rulesOf(facts);
  const preparedOpen = new Set();
  let mechanical = 0;
  let withPrepared = 0;
  files.forEach((file, i) => {
    let text;
    try {
      text = fs.readFileSync(`${stem}.part${pad(i + 1, width)}.md`, 'utf8');
    } catch {
      return;
    }
    const scan = scanPart(text);
    const marker = scan.markers[0];
    if (!marker) return;
    if (marker.value === 'mechanical') {
      mechanical++;
      return;
    }
    const [checked, total] = marker.value.split('/').map((n) => Number(n.trim()));
    if (checked >= total) return;
    const open = scan.lines.filter((line) => !line.ticked).flatMap((line) => (line.numbers || []).map((k) => `${line.id}#${k}`));
    if (open.length > 0 && open.length === total - checked && open.every((address) => prepared[address])) {
      withPrepared++;
      for (const address of open) preparedOpen.add(address);
      return;
    }
    gaps.push(`${file.path} ${checked}/${total}`);
  });
  const full = files.length - gaps.length;
  const notes = [
    ...(mechanical ? [`w tym mechaniczne: ${mechanical}`] : []),
    ...(withPrepared ? [`w tym z samymi gotowymi NIEZWERYFIKOWANE (${compact([...preparedOpen])}): ${withPrepared}`] : []),
  ];
  return `check-part: pliki z pełnym przejściem checklisty: ${full}/${files.length}`
    + `${notes.length ? ` (${notes.join('; ')})` : ''}${gaps.length ? `; niepełne: ${gaps.join(', ')}` : ''}.`;
}

// A refused part is not lost: its text waits in the work folder (removed with it at the
// assembly), where an Edit fixes only what the check named and `--promote` checks it again and
// moves it into place - instead of the whole part written out once more.
function draftPathOf(target, partPath) {
  const workDir = target.workDir || String(target.reportPath).replace(/\.md$/i, '.work');
  return path.join(workDir, path.basename(partPath).replace(/\.md$/i, '.draft.md'));
}

function saveDraft(target, partPath, text) {
  try {
    const draft = draftPathOf(target, partPath);
    fs.mkdirSync(path.dirname(draft), { recursive: true });
    fs.writeFileSync(draft, text);
    return draft;
  } catch {
    return null;
  }
}

function promoteCommand(contextPath, draft) {
  return `node "${__filename}" --context="${contextPath}" --promote="${draft}"`;
}

// A part lies in its run folder, `runs/<stamp>/<branchDir>/`, and the context in the
// cache folder of the run's FIRST target (review-context.cjs): the part's own branch
// first, then every other one, since a later target of a multi-branch run has its
// context in the first target's. Of several naming this report, the newest is the run's.
function findContextFor(partPath) {
  const m = path.basename(partPath).match(rePartName);
  if (!m) return null;
  const run = layout.runOf(partPath);
  if (!run) return null;
  const reportPath = path.join(run.dir, `${m[1]}.md`);
  const dirs = [layout.cacheDirOf(run.root, run.branchDir)];
  try {
    const cache = layout.cacheDirOf(run.root);
    for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
      const dir = path.join(cache, entry.name);
      if (entry.isDirectory() && entry.name !== run.branchDir) dirs.push(dir);
    }
  } catch {}
  let best = null;
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!reContextName.test(name)) continue;
      const file = path.join(dir, name);
      let context;
      let mtime;
      try {
        context = JSON.parse(fs.readFileSync(file, 'utf8'));
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const target = (context.targets || []).find((t) => t && t.reportPath && samePath(t.reportPath, reportPath));
      if (target && (!best || mtime > best.mtime)) best = { context, target, contextPath: file, mtime };
    }
  }
  return best;
}

function formatProblems(header, problems, notes = []) {
  const shown = problems.slice(0, maxListed);
  return [
    header,
    ...shown.map((problem) => `- ${problem}`),
    ...(problems.length > shown.length ? [`- … i ${problems.length - shown.length} więcej`] : []),
    ...notes,
    'Nie odhaczaj niczego, czego nie sprawdziłeś: pozycja bez pewnego werdyktu to "[ ] <adres> <etykieta> — NIEZWERYFIKOWANE: <narzędzie: | poza recenzją: | działająca aplikacja:> <czego zabrakło>".',
    '',
  ].join('\n');
}

// What to do with the draft a refusal left: fix it in place, then move it.
function draftNotes(contextPath, draft, onlyTiming) {
  return [
    onlyTiming
      ? `Treść części czeka bez zmian w szkicu ${draft} - w następnej odpowiedzi przenieś go poleceniem:`
      : `Treść części czeka w szkicu ${draft}: przeczytaj go narzędziem Read (wystarczą linie do poprawy) i popraw narzędziem Edit tylko wskazane miejsca. Po każdym Edit hook sprawdza szkic jeszcze raz i przenosi go na miejsce części (wynik przychodzi w kontekście hooka); bez tego komunikatu przenieś go poleceniem:`,
    promoteCommand(contextPath, draft),
  ];
}

function readStdin(deadlineMs) {
  return new Promise((resolve) => {
    let text = '';
    const timer = setTimeout(() => resolve(text), deadlineMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(text); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(text); });
  });
}

// A shell command as its simple commands, each a list of words: quoted text joins its word,
// redirect operators are words of their own, and heredoc bodies are dropped - they are data.
function shellCommands(command) {
  const lines = String(command).split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    for (const heredoc of lines[i].matchAll(/(?<!<)<<(?!<)-?\s*\\?(['"]?)([^\s'"<>|;&()]+)\1/g)) {
      while (i + 1 < lines.length && lines[i + 1].replace(/^\t+/, '') !== heredoc[2]) i++;
      i++;
    }
  }
  const text = kept.join('\n');
  const commands = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let quoted = '';
      for (i++; i < text.length && text[i] !== c; i++) {
        if (c === '"' && text[i] === '\\' && '$`"\\\n'.includes(text[i + 1])) i++;
        quoted += text[i];
      }
      word = (word || '') + quoted;
    } else if (c === '\\') {
      word = (word || '') + (text[++i] || '');
    } else if ('\n;|()'.includes(c) || (c === '&' && text[i + 1] !== '>')) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else if ('<>&'.includes(c)) {
      // The descriptor in front of an operator (the 2 of 2>) belongs to it, not to the words.
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      const operator = text.slice(i).match(/^(?:&>>?|<<<|<<-?|<>|<&|<|>>|>\||>&|>)/)[0];
      words.push(operator);
      i += operator.length - 1;
    } else {
      word = (word || '') + c;
    }
  }
  endCommand();
  return commands;
}

// Words the shell reads before the command itself: a compound's keyword, an assignment.
const shellKeywords = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '}', '!', 'time', 'command', 'builtin', 'exec', 'nohup']);

// A word as a path: Git Bash spells D:\x as /d/x, and `~` is the home folder. A word the shell
// has yet to expand (`$W`, `$(…)`, a backtick) is no path yet, and neither is a relative one
// in a folder only the shell knows: null.
function resolveWord(word, dir) {
  if (typeof word !== 'string' || word === '' || word === '-' || /[$`]/.test(word)) return null;
  let value = word === '~' || word.startsWith('~/') ? path.join(os.homedir(), word.slice(1)) : word;
  const drive = process.platform === 'win32' && value.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
  if (drive) value = `${drive[1]}:/${drive[2] || ''}`;
  if (!dir && !path.isAbsolute(value)) return null;
  return path.resolve(dir || '', value);
}

// The simple commands of a shell command with the folder each one runs in: `cd` and `pushd`
// move it, and a folder only the shell knows (`cd "$W"`, `cd -`, `popd`) leaves it unknown.
function shellSteps(command, cwd) {
  const steps = [];
  let dir = cwd || process.cwd();
  for (const raw of shellCommands(command)) {
    let start = 0;
    while (start < raw.length && (shellKeywords.has(raw[start]) || /^\w+=/.test(raw[start]))) start++;
    const words = raw.slice(start);
    if (!words.length) continue;
    steps.push({ words, cwd: dir });
    if (words[0] === 'cd' || words[0] === 'pushd') {
      const args = words.slice(1).filter((word) => !/^-[LPe@]+$/.test(word));
      dir = args.length ? resolveWord(args[0], dir) : (words[0] === 'cd' ? os.homedir() : null);
    } else if (words[0] === 'popd') {
      dir = null;
    }
  }
  return steps;
}

// Where a shell command writes, each target with the folder its command runs in: redirect
// targets, the files of tee, the last path of cp, mv or install, and every path an in-place sed
// or perl rewrites.
function shellWrites(command, cwd) {
  const targets = [];
  for (const { words, cwd: dir } of shellSteps(command, cwd)) {
    const add = (word) => {
      if (typeof word === 'string' && word !== '') targets.push({ word, dir });
    };
    const args = [];
    for (let i = 0; i < words.length; i++) {
      if (/^(?:>|>>|>\||>&|&>|&>>|<>)$/.test(words[i])) add(words[++i]);
      else if (/^(?:<|<&|<<|<<-|<<<)$/.test(words[i])) i++;
      else args.push(words[i]);
    }
    const name = args.length ? path.basename(args[0]) : '';
    const paths = args.slice(1).filter((arg) => !arg.startsWith('-'));
    if (name === 'tee') paths.forEach(add);
    else if (['cp', 'mv', 'install'].includes(name)) add(paths[paths.length - 1]);
    else if (['sed', 'perl'].includes(name) && args.some((arg) => /^-[a-zA-Z]*i|^--in-place/.test(arg))) paths.forEach(add);
  }
  return targets;
}

// A part written from the shell - cat > part <<'EOF', tee, cp or mv into it, sed -i on it - never
// reaches the check: the hook sees a command, not the part. A long part does not fit on a command
// line either, and the review's own quotes break the heredoc. So the command is refused whole.
function shellPartWrite(command, cwd) {
  const parts = new Set();
  for (const { word, dir } of shellWrites(command, cwd)) {
    const file = resolveWord(word, dir);
    const name = path.basename(file || word);
    // A target the shell has yet to expand, or one written from a folder only the shell knows,
    // is judged by its name: a part's name is enough to refuse it.
    if (rePartName.test(name) && (file === null || findContextFor(file))) parts.add(name);
  }
  if (parts.size === 0) return null;
  return [
    `Polecenie NIE zostało wykonane: zapisuje ${[...parts].join(', ')} z powłoki (codeReview SKILL.md, Step 3 point 4).`,
    'Część zapisuje się tylko narzędziem Write, a poprawkę narzędziem Edit: zapis z powłoki (przekierowanie, heredoc, tee, cp, mv, sed -i) omija kontrolę formatu części, a długa część nie mieści się w wierszu polecenia.',
    'Zapisz całą część jednym wywołaniem Write.',
    '',
  ].join('\n');
}

// Every redirect but `<`, which feeds the command the file after it.
const reShellRedirect = /^(?:>|>>|>\||>&|&>|&>>|<>|<&|<<|<<-|<<<)$/;

// Commands that print what they read. A search (grep) or a count (wc) is not the file.
const shellReaders = new Set([
  'cat', 'head', 'tail', 'sed', 'awk', 'gawk', 'nl', 'less', 'more', 'bat', 'batcat', 'tac', 'cut', 'od', 'xxd',
  'hexdump', 'strings', 'pr', 'fold', 'column', 'paste', 'rev', 'sort', 'uniq', 'expand', 'fmt', 'iconv',
]);

// `{a,b}` as bash expands it before globbing, one group at a time; `${f}` has no comma and stays.
function expandBraces(word) {
  const m = word.match(/^(.*?)(?<!\$)\{([^{}]*,[^{}]*)\}(.*)$/);
  if (!m) return [word];
  return m[2].split(',').flatMap((choice) => expandBraces(m[1] + choice + m[3]));
}

function globRegex(segment) {
  let re = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    const end = c === '[' ? segment.indexOf(']', i + 2) : -1;
    if (c === '*') re += '[^/\\\\]*';
    else if (c === '?') re += '[^/\\\\]';
    else if (end !== -1) {
      const body = segment.slice(i + 1, end);
      re += `[${body[0] === '!' ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, (x) => `\\${x}`);
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

// The files an absolute glob matches, segment by segment; a `*` passes over dot files, as in bash.
function globFiles(pattern) {
  const { root } = path.parse(pattern);
  let current = [root];
  for (const segment of pattern.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    if (!/[*?[]/.test(segment)) {
      current = current.map((dir) => path.join(dir, segment));
      continue;
    }
    const re = globRegex(segment);
    const next = [];
    for (const dir of current) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) if (re.test(name) && (segment.startsWith('.') || !name.startsWith('.'))) next.push(path.join(dir, name));
    }
    current = next;
  }
  return current.filter((file) => fs.existsSync(file));
}

// A word as the words bash hands the command: braces and globs expanded against the disk, a
// relative glob's matches kept relative, a glob matching nothing passed on as written.
function expandWord(word, dir) {
  const words = [];
  for (const choice of expandBraces(word)) {
    const pattern = /[*?[]/.test(choice) ? resolveWord(choice, dir) : null;
    const matches = pattern ? globFiles(pattern) : [];
    if (!matches.length) {
      words.push(choice);
      continue;
    }
    const relative = !path.isAbsolute(choice) && !/^[~/]/.test(choice);
    words.push(...matches.map((file) => (relative ? path.relative(dir, file).replace(/\\/g, '/') : file)));
  }
  return words;
}

// Where contexts are looked for: the skill's own reports folder, and each folder at or above the
// given ones that holds a codeReview cache (`<project>/.claude/doh/codeReview`).
function reviewRootsFor(dirs) {
  const roots = new Map([[pathKey(path.join(__dirname, '..', 'reports')), path.join(__dirname, '..', 'reports')]]);
  const seen = new Set();
  for (const start of dirs) {
    if (!start) continue;
    for (let dir = path.resolve(start); !seen.has(pathKey(dir)); dir = path.dirname(dir)) {
      seen.add(pathKey(dir));
      const root = path.join(dir, '.claude', 'doh', 'codeReview');
      if (fs.existsSync(layout.cacheDirOf(root))) roots.set(pathKey(root), root);
    }
  }
  return [...roots.values()];
}

// What a review in progress reads with Read - each reviewed file and the content, diff and bundles
// its context made of it - for every target whose work folder is still on disk. Keyed by path,
// with the name the refusal shows.
function guardedFiles(roots) {
  const guarded = new Map();
  const add = (file, name) => {
    if (typeof file === 'string' && file && !guarded.has(pathKey(file))) guarded.set(pathKey(file), name);
  };
  for (const root of roots) {
    const cache = layout.cacheDirOf(root);
    const dirs = [cache];
    try {
      for (const entry of fs.readdirSync(cache, { withFileTypes: true })) if (entry.isDirectory()) dirs.push(path.join(cache, entry.name));
    } catch {
      continue;
    }
    for (const dir of dirs) {
      let names;
      try {
        names = fs.readdirSync(dir).filter((name) => reContextName.test(name));
      } catch {
        continue;
      }
      for (const name of names) {
        let context;
        try {
          context = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        } catch {
          continue;
        }
        for (const target of context.targets || []) {
          if (!target || !target.workDir || !fs.existsSync(target.workDir)) continue;
          for (const file of target.files || []) {
            if (context.project && file.path) add(path.resolve(context.project, file.path), file.path);
            for (const key of ['contentPath', 'diffPath', 'bundlePath']) add(file[key], path.basename(String(file[key])));
          }
          for (const key of ['crossBundlePath', 'factsPath']) add(target[key], path.basename(String(target[key])));
        }
      }
    }
  }
  return guarded;
}

// `sed -n '<N>p' <file>` on a line Read cuts short is the one read the shell keeps.
function longLineRead(words, file) {
  const scripts = [];
  for (let i = 1; i < words.length; i++) {
    if (reShellRedirect.test(words[i])) i++;
    else if (!words[i].startsWith('-')) scripts.push(words[i]);
  }
  const quiet = words.some((word) => /^-[a-zA-Z]*n[a-zA-Z]*$|^--(?:quiet|silent)$/.test(word));
  const m = scripts.length === 2 && scripts[0].match(/^(\d+)p$/);
  if (words[0] !== 'sed' || !quiet || !m) return false;
  try {
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/)[Number(m[1]) - 1];
    return line !== undefined && line.length > readLineLimit;
  } catch {
    return false;
  }
}

// A reviewed file printed from the shell - cat -n, head, sed -n, a for loop over the files -
// reaches the reviewer compressed on its way back and without the line numbers Read gives and a
// part cites. The command is refused whole, before it runs.
function shellReviewRead(command, cwd, roots = null) {
  const loops = new Map();
  const reads = [];
  for (const { words, cwd: dir } of shellSteps(command, cwd)) {
    if (words[0] === 'for' && words[2] === 'in') {
      loops.set(words[1], words.slice(3).flatMap((word) => expandWord(word, dir)));
      continue;
    }
    const name = path.basename(words[0]).replace(/\.exe$/i, '');
    // An in-place sed rewrites the file instead of printing it.
    if (!shellReaders.has(name) || (name === 'sed' && words.some((word) => /^-[a-zA-Z]*i|^--in-place/.test(word)))) continue;
    const step = [name, ...words.slice(1)];
    for (let i = 1; i < words.length; i++) {
      let word = words[i];
      if (reShellRedirect.test(word)) {
        i++;
        continue;
      }
      if (word === '<') word = words[++i];
      else if (word.startsWith('-')) continue;
      if (typeof word !== 'string') continue;
      // `$f` of a `for f in …` stands for each of the loop's words.
      const variable = [...word.matchAll(/\$\{?(\w+)\}?/g)].map((v) => v[1]).find((v) => loops.has(v));
      const choices = variable
        ? loops.get(variable).map((value) => word.replace(new RegExp(`\\$\\{${variable}\\}|\\$${variable}(?!\\w)`, 'g'), () => value))
        : expandWord(word, dir);
      for (const choice of choices) {
        const file = resolveWord(choice, dir);
        if (file) reads.push({ file, step });
      }
    }
  }
  if (!reads.length) return null;
  const guarded = guardedFiles(roots || reviewRootsFor([cwd, ...reads.map((read) => path.dirname(read.file))]));
  const hits = new Set();
  for (const { file, step } of reads) {
    const name = guarded.get(pathKey(file));
    if (name !== undefined && !longLineRead(step, file)) hits.add(name);
  }
  if (hits.size === 0) return null;
  const shown = [...hits].slice(0, 5).join(', ') + (hits.size > 5 ? `, … (${hits.size} razem)` : '');
  return [
    `Polecenie NIE zostało wykonane: wypisuje z powłoki plik recenzji: ${shown} (codeReview SKILL.md, Step 3).`,
    'Recenzowany plik, jego diff i paczkę czyta się narzędziem Read (offset i limit dla fragmentu): wynik powłoki wraca skompresowany i bez numerów linii, które cytuje część.',
    `Szukanie (grep) i liczenie (wc) przechodzą. Jedyny odczyt z powłoki to linia dłuższa niż ${readLineLimit} znaków, którą Read ucina: sed -n '<N>p' <plik>.`,
    '',
  ].join('\n');
}

// Two findings of one part over the same lines whose addresses are the two sides of a `sameAs`
// pair: one defect reported twice, most likely. Named, not refused - the lines may hold two.
function sameDefectNotes(report, rules) {
  const notes = [];
  for (const section of report.files) {
    const findings = section.findings;
    for (let i = 0; i < findings.length; i++) {
      for (let j = i + 1; j < findings.length; j++) {
        const a = lineSet(findings[i].lines);
        const b = lineSet(findings[j].lines);
        if (a.size === 0 || a.size !== b.size || ![...a].every((k) => b.has(k))) continue;
        const other = addressesOf(findings[j]);
        const pair = addressesOf(findings[i]).flatMap((x) => (rules.sameAs[x] || []).filter((y) => other.includes(y)).map((y) => `${x} i ${y}`));
        if (pair.length) {
          notes.push(`${section.path}: dwa znaleziska z pola Linia "${findings[i].lines}" pod ${pair[0]} - paczka oznacza te pozycje "ta sama wada". Jeśli to jedna wada, scal je jednym Edit tej części: jedno znalezisko, oba adresy w polu Reguła (najbardziej szczegółowy pierwszy).`);
        }
      }
    }
  }
  return notes;
}

// Resolves to what the hook prints and its exit code; any throw on the way means exit 0.
// A string refuses the call (exit 2); `{ context }` lets it through with a note for the model.
function hookResult(input) {
  const tool = input && input.tool_name;
  const args = (input && input.tool_input) || {};
  if (tool === 'Bash') return shellPartWrite(args.command || '', input.cwd) || shellReviewRead(args.command || '', input.cwd);
  const file = args.file_path;
  if ((tool !== 'Write' && tool !== 'Edit') || typeof file !== 'string' || !rePartName.test(path.basename(file))) return null;
  const found = findContextFor(file);
  if (!found) return null;
  let text;
  if (tool === 'Write') {
    text = String(args.content === undefined || args.content === null ? '' : args.content);
  } else {
    // An Edit is checked as the file it would leave behind.
    const current = fs.readFileSync(file, 'utf8');
    if (typeof args.old_string !== 'string' || !current.includes(args.old_string)) return null;
    const replacement = String(args.new_string === undefined || args.new_string === null ? '' : args.new_string);
    text = args.replace_all ? current.split(args.old_string).join(replacement) : current.replace(args.old_string, () => replacement);
  }
  const facts = readFacts(found.target);
  const problems = checkPart(found.context, found.target, file, text, { sequential: true, root: input.cwd, facts });
  if (problems.length === 0) {
    const notes = sameDefectNotes(partReport(text), rulesOf(facts));
    return notes.length ? { context: [`check-part: ${path.basename(file)} zapisana, z uwagą:`, ...notes.map((note) => `- ${note}`)].join('\n') } : null;
  }
  const draft = saveDraft(found.target, file, text);
  if (!draft) {
    return formatProblems(
      `Część ${path.basename(file)} NIE została zapisana: nie przeszła kontroli formatu (codeReview SKILL.md, Step 3 point 4). Popraw ją i zapisz całą jeszcze raz:`,
      problems,
    );
  }
  return formatProblems(
    `Część ${path.basename(file)} NIE została zapisana: nie przeszła kontroli formatu (codeReview SKILL.md, Step 3 point 4):`,
    problems,
    draftNotes(found.contextPath, draft, problems.every((problem) => problem.includes(timingRefusal))),
  );
}

// A draft checked as the part it stands for - the same rules as the hook - and moved into place
// when it passes. `timing` false leaves out the one-response gap: a draft an Edit fixed is a
// response of its own. A draft older than its part is stale - the part was written again since -
// and is removed. Resolves to `{ partName, state: 'promoted' | 'stale' | 'refused', problems }`.
function promoteDraft(found, draft, { timing = true, root } = {}) {
  const partName = path.basename(draft).replace(/\.draft\.md$/i, '.md');
  const partPath = path.join(path.dirname(found.target.reportPath), partName);
  let draftTime = null;
  let partTime = null;
  try {
    draftTime = fs.statSync(draft).mtimeMs;
    partTime = fs.statSync(partPath).mtimeMs;
  } catch {}
  if (draftTime !== null && partTime !== null && draftTime <= partTime) {
    fs.rmSync(draft, { force: true });
    return { partName, state: 'stale', problems: [] };
  }
  let text;
  try {
    text = fs.readFileSync(draft, 'utf8');
  } catch (err) {
    return { partName, state: 'refused', problems: [`nie można odczytać szkicu ${draft} (${(err && err.message) || err}).`] };
  }
  const problems = checkPart(found.context, found.target, partPath, text, { sequential: true, timing, root });
  if (problems.length > 0) return { partName, state: 'refused', problems };
  fs.writeFileSync(partPath, text);
  fs.rmSync(draft, { force: true });
  return { partName, state: 'promoted', problems: [] };
}

// The other drafts of the target, in part order, each tried once more after one landed: a part
// refused only because an earlier one was missing passes now.
function promoteLater(found, options = {}) {
  const workDir = found.target.workDir || String(found.target.reportPath).replace(/\.md$/i, '.work');
  let names = [];
  try {
    names = fs.readdirSync(workDir).filter((name) => /\.part\d+\.draft\.md$/i.test(name)).sort();
  } catch {}
  const results = [];
  for (const name of names) {
    const result = promoteDraft(found, path.join(workDir, name), options);
    results.push(result);
  }
  return results.filter((result) => result.state !== 'refused');
}

// `--promote=<draft>`: promoteDraft from the command line. Exit 1 keeps the draft for another Edit.
function promote(args) {
  const draft = path.resolve(args.promote);
  const partName = path.basename(draft).replace(/\.draft\.md$/i, '.md');
  try {
    fs.accessSync(draft, fs.constants.R_OK);
  } catch (err) {
    process.stderr.write(`Nie można odczytać szkicu ${draft} (${(err && err.message) || err}).\n`);
    return 1;
  }
  if (!rePartName.test(partName) || partName === path.basename(draft)) {
    process.stderr.write(`${draft} nie jest szkicem części (<stem>.partNN.draft.md).\n`);
    return 1;
  }
  // The draft lies in the target's work folder, `<stem>.work`, next to the report `<stem>.md`.
  const reportPath = path.join(path.dirname(path.dirname(draft)), path.basename(path.dirname(draft)).replace(/\.work$/i, '.md'));
  let found = null;
  if (args.context) {
    let context;
    try {
      context = JSON.parse(fs.readFileSync(args.context, 'utf8'));
    } catch (err) {
      process.stderr.write(`Nie można odczytać kontekstu ${args.context} (${(err && err.message) || err}).\n`);
      return 1;
    }
    const target = (context.targets || []).find((t) => t && t.reportPath && samePath(path.dirname(draftPathOf(t, partName)), path.dirname(draft)));
    if (target) found = { context, target, contextPath: args.context };
  } else {
    found = findContextFor(path.join(path.dirname(reportPath), partName));
  }
  if (!found) {
    process.stderr.write(`Żaden cel kontekstu nie ma folderu roboczego ${path.dirname(draft)}.\n`);
    return 1;
  }
  const result = promoteDraft(found, draft);
  if (result.state === 'refused') {
    process.stderr.write(formatProblems(
      `Szkic ${path.basename(draft)} NIE został przeniesiony do ${partName}: nie przeszedł kontroli formatu (codeReview SKILL.md, Step 3 point 4):`,
      result.problems,
      draftNotes(found.contextPath, draft, result.problems.every((problem) => problem.includes(timingRefusal))),
    ));
    return 1;
  }
  process.stdout.write(result.state === 'stale'
    ? `check-part: ${partName} zapisano po tym szkicu - szkic był nieaktualny i został usunięty.\n`
    : `check-part: ${partName} zapisana ze szkicu.\n`);
  for (const later of promoteLater(found)) {
    if (later.state === 'promoted') process.stdout.write(`check-part: ${later.partName} zapisana ze szkicu.\n`);
  }
  return 0;
}

function assemble(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m && (m[1] === 'context' || m[1] === 'report' || m[1] === 'promote')) args[m[1]] = m[2];
    else {
      process.stderr.write(`Nieznany argument: ${arg} (oczekiwano --context=<contextPath> --report=<reportPath> albo --promote=<szkic>).\n`);
      return 1;
    }
  }
  if (args.promote) return promote(args);
  if (!args.context || !args.report) {
    process.stderr.write('Brak --context=<contextPath> albo --report=<reportPath>.\n');
    return 1;
  }
  let context;
  try {
    context = JSON.parse(fs.readFileSync(args.context, 'utf8'));
  } catch (err) {
    process.stderr.write(`Nie można odczytać kontekstu ${args.context} (${(err && err.message) || err}).\n`);
    return 1;
  }
  const target = (context.targets || []).find((t) => t && t.reportPath && samePath(t.reportPath, args.report));
  if (!target) {
    process.stderr.write(`Kontekst ${args.context} nie ma celu z reportPath ${args.report}.\n`);
    return 1;
  }
  const problems = checkAssembly(context, target);
  if (problems.length > 0) {
    process.stderr.write(formatProblems(
      `Części raportu ${args.report} nie przeszły kontroli - raport NIE został złożony, części zostają na dysku. Popraw wskazane części (Edit wskazanych miejsc; brakującą część zapisz przez Write) i uruchom złożenie jeszcze raz:`,
      problems,
    ));
    return 1;
  }
  const rewritten = rewriteCoverage(target);
  const where = `${rewritten} ${rewritten === 1 ? 'części' : 'częściach'}`;
  process.stdout.write(`check-part: części raportu ${path.basename(args.report)} są kompletne i poprawne${rewritten ? ` (markery coverage przeliczone w ${where})` : ''}.\n`);
  const facts = readFacts(target);
  const severities = rewriteSeverities(target, facts);
  if (severities) process.stdout.write(`check-part: ważność stała z rulebooka ustawiona w ${severities} ${severities === 1 ? 'znalezisku' : 'znaleziskach'}.\n`);
  const coverage = coverageLine(target, facts);
  if (coverage) process.stdout.write(`${coverage}\n`);
  return 0;
}

module.exports = {
  checkPart, checkAssembly, findContextFor, hookResult, scanPart, planItems, compact,
  rewriteCoverage, rewriteSeverities, coverageLine, draftPathOf, shellReviewRead, shellWrites, expandWord,
  promoteDraft, promoteLater, reportedState, readFacts, sameBatch, formatProblems, rePartName,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    process.exit(assemble(argv));
  } else {
    readStdin(5000)
      .then((raw) => hookResult(JSON.parse(raw)))
      .then((message) => {
        if (!message) process.exit(0);
        if (typeof message === 'object') {
          const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message.context } };
          process.stdout.write(JSON.stringify(output), () => process.exit(0));
          return;
        }
        process.stderr.write(message, () => process.exit(2));
      })
      .catch(() => process.exit(0));
  }
}
