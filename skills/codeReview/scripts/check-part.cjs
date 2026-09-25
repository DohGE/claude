#!/usr/bin/env node
'use strict';

// Deterministic check of the part files a codeReview run writes (SKILL.md Step 3 point 4),
// against the context that planned them. Two entry points share one set of rules:
// - PreToolUse hook (no arguments): stdin carries a Write or Edit call. A `<stem>.partNN.md`
//   whose `<stem>.md` is a target of a `.review-context-*.json` next to it is checked BEFORE
//   it lands, and exit 2 hands the problems back while that file's walk is still in front of
//   the reviewer. Anything else, and any failure of the checker itself, exits 0: a broken
//   check must never stop a Write.
// - Assembly (`--context=<contextPath> --report=<reportPath>`): every part on disk again, plus
//   what only the whole set shows - a file without a part, a numbering the shell glob would
//   put out of order, a clean target without its closing line. Exit 1 keeps the parts.
// Everything checked here is something the report format already demanded and nothing read
// back: a bare `OK`, a verdict deferred to another item, a violation ticked with no finding
// behind it, a gate closed for an instruction that has none, one finding carrying several
// items of one checklist or one file's defect split across two. Each of those passed the
// renderer, and each one hid a finding or doubled one.

const fs = require('node:fs');
const path = require('node:path');
const render = require('./render-report.cjs');

const rePartName = /^(.*)\.part(\d+)\.md$/i;
const reContextName = /^\.review-context-[a-z]+\.json$/;
// The verdict is the first `— WORD` after the address: the label before it is the reviewer's
// own two to six words, the text after it the evidence or the reason.
const reVerdict = /(?:^|\s)[—–-]\s*(OK|NARUSZENIE|BRAMKA|NIEZWERYFIKOWANE)(?![\p{L}\p{N}_])/u;
const reAddress = /[a-z0-9][a-z0-9-]*#\d+/i;
// FIXED IDENTIFIER (SKILL.md Step 3 point 4): the one evidence an OK may give instead of lines.
const noOccurrence = 'brak wystąpień';
const maxListed = 40;

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function pad(number, digits) {
  return String(number).padStart(digits, '0');
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

// The checklist lines and coverage markers of one part, read line by line the way
// `parseReport` reads them - it keeps the ticks per item, the checks below need them per line.
function scanPart(text) {
  const markers = [];
  const blocks = [];
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
    const marker = line.match(render.reCoverage);
    if (marker) markers.push({ path: marker[1], value: marker[2] });
  });
  return { markers, blocks, lines: blocks.flatMap((b) => b.lines) };
}

// The renderer's own parse, so every drift it would warn about at the end is named while the
// part can still be rewritten. A `sprawdzono N/M` warning is an honest `[ ]`, never a drift,
// and an `--only-md` run writes no PR fields at all.
function parseWarnings(context, text) {
  const report = render.parseReport(`# Code Review: part | 2000-01-01 00:00\n${text}`);
  const warnings = report.warnings
    .filter((w) => !/: sprawdzono \d+\/\d+ pozycji checklist/.test(w))
    .filter((w) => context.outputFormat !== 'md' || !/znalezisko bez pola "PR (?:Problem|Expected|Locations)"/.test(w))
    .map((w) => w.replace(/\b([Ll]ini[ai])\s+(\d+)/g, (m, word, n) => `${word} ${Number(n) - 1}`));
  return { report, warnings };
}

function verdictOfLine(line) {
  const v = line.rest.match(reVerdict);
  return v ? { word: v[1], after: line.rest.slice(v.index + v[0].length).trim() } : null;
}

function checkTickLine(line, gates, count) {
  const at = `${line.id}#${line.spec}`;
  const verdict = verdictOfLine(line);
  if (!verdict) {
    return [`${at}: brak werdyktu - po adresie i etykiecie stoi "— OK (…)", "— NARUSZENIE (…)", "— BRAMKA: …" albo "— NIEZWERYFIKOWANE: …".`];
  }
  const problems = [];
  const { word, after } = verdict;
  if (word === 'NIEZWERYFIKOWANE') {
    if (line.ticked) problems.push(`${at}: NIEZWERYFIKOWANE przy [x] - niesprawdzona pozycja ma puste pole [ ].`);
    if (!/^:\s*\S/.test(after)) problems.push(`${at}: NIEZWERYFIKOWANE bez powodu - zapis to "— NIEZWERYFIKOWANE: <czego zabrakło>".`);
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
    if (!inner) {
      problems.push(`${at}: OK bez dowodu - zapis to "— OK (L12, L18)" z liniami tego pliku albo "— OK (${noOccurrence})".`);
    } else if (deferred) {
      problems.push(`${at}: OK odsyła do ${deferred[0]} - kod, który łamie pozycję, nigdy jej nie spełnia: dostaje własne NARUSZENIE. Jej adres dochodzi do pola Reguła znaleziska ${deferred[0]} (najbardziej szczegółowy pierwszy), gdy to to samo wymaganie w innej instrukcji albo obie są pozycjami instrukcji z findings: per-file; inna pozycja tej samej instrukcji to inne wymaganie i własne znalezisko.`);
    } else if (!inner.toLowerCase().includes(noOccurrence) && !/(^|[^\p{L}\p{N}])L?\d+/u.test(inner)) {
      problems.push(`${at}: dowód OK "(${inner})" nie wskazuje linii tego pliku ani "${noOccurrence}".`);
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
    for (let k = 1; k < number; k++) if (options.readPart(k) === null) missing.push(k);
    if (missing.length) {
      problems.push(`najpierw brakujące wcześniejsze części: ${listParts(missing, target, digits)} - pliki idą po kolei, a część każdego jest zapisana, zanim otworzysz następny.`);
    }
  }
  if (scan.markers.length === 0) {
    problems.push(`brak markera coverage - część kończy linia "<!-- coverage: ${file.path} <sprawdzone>/${file.checklistTotal} -->".`);
  } else if (scan.markers.length > 1) {
    problems.push(`${scan.markers.length} markery coverage - część jednego pliku ma dokładnie jeden.`);
  }
  if (scan.blocks.length > 1) problems.push(`${scan.blocks.length} bloki checklisty - część jednego pliku ma najwyżej jeden.`);
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
  if (marker) {
    const total = Number(marker.value.split('/')[1]);
    if (total !== file.checklistTotal) problems.push(`marker podaje ${total} pozycji, a plan pliku ma ${file.checklistTotal} (checklistTotal).`);
  }

  const gates = context.checklistGates || {};
  const count = options.lineCount(file);
  const verdictOf = new Map();
  const wordsById = new Map();
  for (const line of scan.lines) {
    problems.push(...checkTickLine(line, gates, count));
    const verdict = verdictOfLine(line);
    if (!verdict || !line.numbers) continue;
    for (const k of line.numbers) verdictOf.set(`${line.id}#${k}`, verdict.word);
    if (!wordsById.has(line.id)) wordsById.set(line.id, new Set());
    wordsById.get(line.id).add(verdict.word);
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

// `options.readPart(k)` returns the text of part k (null when it does not exist);
// `options.sequential` also demands every earlier file's part - the hook's view, where
// the parts are being written one by one.
function checkPart(context, target, partPath, text, options = {}) {
  const m = path.basename(partPath).match(rePartName);
  if (!m) return [];
  const files = target.files || [];
  const n = files.length;
  const number = Number(m[2]);
  const digits = m[2].length;
  const stem = path.join(path.dirname(partPath), m[1]);
  const opts = {
    sequential: !!options.sequential,
    readPart: options.readPart || ((k) => {
      try {
        return fs.readFileSync(`${stem}.part${pad(k, digits)}.md`, 'utf8');
      } catch {
        return null;
      }
    }),
    lineCount: options.lineCount || memoLineCount(),
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
  for (const number of [...byNumber.keys()].sort((a, b) => a - b)) {
    const part = byNumber.get(number);
    const text = textOf(number);
    if (text === null) {
      problems.push(`${part.name}: nie można odczytać.`);
      continue;
    }
    for (const problem of checkPart(context, target, part.file, text, { readPart: textOf, lineCount })) {
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

// The context sits next to the FIRST target's report; the other targets of a multi-branch
// run write their parts in sibling branch folders of the same reports dir.
function findContextFor(partPath) {
  const m = path.basename(partPath).match(rePartName);
  if (!m) return null;
  const partDir = path.dirname(path.resolve(partPath));
  const reportPath = path.join(partDir, `${m[1]}.md`);
  const dirs = [partDir];
  try {
    const parent = path.dirname(partDir);
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const dir = path.join(parent, entry.name);
      if (entry.isDirectory() && dir !== partDir) dirs.push(dir);
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

function formatProblems(header, problems) {
  const shown = problems.slice(0, maxListed);
  return [
    header,
    ...shown.map((problem) => `- ${problem}`),
    ...(problems.length > shown.length ? [`- … i ${problems.length - shown.length} więcej`] : []),
    'Nie odhaczaj niczego, czego nie sprawdziłeś: pozycja bez pewnego werdyktu to "[ ] <adres> <etykieta> — NIEZWERYFIKOWANE: <powód>".',
    '',
  ].join('\n');
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

// Resolves to what the hook prints and its exit code; any throw on the way means exit 0.
function hookResult(input) {
  const tool = input && input.tool_name;
  const args = (input && input.tool_input) || {};
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
  const problems = checkPart(found.context, found.target, file, text, { sequential: true });
  if (problems.length === 0) return null;
  return formatProblems(
    `Część ${path.basename(file)} NIE została zapisana: nie przeszła kontroli formatu (codeReview SKILL.md, Step 3 point 4). Popraw ją i zapisz całą jeszcze raz:`,
    problems,
  );
}

function assemble(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m && m[1] === 'context') args.context = m[2];
    else if (m && m[1] === 'report') args.report = m[2];
    else {
      process.stderr.write(`Nieznany argument: ${arg} (oczekiwano --context=<contextPath> --report=<reportPath>).\n`);
      return 1;
    }
  }
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
      `Części raportu ${args.report} nie przeszły kontroli - raport NIE został złożony, części zostają na dysku. Popraw wskazane części (Write całej części) i uruchom złożenie jeszcze raz:`,
      problems,
    ));
    return 1;
  }
  process.stdout.write(`check-part: części raportu ${path.basename(args.report)} są kompletne i poprawne.\n`);
  return 0;
}

module.exports = { checkPart, checkAssembly, findContextFor, hookResult, scanPart, planItems, compact };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    process.exit(assemble(argv));
  } else {
    readStdin(5000)
      .then((raw) => hookResult(JSON.parse(raw)))
      .then((message) => {
        if (!message) process.exit(0);
        process.stderr.write(message, () => process.exit(2));
      })
      .catch(() => process.exit(0));
  }
}
