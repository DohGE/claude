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
// `secondQuestion`, `answer`, `info`, `factRoot`, `partial`, `rules`) are what check-part.cjs reads:
// renamed, a binding is silently not enforced.
const linePrefix = { strong: 'FAKT', hint: 'WSKAZÓWKA', probe: 'SONDA', second: 'drugie pytanie:', answer: 'odpowiedź skryptu:' };
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
// `chars` weighs what the batch's Reads bring - bundles, contents, diffs - since a small file's
// bundle is most of it: 48k is the largest batch the measured 3-file runs walked at full recall.
// Three files at most: in the 2026-10-22 run every missed entry sat in a batch (singles 264
// entries, 0 missed; batches of 2-3 96.5%, of 4-5 91.8%).
const batchLimits = { fileLines: 60, fileItems: 60, files: 3, lines: 150, items: 120, chars: 50000 };
// Whole batches are walked by one sub-agent per window (SKILL.md Step 3, Windows): a file's walk
// grows its conversation by `fileTokens` - the thinking blocks stay in it for the whole run, plus
// probes and the Write - and by a `charsPerToken`th of the characters its Reads bring, and a
// conversation that passes about 165k tokens is compacted, which loses every bundle it read. A window
// holds `tokens` of walk (the walker's own start adds about 25k) and at most `files` files; a target
// whose whole walk fits one window is walked in the main conversation.
const windowLimits = { tokens: 100000, fileTokens: 14000, charsPerToken: 3, files: 6 };
// FIXED IDENTIFIERS. The two replies a window's walker ends with, which SKILL.md tells the main
// conversation to read, and the file name of a window's brief.
const windowReplies = { done: 'WINDOW DONE', stopped: 'WINDOW STOPPED' };
const windowBriefName = (index) => `window${pad(index, 2)}.md`;
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
// `answers` are the file's repo-facts.cjs answers by name, one per item whose `answer` names it.
function bindFile({ plan, instructions, filePath, text, facts = [], context = {}, partial = false, answers = {} }) {
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
      if (extra.answer && answers[extra.answer]) entry(address).answer = answers[extra.answer];
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
    if (e.answer) out.answer = e.answer;
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
  if (binding.answer) out.push(`  - ${linePrefix.answer} ${binding.answer}`);
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

// repo-facts' membersByFile rows: where each public member's name falls.
function renderMembers(rows, root) {
  return rows.map((row) => {
    const where = [];
    if (row.inFile) where.push('w tym pliku');
    if (row.template) where.push('szablon');
    if (row.files.length > 0) where.push(`pliki: ${capped(row.files.map((q) => short(q, root)))}`);
    if (row.tests.length > 0) where.push(`testy: ${capped(row.tests.map((q) => short(q, root)))}`);
    const none = row.framework ? 'nigdzie - wywołuje ją framework' : 'nigdzie poza deklaracją';
    return `- L${row.line} \`${row.cls}.${row.name}\`: ${where.length > 0 ? where.join('; ') : none}`;
  });
}

// repo-facts' specsByFile rows: the specs importing the file and their cases.
function renderSpecs(specs, root) {
  if (specs.length === 0) return ['- żaden spec nie importuje tego pliku'];
  return specs.map((s) => `- ${short(s.path, root)}: ${s.cases.length > 0
    ? capped(s.cases.map((c) => `${c.kind} L${c.line} "${c.title}"`), 25)
    : 'bez przypadków describe/it'}`);
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

// The items whose verdict owes an answer to a line of this bundle, in plan order - the list the
// check enforces, gathered so the reviewer never searches the bundle for them. `## Do odpowiedzi`
// is a FIXED IDENTIFIER: SKILL.md Step 3 point 2 names it.
function renderDuties({ kind, instructions, bound }) {
  const out = [];
  for (const step of kind ? kind.plan : []) {
    const instruction = instructions.get(step.id);
    if (!instruction) continue;
    for (const n of step.numbers) {
      const address = `${step.id}#${n}`;
      const b = bound.items[address] || {};
      const extra = instruction.extras.get(n) || {};
      const what = [];
      if ((b.strong || []).length) what.push(`${linePrefix.strong} ${b.strong.map((f) => lineList(f.lines)).join(', ')}`);
      if ((b.hints || []).length) what.push(`${linePrefix.hint} ${b.hints.map((f) => lineList(f.lines)).join(', ')}`);
      if ((b.probes || []).length) what.push(`${linePrefix.probe} ${b.probes.map((h) => `L${h.line}`).join(', ')}`);
      if (b.secondQuestion) what.push(linePrefix.second.replace(/:$/, ''));
      if (extra.unverified) what.push(itemPrefix.prepared.replace(/:$/, ''));
      if ((extra.sameAs || []).length) what.push(itemPrefix.sameAs.replace(/:$/, ''));
      if (what.length) out.push(`- ${address}: ${what.join('; ')}`);
    }
  }
  return out;
}

// One file's bundle. `kind` is the file's kind from the rulebook (null when none matches),
// `bound` what bindFile returned for it, `exports`, `members` and `specs` its rows of repo-facts'
// exportsByFile, membersByFile and specsByFile (`specs` null for a file that is no source
// script), `lineCount` the lines of its content (null without one), `partPath` the part it is
// written to, `batch` the paths walked in the same response (null for a file walked alone) and
// `next` the `## Dalej` lines of the batch's last bundle (renderNext).
function renderBundle({
  file, kind, instructions, bound = { items: {}, info: [] }, exports = [], members = [], specs = null, candidates = [], factRoot = '',
  partial = false, lineCount = null, partPath = null, batch = null, next = null,
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
  if (kind && kind.plan.length > 0) {
    const duties = renderDuties({ kind, instructions, bound });
    out.push('', '## Do odpowiedzi', '', ...(duties.length ? duties : ['—']));
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
  if (members.length > 0) {
    out.push('## Użycia składowych', '', 'Gdzie pada nazwa (całe słowo): ten plik, jego szablon, pliki importujące klasę i ich szablony.', ...renderMembers(members, factRoot), '');
  }
  if (specs) out.push('## Spec', '', ...renderSpecs(specs, factRoot), '');
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
// `{ number, lines, items, chars }` in walk order (`lines` null for a file without content, which
// keeps a response of its own; `chars` the size of its Reads, 0 when unknown); the result lists
// the numbers of each batch. A batch never spans a gap
// in the numbers (a resumed run's finished file), so [first, last] names exactly its members.
function planBatches(entries, limits = batchLimits) {
  const batches = [];
  let current = null;
  for (const entry of entries) {
    const light = entry.lines !== null && entry.lines <= limits.fileLines && entry.items <= limits.fileItems;
    if (light && current && current.numbers.length < limits.files
      && current.numbers[current.numbers.length - 1] + 1 === entry.number
      && current.lines + entry.lines <= limits.lines && current.items + entry.items <= limits.items
      && current.chars + (entry.chars || 0) <= limits.chars) {
      current.numbers.push(entry.number);
      current.lines += entry.lines;
      current.items += entry.items;
      current.chars += entry.chars || 0;
      continue;
    }
    current = light ? { numbers: [entry.number], lines: entry.lines, items: entry.items, chars: entry.chars || 0 } : null;
    batches.push(current ? current.numbers : [entry.number]);
  }
  return batches;
}

// What the walk of one file adds to its conversation, in tokens: `chars` is what its Reads bring.
const walkTokens = (chars) => windowLimits.fileTokens + Math.ceil((chars || 0) / windowLimits.charsPerToken);

// Which batches share a window: `batches` are the numbers planBatches returned, `weigh(number)` the
// tokens one file's walk adds. Empty when the whole walk fits one window. The cuts fall where the
// running weight crosses a multiple of the share every window gets, so that no window is a stub
// that pays the walker's start for a file or two; a batch over a limit has a window of its own.
function planWindows(batches, weigh, limits = windowLimits) {
  const weights = batches.map((batch) => batch.reduce((sum, number) => sum + weigh(number), 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const files = batches.reduce((sum, batch) => sum + batch.length, 0);
  if (total <= limits.tokens && files <= limits.files) return [];
  const share = total / Math.max(Math.ceil(total / limits.tokens), Math.ceil(files / limits.files));
  const windows = [];
  let current = null;
  let tokens = 0;
  let before = 0;
  batches.forEach((batch, k) => {
    const slot = Math.floor((before + weights[k] / 2) / share);
    const fits = current !== null && slot === current.slot && tokens + weights[k] <= limits.tokens && current.files + batch.length <= limits.files;
    if (!fits) {
      current = { slot, files: 0, batches: [] };
      windows.push(current);
      tokens = 0;
    }
    current.batches.push(batch);
    current.files += batch.length;
    tokens += weights[k];
    before += weights[k];
  });
  return windows.map((window) => window.batches);
}

// Every Read a walk opens with: the bundle, the content and the diff of each file of a batch.
function readsOf(files) {
  return files.flatMap((file) => [file.bundlePath, file.contentPath, file.diffPath].filter(Boolean));
}

// The `## Dalej` lines of a batch's last bundle: the next batch's Reads, which ride with this
// batch's Writes, or - after the last file - the cross-file pass and its reference. The last batch
// of a window (`window` is `{ first, last }`) tells the window's walker to stop; the lines for a
// reviewer who walks the whole target alone stay under it.
function renderNext({ nextFiles = [], crossBundlePath, crossPartPath, window = null }) {
  const own = nextFiles.length > 0
    ? ['Z zapisem części tej partii, w tej samej odpowiedzi, przeczytaj (Read) następną:', ...readsOf(nextFiles).map((p) => `- ${p}`)]
    : [
      'Ostatni plik celu. Z zapisem części przeczytaj (Read) przejście międzyplikowe:',
      `- ${crossBundlePath}`,
      `- ${skillDir}/references/cross-file.md`,
      `Jego część: ${crossPartPath}.`,
    ];
  if (!window) return own;
  const range = window.first === window.last ? `${window.first}` : `${window.first}-${window.last}`;
  return [
    `Koniec okna (${range}):`,
    `- walker okna: zapisz części tej partii, niczego więcej nie czytaj i odpowiedz jedną linią \`${windowReplies.done} ${range}\`;`,
    '- bez okien (całość prowadzisz sam):',
    ...own.map((line) => `  ${line}`),
  ];
}

// What a window's walker reads first, from the prompt `Read <brief> and follow it`: where the
// rules of the walk are, the target's settings Step 3 and 4 name, the batches of the window with
// their parts and Reads, and how it ends. `skill` is `{ path, from, limit }` (review-hooks.cjs
// walkLines) or null; `target` the settings (`reportPath`, `htmlReportPath`, `workDir`,
// `withChecklist`, `withRuleText`, `light`, `dedupItems`, `commands`); `batches` lists per batch
// `{ number, path, partPath, reads }` of each file.
function renderWindowBrief({ index, total, skill = null, target, batches }) {
  const first = batches[0][0].number;
  const lastBatch = batches[batches.length - 1];
  const last = lastBatch[lastBatch.length - 1].number;
  const range = first === last ? `${first}` : `${first}-${last}`;
  const out = [`# Window ${index} of ${total}: files ${range}`, ''];
  out.push(`You walk files ${range} of this target, batch by batch in the order below, and nothing else.`);
  out.push(skill
    ? `1. Read ${skill.path} with offset ${skill.from} and limit ${skill.limit} - Step 3 (the walk) and Step 4 (the format of a part) - in the same response as the Reads of the first batch that still lacks a part.`
    : '1. Read the codeReview SKILL.md from its `## Step 3` heading up to the one-time marker, in the same response as the Reads of the first batch that still lacks a part.');
  out.push('2. A file whose part is on disk is finished: skip it and never write it again. Walk every other batch exactly as Step 3 says; the last bundle of a batch ends with `## Dalej`, which names the Reads that ride with its Writes.');
  out.push(`3. The window ends with its last part: reply with exactly one line, \`${windowReplies.done} ${range}\`, and nothing else - no summary of findings.`);
  out.push(`4. If you cannot go on - the Write of a part is refused, or a part still fails its check after two fixes - reply with the one line \`${windowReplies.stopped} <file number>: <reason>\`. Never write a part through the shell: the conversation that sent you walks the rest.`, '');
  out.push('The `target.*` keys Step 3 and 4 name, for this target (a key missing here is false):', '', '```json', JSON.stringify(target, null, 2), '```', '');
  batches.forEach((batch, k) => {
    out.push(`## Batch ${k + 1}: ${batch.length > 1 ? `files ${batch[0].number}-${batch[batch.length - 1].number}` : `file ${batch[0].number}`}`, '');
    for (const file of batch) out.push(`- file ${file.number}: ${file.path}; part ${file.partPath}`);
    out.push('', 'Reads, in ONE message:', ...batch.flatMap((file) => file.reads).map((p) => `- ${p}`), '');
  });
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// The files of a target by number, with the content and the diff the cross pass opens: a pass that
// follows a walk it did not make (a window's, or one a compaction cut) has no file in memory, and
// the work folder's names (`<number>-<name>`) are not guessable. A path outside the work folder
// stays whole, and starts with `/` or a drive letter (a folder-mode target reads the project's own
// files).
function renderTargetFiles(files, workDir) {
  const name = (p) => (workDir && p.startsWith(`${workDir}/`) ? p.slice(workDir.length + 1) : p);
  const rows = files.map((file, i) => {
    const places = [file.contentPath, file.diffPath].filter(Boolean).map(name);
    return `- ${i + 1} ${file.path}${file.status === 'D' ? ' (usunięty)' : ''}: ${places.length > 0 ? places.join(', ') : 'bez treści'}`;
  });
  return ['## Pliki celu', '', `Treść i diff pliku, w \`${workDir || '<katalog roboczy>'}/\`, o ile nazwa nie zaczyna się od \`/\` albo litery dysku:`, ...rows, ''];
}

// The cross-file pass's bundle: the repository-wide facts, the files it may open, the items it
// reports under, the jscpd candidates of the whole target and where the import ledger is.
// `walked` maps an instruction id to the item numbers this run's plans walk.
// `files` are the target's files (`path`, `status`, `contentPath`, `diffPath`), `workDir` the
// folder the script filled with their contents.
// `crossPartPath` and `closingPartPath` are the parts the pass writes, `withPr` whether findings
// carry the PR fields (an HTML run). The section between `reportedStart` and `reportedEnd` is
// review-hooks.cjs's to rewrite (renderReported) when the bundle is read.
function renderCrossBundle({
  cross = [], instructions, walked, candidates = null, importLedger = null, factRoot = '', partial = false,
  crossPartPath = null, closingPartPath = null, withPr = true, files = [], workDir = null,
}) {
  const out = ['# Przejście międzyplikowe', ''];
  if (crossPartPath) out.push(`- część: ${crossPartPath}`);
  if (factRoot) out.push(`- ścieżki w faktach: względem \`${factRoot}/\``);
  if (partial) out.push('- fakty z części repozytorium (limit albo błąd git): brak wpisu niczego nie dowodzi');
  if (importLedger) out.push(`- księga importów: ${importLedger}`);
  out.push('', '## Fakty międzyplikowe', '', ...(cross.length > 0 ? cross.map((line) => `- ${line}`) : ['- brak']), '');
  if (files.length > 0) out.push(...renderTargetFiles(files, workDir));
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
// instruction id or item address, the addresses stating one requirement, the prepared verdicts,
// the addresses saying a file has no spec.
function rulesOf(instructions) {
  const out = { severity: {}, sameAs: {}, prepared: {}, noSpec: [] };
  for (const [id, instruction] of instructions) {
    if (instruction.severity) out.severity[id] = instruction.severity;
    for (const [n, extra] of instruction.extras) {
      if (extra.severity) out.severity[`${id}#${n}`] = extra.severity;
      if (extra.sameAs && extra.sameAs.length > 0) out.sameAs[`${id}#${n}`] = extra.sameAs;
      if (extra.unverified) out.prepared[`${id}#${n}`] = extra.unverified;
      if (extra.noSpec) out.noSpec.push(`${id}#${n}`);
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
  reportedStart, reportedEnd, unverifiedMinFiles, batchLimits, windowLimits, windowReplies, windowBriefName, skillDir,
  bindFile, renderBinding, renderBundle, renderCrossBundle, renderRulebookNotes, factsDocument,
  planBatches, planWindows, walkTokens, readsOf, renderNext, renderWindowBrief, renderReported, withReported, rulesOf, partPathOf, lineCountOf, severityText,
};
