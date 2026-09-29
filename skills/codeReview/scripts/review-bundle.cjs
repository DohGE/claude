'use strict';

// What the reviewer reads next to each file in Step 3 - the file's bundle: the items its plan
// walks, with the repository facts and probe hits bound to the item they concern, the
// consumers of its exports and the duplication candidates on it. One Read per file, next to
// the file itself, replaces the whole rulebook read up front and a lookup per question, and a
// line the verdict must answer stands under the item that answers it. `facts.json` holds the
// same bindings for check-part.cjs, which refuses a verdict that ignores them.
// Pure functions: review-context.cjs gathers the input (repo-facts.cjs, the rulebook, jscpd).

const path = require('node:path');
const repoFacts = require('./repo-facts.cjs');
const rulebook = require('./rulebook.cjs');
const render = require('./render-report.cjs');

// FIXED IDENTIFIERS. The line prefixes are what SKILL.md tells the reviewer to answer: a
// translated `FAKT` or `SONDA` is a line the reviewer no longer reads as binding. The file
// names and the facts.json fields (`files`, `items`, `strong`, `hints`, `probes`,
// `secondQuestion`, `info`, `factRoot`, `partial`, `rules`) are what check-part.cjs reads:
// renamed, a binding is silently not enforced.
const linePrefix = { strong: 'FAKT', hint: 'WSKAZÓWKA', probe: 'SONDA', second: 'drugie pytanie:' };
// What the plan says of an item beyond its text: the severity its finding carries, the item of
// another instruction that states the same requirement, the verdict no review can do better than.
const itemPrefix = { severity: 'ważność stała:', sameAs: 'ta sama wada:', prepared: 'gotowy werdykt:' };
const factsFileName = 'facts.json';
const crossBundleName = 'cross-file.bundle.md';
const notesFileName = 'rulebook-notes.md';
const factsVersion = 1;
// The cross bundle's section review-hooks.cjs rewrites before every Read of it: what the file
// parts on disk already report, and the items they left open in `unverifiedMinFiles` files.
const reportedStart = '<!-- reported:start -->';
const reportedEnd = '<!-- reported:end -->';
const unverifiedMinFiles = 3;
// The instructions the cross-file pass reports under (SKILL.md Step 3), with the items it
// walks when not all of them: accessibility#22 is the consistency of repeated views.
const crossInstructions = [['code-quality', null], ['architecture', null], ['general', null], ['accessibility', [22]]];
// Consecutive light files are walked in one response (SKILL.md Step 3 point 4): a turn re-sends
// the whole conversation, which for a ten-line barrel costs more than its walk. A file over
// either `file*` limit keeps a response of its own, and a batch stops at any of the others.
const batchLimits = { fileLines: 60, fileItems: 60, files: 3, lines: 150, items: 120 };
// The skill folder, named in the bundles' pointers to its reference files.
const skillDir = path.resolve(__dirname, '..').replace(/\\/g, '/');

const lineList = (lines) => lines.map((line) => `L${line}`).join(', ');
const short = (p, root) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
const capped = (items, limit = 8) => (items.length > limit ? `${items.slice(0, limit).join(', ')} (+${items.length - limit})` : items.join(', '));
const pad = (number, width) => String(number).padStart(width, '0');
const partWidth = (files) => Math.max(2, String(files + 2).length);
// `<stem>.partNN.md` next to the report: the file number, padded like every part of the target.
const partPathOf = (reportPath, number, files) => `${String(reportPath).replace(/\\/g, '/').replace(/\.md$/i, '')}.part${pad(number, partWidth(files))}.md`;

// The severity lead line a finding copies: `🔴 **High**`.
function severityText(level) {
  const severity = render.severities.find((s) => s.key === level);
  return severity ? `${severity.emoji} **${severity.label}**` : level;
}

// The lines of a text as Read numbers them: a trailing newline opens no line of its own.
function lineCountOf(text) {
  if (typeof text !== 'string') return null;
  const count = text.split('\n').length;
  return text.endsWith('\n') ? count - 1 : count;
}

// What each walked item of one file owes the facts and probes. A fact binds the FIRST item
// of the plan, in plan order, whose `facts` names its kind: one item answers for it, never
// two. A strong fact contradicts an OK; a hint fact - every fact, when the facts were read
// from part of the repository only - and a probe hit are lines the verdict must answer. A
// fact no walked item names, and no `{ fact }` probe points at, is information only.
// `text` is null for a file with no readable content (deleted, binary): no probe runs on it.
function bindFile({ plan, instructions, filePath, text, facts = [], context = {}, partial = false }) {
  const entries = new Map();
  const entry = (address) => {
    if (!entries.has(address)) entries.set(address, { strong: [], hints: [], probes: new Map() });
    return entries.get(address);
  };
  const steps = plan.map((step) => ({ step, instruction: instructions.get(step.id) })).filter((s) => s.instruction);
  let unbound = [];
  for (const fact of facts) {
    let address = null;
    for (const { step, instruction } of steps) {
      const n = step.numbers.find((m) => ((instruction.extras.get(m) || {}).facts || []).includes(fact.kind));
      if (n !== undefined) {
        address = `${step.id}#${n}`;
        break;
      }
    }
    const shown = { kind: fact.kind, lines: fact.lines, text: fact.text };
    if (address === null) unbound.push(shown);
    else entry(address)[fact.hint || partial ? 'hints' : 'strong'].push(shown);
  }
  const pointed = new Set();
  for (const { step, instruction } of steps) {
    for (const n of step.numbers) {
      const extra = instruction.extras.get(n);
      if (!extra) continue;
      const address = `${step.id}#${n}`;
      if (extra.secondQuestion) entry(address).secondQuestion = extra.secondQuestion;
      if (typeof text !== 'string') continue;
      for (const spec of extra.probes || []) {
        const hits = repoFacts.runProbe(spec, filePath, text, facts, context);
        if (hits.length > 0 && spec.fact !== undefined) pointed.add(spec.fact);
        for (const hit of hits) {
          const at = entry(address).probes;
          const texts = at.get(hit.line) || [];
          if (!texts.includes(hit.text)) texts.push(hit.text);
          at.set(hit.line, texts);
        }
      }
    }
  }
  unbound = unbound.filter((fact) => !pointed.has(fact.kind));
  const items = {};
  for (const [address, e] of entries) {
    const out = {};
    if (e.strong.length > 0) out.strong = e.strong;
    if (e.hints.length > 0) out.hints = e.hints;
    if (e.probes.size > 0) out.probes = [...e.probes].sort((a, b) => a[0] - b[0]).map(([line, texts]) => ({ line, text: texts.join('; ') }));
    if (e.secondQuestion) out.secondQuestion = e.secondQuestion;
    if (Object.keys(out).length > 0) items[address] = out;
  }
  return { items, info: unbound };
}

// The lines one item's verdict owes, as the bundle prints them under the item.
function renderBinding(binding) {
  if (!binding) return [];
  const out = [];
  for (const fact of binding.strong || []) out.push(`  - ${linePrefix.strong} [${fact.kind}] ${lineList(fact.lines)}: ${fact.text}`);
  for (const fact of binding.hints || []) out.push(`  - ${linePrefix.hint} [${fact.kind}] ${lineList(fact.lines)}: ${fact.text}`);
  for (const hit of binding.probes || []) out.push(`  - ${linePrefix.probe} L${hit.line}: ${hit.text}`);
  if (binding.secondQuestion) out.push(`  - ${linePrefix.second} ${binding.secondQuestion}`);
  return out;
}

function renderExports(rows, root) {
  return rows.map((row) => {
    const where = row.importers.length > 0
      ? capped(row.importers.map((q) => short(q, root)))
      : `brak konsumenta w repozytorium - ${row.own ? 'używany tylko w tym pliku' : 'nieużywany nawet w tym pliku'}`;
    const tests = row.tests.length > 0 ? `; testy: ${capped(row.tests.map((q) => short(q, root)))}` : '';
    return `- L${row.line} \`${row.name}\`: ${where}${tests}`;
  });
}

function renderCandidates(candidates, withPath) {
  return candidates.map((c) => `- ${withPath ? `${c.path}:` : 'L'}${c.lines} powtarza ${c.sources.join('; ')} (${c.kinds.join(', ')})`);
}

// What the plan says of one item beyond its text (rulebook extras): the severity its finding
// carries when it differs from the instruction's, the partner items of this plan stating the
// same requirement, and the verdict to copy when no review can reach a better one.
function renderItemRules(instruction, address, extra, inPlan) {
  if (!extra) return [];
  const out = [];
  if (extra.severity && extra.severity !== instruction.severity) out.push(`  - ${itemPrefix.severity} ${severityText(extra.severity)}`);
  const partners = (extra.sameAs || []).filter((partner) => inPlan.has(partner));
  if (partners.length > 0) out.push(`  - ${itemPrefix.sameAs} ${partners.join(', ')}`);
  if (extra.unverified) out.push(`  - ${itemPrefix.prepared} [ ] ${address} — NIEZWERYFIKOWANE: ${extra.unverified}`);
  return out;
}

// The few rules of the part's format this file's plan can break, each only when it can: the
// check refuses exactly these, and a line read next to the plan costs less than a refusal.
function renderWriteRules({ file, kind, instructions, bound, lineCount }) {
  const steps = (kind ? kind.plan : []).map((step) => ({ step, instruction: instructions.get(step.id) })).filter((s) => s.instruction);
  const extras = steps.flatMap(({ step, instruction }) => step.numbers.map((n) => instruction.extras.get(n)).filter(Boolean));
  const out = ['## Zapis części', ''];
  out.push(`- Jeden Write: znaleziska, blok \`<!-- checklist: ${file.path}\`, marker \`<!-- coverage: ${file.path} <sprawdzone>/${file.checklistTotal} -->\`.`);
  out.push('- `NARUSZENIE (<linie z pola Linia>)` ma w tej części znalezisko z adresem w polu Reguła; jedno znalezisko nazywa najwyżej jedną pozycję instrukcji.');
  out.push(lineCount !== null && lineCount >= 20
    ? `- OK cytuje linie, z których odczytano werdykt, nigdy ${Math.ceil(lineCount / 2)}+ z ${lineCount} linii; zakres adresów tylko z \`OK (brak wystąpień)\` albo \`BRAMKA\`.`
    : '- Zakres adresów (`general#1-5`) tylko z `OK (brak wystąpień)` albo `BRAMKA`; OK z liniami albo ścieżką należy do jednej pozycji.');
  if (Object.keys(bound.items).length > 0) {
    out.push(`- Pozycja z \`${linePrefix.strong}\`, \`${linePrefix.hint}\`, \`${linePrefix.probe}\` albo \`${linePrefix.second}\`: własna linia, dowód cytuje każdą wskazaną linię; ${linePrefix.strong} ustępuje tylko \`fakt nie dotyczy: <czemu>\`.`);
  }
  const perFile = steps.filter(({ instruction }) => instruction.findings === 'per-file').map(({ step }) => step.id);
  if (perFile.length > 0) out.push(`- ${perFile.join(', ')}: jedno znalezisko na plik, pole Reguła wymienia każdą złamaną pozycję.`);
  if (steps.some(({ instruction }) => instruction.severity) || extras.some((extra) => extra.severity)) {
    out.push('- Znalezisko pod pozycją z ważnością stałą ma tę ważność (przy kilku adresach najwyższą).');
  }
  if (extras.some((extra) => extra.unverified)) out.push('- Gotowy werdykt przepisz do bloku bez zmian: OK tej pozycji jest odrzucane.');
  return out;
}

// One file's bundle. `kind` is the file's kind from the rulebook (null when none matches),
// `bound` what bindFile returned for it, `exports` its rows of repo-facts' exportsByFile,
// `lineCount` the lines of its content (null without one), `partPath` the part it is written
// to, `batch` the paths walked in the same response (null for a file walked alone) and `next`
// the `## Dalej` lines of the batch's last bundle (renderNext).
function renderBundle({
  file, kind, instructions, bound = { items: {}, info: [] }, exports = [], candidates = [], factRoot = '', partial = false,
  lineCount = null, partPath = null, batch = null, next = null,
}) {
  const out = [`# ${file.path}`, ''];
  out.push(kind
    ? `- rodzaj: ${kind.name} - ${kind.role}`
    : '- rodzaj: brak - żaden rodzaj pliku nie opisuje tej ścieżki; recenzja tylko wobec CLAUDE.md i punktów uniwersalnych');
  const changed = file.status === 'A' ? 'cały plik' : file.status === 'D' ? 'brak (plik usunięty)' : (file.changedLines || 'brak');
  out.push(`- status: ${file.status}${file.oldPath ? ` (dawniej ${file.oldPath})` : ''}; zmienione linie: ${changed}; pozycji planu: ${file.checklistTotal}`);
  if (file.contentPath) out.push(`- treść: ${file.contentPath}`);
  if (file.diffPath) out.push(`- diff: ${file.diffPath}`);
  if (partPath) out.push(`- część: ${partPath}`);
  if (batch) out.push(`- partia: ${batch.join(', ')} - przejścia po kolei, części razem w jednej odpowiedzi`);
  if (factRoot) out.push(`- ścieżki w faktach: względem \`${factRoot}/\``);
  if (partial) out.push('- fakty z części repozytorium (limit albo błąd git): każdy fakt tylko wskazuje linię');
  if (kind && kind.notes.length > 0) {
    out.push('', 'Uwagi rodzaju:');
    for (const note of kind.notes) out.push(`- ${note}`);
  }
  out.push('', '## Plan', '');
  if (!kind || kind.plan.length === 0) out.push('Brak pozycji do przejścia.', '');
  const inPlan = new Set((kind ? kind.plan : []).flatMap((step) => step.numbers.map((n) => `${step.id}#${n}`)));
  for (const step of kind ? kind.plan : []) {
    const instruction = instructions.get(step.id);
    if (!instruction) continue;
    out.push(`### ${instruction.name} (\`${step.id}:${rulebook.formatItemSpec(step.numbers)}\`)`);
    if (instruction.gate) out.push(`Bramka: ${instruction.gate}`);
    if (instruction.severity) out.push(`Ważność stała: ${severityText(instruction.severity)}`);
    for (const n of step.numbers) {
      const address = `${step.id}#${n}`;
      out.push(`- ${address}: ${instruction.items.get(n)}`);
      out.push(...renderBinding(bound.items[address]));
      out.push(...renderItemRules(instruction, address, instruction.extras.get(n), inPlan));
    }
    out.push('');
  }
  if (exports.length > 0) out.push('## Eksporty tego pliku i ich konsumenci', '', ...renderExports(exports, factRoot), '');
  if (candidates.length > 0) out.push('## Kandydaci duplikacji (jscpd)', '', ...renderCandidates(candidates, false), '');
  if (bound.info.length > 0) {
    out.push('## Fakty spoza planu (bez wymogu)', '');
    for (const fact of bound.info) out.push(`- [${fact.kind}] ${lineList(fact.lines)}: ${fact.text}`);
    out.push('');
  }
  if (kind && kind.plan.length > 0) out.push(...renderWriteRules({ file, kind, instructions, bound, lineCount }), '');
  if (next) out.push('## Dalej', '', ...next, '');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// Which files share a response: consecutive light ones, up to the batch limits. `entries` are
// `{ number, lines, items }` in walk order (`lines` null for a file without content, which keeps
// a response of its own); the result lists the numbers of each batch. A batch never spans a gap
// in the numbers (a resumed run's finished file), so [first, last] names exactly its members.
function planBatches(entries, limits = batchLimits) {
  const batches = [];
  let current = null;
  for (const entry of entries) {
    const light = entry.lines !== null && entry.lines <= limits.fileLines && entry.items <= limits.fileItems;
    if (light && current && current.numbers.length < limits.files
      && current.numbers[current.numbers.length - 1] + 1 === entry.number
      && current.lines + entry.lines <= limits.lines && current.items + entry.items <= limits.items) {
      current.numbers.push(entry.number);
      current.lines += entry.lines;
      current.items += entry.items;
      continue;
    }
    current = light ? { numbers: [entry.number], lines: entry.lines, items: entry.items } : null;
    batches.push(current ? current.numbers : [entry.number]);
  }
  return batches;
}

// Every Read a walk opens with: the bundle, the content and the diff of each file of a batch.
function readsOf(files) {
  return files.flatMap((file) => [file.bundlePath, file.contentPath, file.diffPath].filter(Boolean));
}

// The `## Dalej` lines of a batch's last bundle: the next batch's Reads, which ride with this
// batch's Writes, or - after the last file - the cross-file pass and its reference.
function renderNext({ nextFiles = [], crossBundlePath, crossPartPath }) {
  if (nextFiles.length > 0) {
    return ['Z zapisem części tej partii, w tej samej odpowiedzi, przeczytaj (Read) następną:', ...readsOf(nextFiles).map((p) => `- ${p}`)];
  }
  return [
    'Ostatni plik celu. Z zapisem części przeczytaj (Read) przejście międzyplikowe:',
    `- ${crossBundlePath}`,
    `- ${skillDir}/references/cross-file.md`,
    `Jego część: ${crossPartPath}.`,
  ];
}

// The cross-file pass's bundle: the repository-wide facts, the items it reports under, the
// jscpd candidates of the whole target and where the import ledger is. `walked` maps an
// instruction id to the item numbers this run's plans walk.
// `crossPartPath` and `closingPartPath` are the parts the pass writes, `withPr` whether findings
// carry the PR fields (an HTML run). The section between `reportedStart` and `reportedEnd` is
// review-hooks.cjs's to rewrite (renderReported) when the bundle is read.
function renderCrossBundle({
  cross = [], instructions, walked, candidates = null, importLedger = null, factRoot = '', partial = false,
  crossPartPath = null, closingPartPath = null, withPr = true,
}) {
  const out = ['# Przejście międzyplikowe', ''];
  if (crossPartPath) out.push(`- część: ${crossPartPath}`);
  if (factRoot) out.push(`- ścieżki w faktach: względem \`${factRoot}/\``);
  if (partial) out.push('- fakty z części repozytorium (limit albo błąd git): brak wpisu niczego nie dowodzi');
  if (importLedger) out.push(`- księga importów: ${importLedger}`);
  out.push('', '## Fakty międzyplikowe', '', ...(cross.length > 0 ? cross.map((line) => `- ${line}`) : ['- brak']), '');
  out.push('## Pozycje, pod którymi przejście raportuje', '');
  for (const [id, only] of crossInstructions) {
    const instruction = instructions.get(id);
    const numbers = [...(walked.get(id) || [])].filter((n) => !only || only.includes(n)).sort((a, b) => a - b);
    if (!instruction || numbers.length === 0) continue;
    out.push(`### ${instruction.name} (\`${id}:${rulebook.formatItemSpec(numbers)}\`)`);
    if (instruction.severity) out.push(`Ważność stała: ${severityText(instruction.severity)}`);
    for (const n of numbers) {
      out.push(`- ${id}#${n}: ${instruction.items.get(n)}`);
      const extra = instruction.extras.get(n);
      if (extra && extra.severity && extra.severity !== instruction.severity) out.push(`  - ${itemPrefix.severity} ${severityText(extra.severity)}`);
    }
    out.push('');
  }
  out.push('## Kandydaci duplikacji (jscpd)', '');
  if (candidates === null) out.push('- skan się nie odbył (powód w ostrzeżeniach kontekstu)');
  else if (candidates.length === 0) out.push('- brak');
  else out.push(...renderCandidates(candidates, true));
  out.push('', reportedStart, ...renderReported(null), reportedEnd, '');
  out.push('## Zapis części', '');
  out.push('- Jeden Write: znaleziska przejścia (pusta część, gdy nic nie znalazło) i blok `<!-- unverified:`, gdy lista "Otwarte w 3+ plikach" nie jest pusta; bez bloku checklisty i markera coverage.');
  if (closingPartPath) out.push(`- Cel bez żadnego znaleziska: jeszcze ${closingPartPath} z jedyną linią \`${render.emptyBodies[0]}\`.`);
  out.push('- Wada, którą część pliku już zgłasza (ten sam plik, adres albo jego `ta sama wada`, te same linie), nie wraca tu drugi raz.');
  out.push('', '    ## <ścieżka pliku>', '', '    🔴 **High**', '    - **Linia:** <linie w tym pliku>', '    - **Problem:** <wada i `ścieżka:linie` drugiej strony>',
    '    - **Reguła:** code-quality#<n>', '    - **Expected Result:** <poprawny stan + konkretna propozycja>');
  if (withPr) out.push('    - **PR Problem:** <English>', '    - **PR Expected:** <English>', '    - **PR Locations:** <English>');
  out.push('', '    <!-- unverified:', '    [x] <adres> <etykieta> — NARUSZENIE (<ścieżka>:<linie>)', '    [x] <adres> <etykieta> — OK (<ścieżka>)',
    '    [ ] <adres> <etykieta> — NIEZWERYFIKOWANE: <narzędzie: | poza recenzją: | działająca aplikacja:> <czego zabrakło>', '    -->');
  return `${out.join('\n')}\n`;
}

// The live section of the cross bundle. `state` is null before any part is read, or
// `{ reported: [{ path, entries: ['code-quality#1 (12-18)'] }], open: [{ address, files }] }`.
function renderReported(state) {
  const out = ['## Już zgłoszone w częściach plików', ''];
  if (!state) {
    out.push('- sekcję wypełnia hook przy odczycie tej paczki; bez niego przejrzyj części plików sam', '', `## Otwarte w ${unverifiedMinFiles}+ plikach (blok unverified)`, '', '- jak wyżej');
    return out;
  }
  if (state.reported.length === 0) out.push('- brak');
  for (const row of state.reported) out.push(`- ${row.path}: ${row.entries.join('; ')}`);
  out.push('', `## Otwarte w ${unverifiedMinFiles}+ plikach (blok unverified)`, '');
  if (state.open.length === 0) out.push('- brak - część przejścia nie ma bloku unverified');
  for (const row of state.open) out.push(`- ${row.address} (pliki: ${row.files})`);
  return out;
}

// The bundle text with its live section replaced; null when the markers are gone.
function withReported(text, state) {
  const start = text.indexOf(reportedStart);
  const end = text.indexOf(reportedEnd);
  if (start === -1 || end < start) return null;
  return `${text.slice(0, start + reportedStart.length)}\n${renderReported(state).join('\n')}\n${text.slice(end)}`;
}

// What the rulebook fixes beyond the item texts, for check-part.cjs: fixed severities by
// instruction id or item address, the addresses stating one requirement, the prepared verdicts.
function rulesOf(instructions) {
  const out = { severity: {}, sameAs: {}, prepared: {} };
  for (const [id, instruction] of instructions) {
    if (instruction.severity) out.severity[id] = instruction.severity;
    for (const [n, extra] of instruction.extras) {
      if (extra.severity) out.severity[`${id}#${n}`] = extra.severity;
      if (extra.sameAs && extra.sameAs.length > 0) out.sameAs[`${id}#${n}`] = extra.sameAs;
      if (extra.unverified) out.prepared[`${id}#${n}`] = extra.unverified;
    }
  }
  return out;
}

// What applies to a whole instruction, read once in Step 2: the preambles of the
// instructions this run walks. The items themselves reach the reviewer in the bundles.
function renderRulebookNotes(instructions) {
  const out = ['# Zasady ogólne instrukcji tego przebiegu', '', 'Treść każdej pozycji jest w paczce pliku (`bundlePath`); tu jest tylko to, co obowiązuje całą instrukcję.', ''];
  const withPreamble = instructions.filter((instruction) => instruction.preamble.length > 0);
  if (withPreamble.length === 0) out.push('Żadna z instrukcji tego przebiegu nie ma zasad ogólnych.', '');
  for (const instruction of withPreamble) {
    out.push(`## ${instruction.name} (\`${instruction.id}\`)`, '');
    for (const paragraph of instruction.preamble) out.push(paragraph, '');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// The facts.json check-part.cjs reads: per reviewed file, the bindings of bindFile, and the
// rules of rulesOf.
function factsDocument({ files, factRoot = '', partial = false, rules = null }) {
  return { version: factsVersion, factRoot, partial, files, ...(rules ? { rules } : {}) };
}

module.exports = {
  linePrefix, itemPrefix, factsFileName, crossBundleName, notesFileName, factsVersion, crossInstructions,
  reportedStart, reportedEnd, unverifiedMinFiles, batchLimits, skillDir,
  bindFile, renderBinding, renderBundle, renderCrossBundle, renderRulebookNotes, factsDocument,
  planBatches, readsOf, renderNext, renderReported, withReported, rulesOf, partPathOf, lineCountOf, severityText,
};
