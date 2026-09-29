'use strict';

// Scores a markdown review of `test-environment/` against `test-key/answer-key.json`,
// so the dev loop learns what a review found and missed without anyone reading the
// key: the orchestrator that ran the review never opens it, and this script prints a
// summary short enough for its context.
//
// The match is heuristic - the report is written in another language than the key - so
// it rests on what both sides must share: the file, the instruction, the lines the key
// places an entry on (`locate-lines.cjs`), the code identifiers the key names in
// backticks, the WCAG criteria it lists, and the rare words of its prose that the
// finding or a checklist point it cites repeats. A finding pairs with the entries of its
// own file and, under their instruction, with those of a file it names
// (`polyfills.ts:1`, `UserPanelUiStateService`) or - naming their code too - of a file
// of its unit (a component's template, styles and spec). Its best pair - its own file
// first, then the score, the rule and the words of the whole entry text - decides that
// it matched, the entry its severity is judged against and whether it names another
// instruction.
//
// A report merges defects - one finding for the missing lang, landmarks and title of a
// page - so a finding also counts toward every other entry it pairs with on evidence of
// its own: an identifier, a line, a file, a prose word or a criterion that no pair of
// the same finding scoring at least as high accounts for already. A pair resting on the
// instruction alone, or on one identifier under another instruction, counts only as the
// best one; so does a test finding's pair with an entry about the code it tests. A best
// pair resting on the rule and lines alone gives way to an entry nothing found yet when
// another finding carries its entry on a name, a word or a criterion.
//
// An entry also names the checklist items its defect breaks (`items`). The report's checklist
// blocks say how the review ticked them in the entry's files, and a tick without NARUSZENIE
// there is a false OK: counted per item, it decides which items earn a second question
// (`secondQuestion` in instructions/).
//
// The report is the Markdown or the page render-report.cjs made of it (`.html`), which
// carries the parsed report as data - so a review that also wrote the PR fields is
// scored as it ran, not rerun with --only-md.
//
// Usage: node score-review.cjs --report <review.md|raport.html> [--key <answer-key.json>] [--limit N] [--json]
//        node score-review.cjs --report <review.md|raport.html> --explain <entry id>   (every pair of one entry)
//        node score-review.cjs --lint-key [--key <answer-key.json>]                    (entries hard to match, item gaps)

const fs = require('node:fs');
const path = require('node:path');
const { parseReport, parseRuleField } = require('./render-report.cjs');
const rulebook = require('./rulebook.cjs');

const defaultKey = path.join(__dirname, '..', 'test-key', 'answer-key.json');

// Words every entry of this environment shares - matching on them would pair
// anything with anything.
const genericWords = new Set([
  'user', 'users', 'panel', 'component', 'components', 'spec', 'specs', 'state', 'test', 'tests',
  'html', 'scss', 'json', 'true', 'false', 'null', 'undefined', 'this', 'const', 'string', 'number',
  'void', 'return', 'import', 'export', 'from', 'feature', 'shared', 'models', 'index', 'service',
]);

function wordsOf(text) {
  const words = new Set();
  for (const word of String(text).toLowerCase().match(/[a-z_$][\w$]*/g) || []) {
    if (word.length >= 4 && !genericWords.has(word)) words.add(word);
  }
  return words;
}

// English prose any two entries share - evidence of no defect.
const fillerWords = new Set([
  'about', 'also', 'been', 'both', 'does', 'each', 'even', 'every', 'have', 'here', 'instead',
  'into', 'just', 'like', 'more', 'most', 'must', 'never', 'only', 'other', 'same', 'should',
  'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'they', 'what', 'when',
  'where', 'which', 'while', 'with', 'without', 'would', 'your',
]);

// Backticked tokens in order, each marked when it stands inside parentheses: an aside
// ("(also enables the `@defer` barrel-import defect)") quotes the code of another entry.
// Parentheses inside a token (`provideAnimations()`) are code, not an aside.
function quotedTokens(text) {
  const tokens = [];
  const source = String(text);
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '`') {
      const end = source.indexOf('`', i + 1);
      if (end < 0) break;
      tokens.push({ token: source.slice(i + 1, end), aside: depth > 0 });
      i = end;
    } else if (source[i] === '(') depth += 1;
    else if (source[i] === ')') depth = Math.max(0, depth - 1);
  }
  return tokens;
}

// The key side is narrow on purpose: only what it quotes as code.
function keyIdentifiers(text) {
  const words = new Set();
  for (const { token } of quotedTokens(text)) {
    for (const word of wordsOf(token)) words.add(word);
  }
  return words;
}

function sameFile(reportPath, keyFile) {
  const normalized = reportPath.replace(/\\/g, '/');
  return normalized === keyFile || normalized.endsWith(`/${keyFile}`);
}

// A path to a file of the environment, with the lines a text cites there
// (`user-panel.effects.ts:157-159`, `models/index.ts:7`).
const pathSource = String.raw`(?:[\w@+.-]+\/)*[\w@+-]+(?:\.[\w-]+)*\.(?:ts|html|scss|css|json|js|cjs|mjs)`;
const linesSource = String.raw`(?::\d+(?:\s*[-–]\s*\d+)?(?:,\s*\d+(?:\s*[-–]\s*\d+)?)*)?`;
const citedPath = new RegExp(`${pathSource}${linesSource}`, 'g');
const wholePath = new RegExp(`^${pathSource}${linesSource}$`);

// The one known file a quoted path can mean; an ambiguous one (`index.ts`) means none.
function fileResolver(files) {
  const list = [...files];
  return (quoted) => {
    const wanted = quoted.replace(/\\/g, '/').replace(/^(?:\.\.?\/)+/, '');
    const hits = list.filter((file) => file === wanted || file.endsWith(`/${wanted}`) || wanted.endsWith(`/${file}`));
    return hits.length === 1 ? hits[0] : null;
  };
}

function placesIn(text, resolveFile) {
  const places = new Map();
  for (const [cited] of String(text).matchAll(citedPath)) {
    const [quoted, lines = ''] = cited.split(/:(?=\d)/);
    const file = resolveFile(quoted);
    if (file) places.set(file, [...(places.get(file) || []), ...rangesOf(lines)]);
  }
  return places;
}

// A class, function or constant a finding names points at the file declaring it, by the
// naming convention of the environment: `UserPanelUiStateService` is declared in
// `user-panel-ui-state.service.ts`, `UserDto` in `user-dto.interface.ts`.
const symbolPattern = /\b(?:[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

function symbolResolver(files) {
  const forms = new Map();
  const add = (form, file) => forms.set(form, [...(forms.get(form) || []), file]);
  for (const file of files) {
    if (!file.endsWith('.ts') || /\.(?:spec|test)\.ts$/.test(file)) continue;
    const stem = path.posix.basename(file, '.ts');
    add(`whole:${stem.replace(/\./g, '-')}`, file);
    add(`name:${stem.split('.')[0]}`, file);
  }
  return (symbol) => {
    const kebab = /^[A-Z0-9_]+$/.test(symbol)
      ? symbol.toLowerCase().replace(/_/g, '-')
      : symbol.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    for (const form of [`whole:${kebab}`, `name:${kebab}`]) {
      const hits = forms.get(form);
      if (hits && hits.length === 1) return hits[0];
    }
    return null;
  };
}

// A component's class, template, styles and spec - or a service and its spec - are one unit.
function unitOf(file) {
  const dir = path.posix.dirname(file).replace(/\/(?:tests|__tests__)$/, '');
  const stem = path.posix.basename(file).replace(/\.(?:ts|html|scss|css|json|js)$/, '').replace(/\.(?:spec|test)$/, '');
  return `${dir}/${stem}`;
}

// A prose rule names an instruction by its id (`security → …`; the parser already
// turned a Markdown-era `security.md` into it), but the left of the arrow may also be
// the violated point's name - only an id the rulebook declares counts as one.
let rules = null;
const loadRules = () => {
  if (!rules) rules = rulebook.loadRulebook([path.join(__dirname, '..', 'instructions')]).instructions;
  return rules;
};

function instructionsOf(finding) {
  const ids = new Set();
  for (const tag of finding.tags || []) {
    if (tag.address) ids.add(tag.address.id);
    else if (loadRules().has(tag.file)) ids.add(tag.file);
  }
  return ids;
}

// The texts of the checklist points a finding cites (`models#2`), keyed by address: the
// words a report written in another language still shares with the key.
function pointsOf(finding) {
  const points = new Map();
  for (const tag of finding.tags || []) {
    if (!tag.address) continue;
    const instruction = loadRules().get(tag.address.id);
    const text = instruction && instruction.items.get(tag.address.n);
    if (text) points.set(`${tag.address.id}#${tag.address.n}`, text);
  }
  return points;
}

// WCAG success criteria a text cites (`2.5.8`), as the key's `wcag` lists them.
const criterionPattern = /\b[1-4]\.\d{1,2}\.\d{1,2}\b/g;

const isTestInstruction = (id) => id.includes('test');

// The report's "Linia" field (`12, 21`, `59-73, 75-81`) as [start, end] pairs.
function rangesOf(lines) {
  const ranges = [];
  for (const [, start, end] of String(lines || '').matchAll(/(\d+)(?:\s*[-–]\s*(\d+))?/g)) {
    ranges.push([Number(start), Number(end || start)]);
  }
  return ranges;
}

// Lines the key places a defect on (`locate-lines.cjs`) are exact, a reviewer's are
// read off a file it may quote a line or two around the defect.
const lineSlack = 2;
function linesOverlap(findingRanges, entryRanges) {
  return findingRanges.some(([a, b]) => entryRanges.some(([c, d]) => a <= d + lineSlack && c <= b + lineSlack));
}

// A range this long spans a whole method or class: it would place a finding on every
// entry inside it, which is no place at all.
const maxPlacingSpan = 15;
const placing = (ranges) => ranges.filter(([start, end]) => end - start < maxPlacingSpan);

// How many entries of the key use a word: a word most of them use tells them apart from
// nothing, one only a few use is evidence of the defect.
function documentFrequency(texts) {
  const df = new Map();
  for (const text of texts) {
    for (const word of wordsOf(text)) df.set(word, (df.get(word) || 0) + 1);
  }
  const total = texts.length;
  return { df, idf: (word) => Math.log((total + 1) / ((df.get(word) || 0) + 1)) };
}

// What an entry offers a finding to match: the code it quotes, the environment files it
// quotes, and its prose. A quote counts once however many words it has - a translation
// key `'page.userPanel.labels.userNameLabel'` is one name - and is named by its rarest
// word, the one other quotes of the same key or file do not share; `aside` marks a quote
// inside parentheses ("(also enables the `@defer` barrel-import defect)"), `at` one the
// key elides (`...DisplayedColumnsLabels` ends a longer name). A quote too short to have
// a word (`as`, `@let`, `tests/`) is `exact`: only the same quote in the finding names it,
// and an entry quoting nothing else stays `bare` - a finding may well say it in words.
const codeOf = (token) => token.trim().toLowerCase().replace(/\s+/g, ' ');
function quotesOf(text) {
  const quotes = new Set();
  for (const { token } of quotedTokens(text)) {
    const code = codeOf(token);
    quotes.add(code);
    for (const part of code.split(/[\s,;]+/)) if (part) quotes.add(part);
  }
  return quotes;
}

function termsOf(text, resolveFile, df) {
  const identifiers = [];
  const files = new Set();
  for (const { token, aside } of quotedTokens(text)) {
    const quoted = token.trim();
    const file = wholePath.test(quoted) && resolveFile(quoted.split(/:(?=\d)/)[0]);
    if (file) {
      files.add(file);
      continue;
    }
    const words = [...wordsOf(quoted)];
    if (!words.length) {
      const code = codeOf(quoted);
      if (/[a-z@]/.test(code) && !identifiers.some((identifier) => identifier.anchor === code)) {
        identifiers.push({ anchor: code, words: [], aside, at: null, exact: true });
      }
      continue;
    }
    const rarity = (word) => [df.get(word) || 0, -word.length];
    const index = words.reduce((best, word, i) => {
      const [a, b] = rarity(word);
      const [c, d] = rarity(words[best]);
      return a < c || (a === c && b < d) ? i : best;
    }, 0);
    const anchor = words[index];
    let at = null;
    if (index === 0 && /^(?:\.\.\.|…)/.test(quoted)) at = 'end';
    else if (index === words.length - 1 && /(?:\.\.\.|…)\W*$/.test(quoted)) at = 'start';
    const known = identifiers.find((identifier) => identifier.anchor === anchor);
    if (known) known.aside = known.aside && aside;
    else identifiers.push({ anchor, words, aside, at });
  }
  const bare = !identifiers.some((identifier) => !identifier.aside && !identifier.exact);
  return { identifiers, cited: files, bare };
}

function names(finding, { anchor, at, exact }) {
  if (exact) return finding.quotes.has(anchor);
  if (!at) return finding.words.has(anchor);
  for (const word of finding.words) {
    if (at === 'end' ? word.endsWith(anchor) : word.startsWith(anchor)) return true;
  }
  return false;
}

// An entry's prose words: its quotes are matched as names, and the words of its own
// instructions are in the point text of every finding filed under them.
function proseOf(entry) {
  const own = wordsOf(entry.instructions.join(' '));
  const prose = String(entry.text).replace(/`[^`]*`/g, ' ');
  return [...wordsOf(prose)].filter((word) => !fillerWords.has(word) && !own.has(word));
}

// The words an entry's prose (its quotes aside) shares with what a finding says: the
// finding's own text and each checklist point it cites. The weight of a source is the
// rarity of the shared words; the strongest source counts.
function saidOf(finding, entry, idf) {
  let best = { source: null, weight: 0, words: [] };
  for (const [source, words] of finding.said) {
    const shared = entry.prose.filter((word) => words.has(word));
    const weight = shared.reduce((sum, word) => sum + idf(word), 0);
    if (weight > best.weight) best = { source, weight, words: shared };
  }
  return best;
}

function relationOf(finding, entry) {
  if (entry.files.includes(finding.file)) return { kind: 'same', file: finding.file, ranges: finding.placing };
  for (const file of entry.files) {
    if (finding.places.has(file)) return { kind: 'named', file, ranges: placing(finding.places.get(file)) };
  }
  for (const file of entry.files) {
    if (finding.symbols.has(file)) return { kind: 'named', file, ranges: [] };
  }
  for (const file of entry.files) {
    if (sameFile(finding.unit, unitOf(file))) return { kind: 'unit', file, ranges: [] };
  }
  return null;
}

// How one finding pairs with one entry, or null when they are not the same defect.
// Lines the finding shares with the entry stand in for a shared identifier - the report
// may name the code differently - and outweigh one. An entry filed under several
// instructions the finding names too is that finding more surely than one sharing a
// single instruction and a name: "no spec" under `utils; test-coverage` is the util's
// missing-spec entry, not its naming one. A file the finding names is evidence of its
// own; a file of its unit is not - a class and its template share every defect of the
// unit - so that pair needs a shared name. A missing spec reported for a file is its
// missing-spec entry: the key holds one per file.
//
// The prose counts once the words it shares weigh `minSaid`: no word alone does, two
// that few entries use do.
const minSaid = 6;

function pairOf(finding, entry, idf) {
  const relation = relationOf(finding, entry);
  if (!relation) return null;
  const testFinding = finding.severity === 'missing-unit-test' || [...finding.instructions].some(isTestInstruction);
  const testEntry = entry.instructions.some(isTestInstruction);
  // "No spec for X" is no finding about X, nor is a finding about X one about its spec.
  if (finding.severity === 'missing-unit-test' && !testEntry) return null;
  if (entry.severity === 'missing-unit-test' && !testFinding) return null;
  const ruled = entry.instructions.filter((id) => finding.instructions.has(id)).length;
  if (!ruled && relation.kind !== 'same') return null;
  const entryRanges = rangesOf(entry.lines && entry.lines[relation.file]);
  const placed = [];
  relation.ranges.forEach((range, i) => {
    if (linesOverlap([range], entryRanges)) placed.push(i);
  });
  const named = entry.identifiers.filter((identifier) => names(finding, identifier)).map(({ anchor }) => anchor);
  const said = saidOf(finding, entry, idf);
  const saying = said.weight >= minSaid;
  const cited = entry.wcag.filter((criterion) => finding.criteria.has(criterion));
  const spec = finding.severity === 'missing-unit-test' && entry.severity === 'missing-unit-test';
  if (relation.kind === 'unit' && !named.length) return null;
  const units = named.length + (placed.length ? 1 : 0) + (saying ? 1 : 0) + (cited.length ? 1 : 0)
    + (relation.kind === 'named' ? 1 : 0) + (spec ? 1 : 0);
  let strong;
  if (ruled) {
    if (units) strong = true;
    else if (entry.bare && relation.kind === 'same') strong = false;
    else return null;
  } else {
    // Under another rule, a place alone is no match - one line holds several defects.
    if (finding.severity === 'missing-unit-test' || named.length < (placed.length ? 1 : 2)) return null;
    strong = named.length >= 2 && placed.length > 0;
  }
  return {
    finding,
    entry,
    relation: relation.kind,
    file: relation.file,
    ruled,
    named,
    placed: placed.length,
    said: saying ? said : null,
    cited,
    strong,
    wrongRule: !ruled,
    testOnly: testFinding && !testEntry,
    score: 2 * ruled + units,
    overlap: said.weight,
    // Each shared prose word is a token of its own: two entries whose words one checklist
    // point repeats are told apart by the words each of them shares.
    evidence: new Set([
      ...named.map((anchor) => `id:${anchor}`),
      ...placed.map((i) => `line:${relation.file}:${i}`),
      ...(saying ? said.words.map((word) => `said:${word}`) : []),
      ...(spec ? [`spec:${relation.file}`] : []),
      ...cited.map((criterion) => `wcag:${criterion}`),
      ...(relation.kind === 'same' ? [] : [`file:${relation.file}`]),
    ]),
  };
}

// Whether pair a beats pair b: the score, then the rule, then the words of the whole
// entry text - unquoted names and terms both sides use ("setInterval", "ngOnDestroy").
function outranks(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  if (a.wrongRule !== b.wrongRule) return b.wrongRule;
  return a.overlap > b.overlap;
}

const byRank = (a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : a.entry.order - b.entry.order);

// Sorts one finding's pairs and marks how each counts: `best`, `credited`, or why not.
function creditPairs(finding) {
  const ranked = [...finding.pairs].sort(byRank);
  const own = ranked.filter((pair) => pair.relation === 'same');
  const best = own[0] || ranked[0] || null;
  ranked.forEach((pair, i) => {
    if (pair === best) pair.status = 'best';
    else if (!pair.strong) pair.status = pair.wrongRule ? 'other rule' : 'rule only';
    else if (pair.testOnly) pair.status = 'test finding';
    else {
      const over = ranked.slice(0, i).find((other) => other.score >= pair.score
        && [...pair.evidence].every((token) => other.evidence.has(token)));
      if (over) {
        pair.status = 'dominated';
        pair.by = over.entry.id;
      } else pair.status = 'credited';
    }
    if (pair.status === 'best' || pair.status === 'credited') pair.entry.credits.push(pair);
  });
  finding.pairs = ranked;
  return best;
}

// A cross-file entry is a relation between files, so a finding in one file stating it
// cites the other (`user-panel.effects.ts:157-159`); a pattern it names may also be
// reported file by file - then the findings of two files share two of its identifiers.
// An entry marked 🔵 (specs missing across files) is carried by missing-spec findings in
// two of the files it quotes.
function crossFileSupport(entry, findings, instructionWords) {
  const identifiers = [...new Set(entry.identifiers.flatMap(({ words }) => words))].filter((word) => !instructionWords.has(word));
  const supporters = [];
  for (const finding of findings) {
    const shared = identifiers.filter((word) => finding.words.has(word));
    if (shared.length) supporters.push({ finding, shared });
  }
  const tying = supporters.filter(({ finding, shared }) => finding.places.size
    && shared.length + [...entry.cited].filter((file) => file === finding.file || finding.places.has(file)).length >= 2);
  if (tying.length) return tying.map(({ finding }) => finding);
  const files = new Set(supporters.map(({ finding }) => finding.file));
  const words = new Set(supporters.flatMap(({ shared }) => shared));
  if (files.size >= 2 && words.size >= 2) return supporters.map(({ finding }) => finding);
  if (/🔵/.test(entry.text)) {
    const missing = findings.filter((finding) => finding.severity === 'missing-unit-test'
      && [...entry.cited].some((file) => file === finding.file || sameFile(finding.unit, unitOf(file))));
    if (new Set(missing.map((finding) => finding.file)).size >= 2) return missing;
  }
  return [];
}

// How the checklist blocks of the files the key places an entry in (all its files when it
// places it nowhere) tick the items it names: flagged when a block has NARUSZENIE on the item,
// a false OK when one ticks it otherwise, open when it is only left unticked, absent when no
// block lists it - the plan never put it in front of the review. A file without a block says
// nothing.
function itemVerdicts(report, entries) {
  const rows = new Map();
  for (const entry of entries) {
    entry.verdicts = new Map();
    const placed = Object.keys(entry.lines || {});
    const files = placed.length ? placed : entry.files;
    const blocks = report.checklists.filter((block) => files.some((file) => sameFile(block.path, file)));
    if (!blocks.length) continue;
    for (const address of entry.items || []) {
      const states = new Set(blocks.flatMap((block) => block.items.filter((item) => item.id === address).map((item) => item.state)));
      const verdict = states.has('violation') ? 'flagged'
        : states.has('ok') ? 'falseOk'
          : states.has('open') ? 'open' : 'absent';
      entry.verdicts.set(address, verdict);
      if (!rows.has(address)) rows.set(address, { item: address, falseOk: [], flagged: [], open: [], absent: [] });
      rows.get(address)[verdict].push(entry);
    }
  }
  return [...rows.values()].sort((a, b) => a.item.localeCompare(b.item, 'en', { numeric: true }));
}

function score(report, key) {
  const envFiles = new Set([
    ...key.findings.flatMap((entry) => entry.files),
    ...key.bait.map((entry) => entry.file).filter(Boolean),
  ]);
  const canonical = (reportPath) => [...envFiles].find((file) => sameFile(reportPath, file)) || reportPath.replace(/\\/g, '/');
  const known = new Set([...envFiles, ...report.files.map((section) => canonical(section.path))]);
  const resolveFile = fileResolver(known);
  const resolveSymbol = symbolResolver(known);
  // An instruction's name is in every finding filed under it (`accessibility#3`) - no
  // evidence of the defect, only of the rule.
  const instructionWords = new Set(key.findings.flatMap((entry) => [...wordsOf(entry.instructions.join(' '))]));
  const { df, idf } = documentFrequency(key.findings.map((entry) => entry.text));

  const findings = [];
  for (const section of report.files) {
    const file = canonical(section.path);
    for (const finding of section.findings) {
      const places = placesIn([finding.problem, finding.expected, finding.prProblem, finding.prExpected].join(' '), resolveFile);
      places.delete(file);
      const symbols = new Set();
      for (const [symbol] of [finding.problem, finding.prProblem].join(' ').matchAll(symbolPattern)) {
        const declaring = resolveSymbol(symbol);
        if (declaring && declaring !== file) symbols.add(declaring);
      }
      const ranges = rangesOf(finding.lines);
      const told = [finding.problem, finding.expected, finding.rule, finding.prProblem].join(' ');
      // A path it cites names a file, not the defect: `user-panel.facade.ts:12` would
      // otherwise say "facade" to every entry that does.
      const words = wordsOf(told.replace(citedPath, ' '));
      const said = new Map([['text', words]]);
      for (const [address, text] of pointsOf(finding)) said.set(address, wordsOf(text));
      findings.push({
        file,
        unit: unitOf(file),
        lines: finding.lines,
        ranges,
        placing: placing(ranges),
        severity: finding.severity,
        rule: finding.rule,
        problem: finding.problem,
        instructions: instructionsOf(finding),
        words,
        quotes: quotesOf(told),
        said,
        criteria: new Set([finding.problem, finding.expected, finding.rule, finding.prProblem].join(' ').match(criterionPattern) || []),
        places,
        symbols,
        pairs: [],
      });
    }
  }
  const entries = key.findings.map((entry, order) => ({
    ...entry,
    kind: 'violation',
    order,
    ...termsOf(entry.text, resolveFile, df),
    words: wordsOf(entry.text),
    prose: proseOf(entry),
    wcag: entry.wcag || [],
    credits: [],
  }));
  const crossFile = key.crossFile.map((entry) => ({
    ...entry,
    kind: 'cross-file',
    ...termsOf(entry.text, resolveFile, df),
    support: [],
  }));
  // A bait that names instructions (`accessibility`, `test-coverage`) would otherwise
  // claim every finding filed under them - the instruction is in the finding's rule.
  const baits = key.bait.map((entry) => ({
    ...entry,
    identifiers: new Set([...keyIdentifiers(entry.text)].filter((word) => !instructionWords.has(word))),
    aboutTests: /\b(?:specs?|tests?)\b/i.test(entry.text),
  }));
  // Entries about files the review never walked (a root `tsconfig.json` when the target
  // was `src/`) are out of its reach, not missed by it. Only the coverage markers name
  // every walked file: a report without them (reviewed without --with-checklist) names
  // just the files with a finding, which would drop a file whose every defect was missed.
  const walked = report.coverage || [];
  const reviewed = walked.length ? [...report.files, ...walked].map((entry) => entry.path) : [];
  const inScope = (entry) => !reviewed.length
    || entry.files.some((file) => reviewed.some((reviewedPath) => sameFile(reviewedPath, file)));

  const wrongRule = [];
  const repeats = [];
  const paired = new Set();
  for (const finding of findings) {
    for (const entry of entries) {
      const pair = pairOf(finding, entry, idf);
      if (pair) finding.pairs.push(pair);
    }
    const best = creditPairs(finding);
    finding.best = best;
    if (!best) continue;
    paired.add(finding);
    if (best.wrongRule) wrongRule.push({ finding, entry: best.entry });
    if (best.relation !== 'same') repeats.push({ finding, entry: best.entry });
  }
  // A best pair resting on the rule and lines alone is a guess among the entries of its
  // file; when another finding carries that entry on a name, a word or a criterion, the
  // guess moves to the next entry of the file and rule that nothing found yet and whose
  // prose the finding shares a word with.
  const telling = (pair) => [...pair.evidence].some((token) => /^(?:id|said|wcag):/.test(token));
  for (const finding of findings) {
    const best = finding.best;
    if (!best || best.relation !== 'same' || !best.ruled || telling(best)) continue;
    if (!best.entry.credits.some((pair) => pair.finding !== finding && telling(pair))) continue;
    const next = finding.pairs.find((pair) => pair !== best && pair.relation === 'same' && pair.ruled
      && !pair.entry.credits.length && pair.overlap > 0);
    if (!next) continue;
    best.entry.credits.splice(best.entry.credits.indexOf(best), 1);
    best.status = 'moved';
    best.by = next.entry.id;
    next.status = 'best';
    next.entry.credits.push(next);
    finding.best = next;
  }
  for (const entry of crossFile) {
    entry.support = crossFileSupport(entry, findings, instructionWords);
    for (const finding of entry.support) paired.add(finding);
  }
  const unmatched = findings.filter((finding) => !paired.has(finding));

  // An entry is judged by the findings filed under its instruction in its own file; a
  // finding in another file, or under another rule, may rate a neighbouring defect.
  const severityMismatches = [];
  for (const entry of entries) {
    if (!entry.severity || !entry.credits.length) continue;
    const ruled = entry.credits.filter((pair) => !pair.wrongRule);
    const own = ruled.filter((pair) => pair.relation === 'same');
    const judges = own.length ? own : ruled;
    if (!judges.length || judges.some((pair) => pair.finding.severity === entry.severity)) continue;
    severityMismatches.push({ finding: [...judges].sort(byRank)[0].finding, entry });
  }

  // A finding no entry claims but that names what a bait entry says is compliant. A test
  // finding names the code it wants tested, which says nothing against that code: it can
  // hit only a bait about specs.
  const baitHits = [];
  for (const finding of unmatched) {
    const testing = finding.severity === 'missing-unit-test'
      || (finding.instructions.size > 0 && [...finding.instructions].every(isTestInstruction));
    for (const bait of baits) {
      if (bait.file && !sameFile(finding.file, bait.file)) continue;
      if (testing && !bait.aboutTests) continue;
      const shared = [...bait.identifiers].filter((word) => finding.words.has(word)).length;
      if (shared >= (bait.file ? 1 : 2)) {
        baitHits.push({ finding, bait });
        break;
      }
    }
  }

  const violations = entries.filter((entry) => inScope(entry));
  const outOfScope = entries.filter((entry) => !inScope(entry));
  const byInstruction = new Map();
  for (const entry of violations) {
    for (const id of entry.instructions) {
      const row = byInstruction.get(id) || { found: 0, total: 0 };
      row.total += 1;
      if (entry.credits.length) row.found += 1;
      byInstruction.set(id, row);
    }
  }
  const found = violations.filter((entry) => entry.credits.length);
  return {
    findings: findings.length,
    matched: paired.size,
    violations: { found: found.length, total: violations.length },
    crossFile: { found: crossFile.filter((entry) => entry.support.length).length, total: crossFile.length },
    byInstruction,
    misses: violations.filter((entry) => !entry.credits.length),
    relatedOnly: found.filter((entry) => entry.credits.every((pair) => pair.relation !== 'same')),
    outOfScope: outOfScope.map((entry) => entry.id),
    scoped: reviewed.length > 0,
    checklists: report.checklists.length > 0,
    unmatched,
    wrongRule,
    repeats,
    severityMismatches,
    baitHits,
    itemVerdicts: itemVerdicts(report, violations),
    reportWarnings: report.warnings.length,
    detail: { entries, crossFile, findings },
  };
}

const percent = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '-');
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const where = (finding) => `${finding.file.replace(/^.*?test-environment\//, '')}:${finding.lines || '?'}`;
const ruleOf = (finding) => [...finding.instructions].join('+') || clip(finding.rule, 30);

function formatScore(result, limit) {
  const out = [];
  out.push(`recall: ${result.violations.found}/${result.violations.total} violations (${percent(result.violations.found, result.violations.total)})`
    + (result.relatedOnly.length ? `, ${result.relatedOnly.length} of them found only in a related file` : '')
    + `, cross-file ${result.crossFile.found}/${result.crossFile.total}`
    + (result.outOfScope.length ? `; ${result.outOfScope.length} outside the reviewed files (${result.outOfScope.join(', ')})` : ''));
  if (!result.scoped) out.push('scope: every entry - the report has no coverage markers naming the walked files (review with --with-checklist)');
  out.push(`precision: ${result.matched}/${result.findings} findings matched a key entry (${percent(result.matched, result.findings)}); ${result.wrongRule.length} under a different instruction`
    + (result.repeats.length ? `, ${result.repeats.length} only an entry of another file they name or share a unit with` : ''));
  out.push(`bait hits: ${result.baitHits.length}`);
  for (const { finding, bait } of result.baitHits.slice(0, limit)) {
    out.push(`  ${bait.id} ${where(finding)} ${clip(finding.problem, 90)}`);
  }
  out.push(`severity mismatches: ${result.severityMismatches.length}`);
  for (const { finding, entry } of result.severityMismatches.slice(0, limit)) {
    out.push(`  ${entry.id} expected ${entry.severity}, got ${finding.severity} at ${where(finding)}`);
  }
  const weakest = [...result.byInstruction.entries()]
    .map(([id, row]) => ({ id, ...row }))
    .sort((a, b) => a.found / a.total - b.found / b.total || b.total - a.total)
    .slice(0, limit);
  out.push(`weakest instructions: ${weakest.map((row) => `${row.id} ${row.found}/${row.total}`).join(', ')}`);
  // The items most often ticked OK where the key has them broken - a second question's candidates.
  const given = (row) => row.falseOk.length + row.flagged.length + row.open.length;
  const sum = (count) => result.itemVerdicts.reduce((total, row) => total + count(row), 0);
  const falseOks = result.itemVerdicts.filter((row) => row.falseOk.length)
    .sort((a, b) => b.falseOk.length - a.falseOk.length || b.falseOk.length / given(b) - a.falseOk.length / given(a));
  if (!result.checklists) {
    out.push('false OKs: not measured - the report has no checklist blocks (review with --with-checklist)');
  } else {
    out.push(`false OKs: ${sum((row) => row.falseOk.length)}/${sum(given)} verdicts on items the key has broken (${percent(sum((row) => row.falseOk.length), sum(given))})`
      + `; absent from their file's checklist: ${sum((row) => row.absent.length)}; by item (first ${Math.min(limit, falseOks.length)} of ${falseOks.length}):`);
  }
  for (const row of falseOks.slice(0, limit)) {
    out.push(`  ${row.item} ticked OK for ${row.falseOk.length} of ${given(row)} entries breaking it (${percent(row.falseOk.length, given(row))}): `
      + row.falseOk.map((entry) => `${entry.id}${entry.credits.length ? ' (found)' : ''}`).join(', ')
      + (row.absent.length ? `; absent for ${row.absent.length} more` : ''));
  }
  out.push(`misses (first ${Math.min(limit, result.misses.length)} of ${result.misses.length}):`);
  for (const entry of result.misses.slice(0, limit)) {
    out.push(`  ${entry.id} ${entry.files[0]} [${entry.instructions.join('+')}] ${clip(entry.text, 90)}`);
  }
  out.push(`unmatched findings (first ${Math.min(limit, result.unmatched.length)} of ${result.unmatched.length}):`);
  for (const finding of result.unmatched.slice(0, limit)) {
    out.push(`  ${where(finding)} [${ruleOf(finding)}] ${clip(finding.problem, 90)}`);
  }
  if (result.reportWarnings) out.push(`report parser warnings: ${result.reportWarnings}`);
  return out.join('\n');
}

// Every pair one entry has, with how it counted - the evidence behind a miss or a hit.
function formatExplain(result, id) {
  const { entries, crossFile } = result.detail;
  const entry = [...entries, ...crossFile].find((candidate) => candidate.id === id);
  if (!entry) return `no entry ${id} in the key`;
  const quoted = entry.identifiers.map(({ anchor, aside, at }) => `${at === 'end' ? '…' : ''}${anchor}${at === 'start' ? '…' : ''}${aside ? ' (aside)' : ''}`);
  const out = [
    `${entry.id} ${entry.kind === 'cross-file' ? 'cross-file' : `[${entry.instructions.join('+')}] ${entry.severity || '-'} ${entry.files.join(', ')}`}`,
    `  ${clip(entry.text, 300)}`,
    `  quotes named by: ${quoted.join(', ') || '-'}; files: ${[...entry.cited].join(', ') || '-'}`
      + (entry.lines ? `; lines: ${Object.values(entry.lines).join(' / ')}` : '')
      + (entry.wcag && entry.wcag.length ? `; wcag: ${entry.wcag.join(', ')}` : '')
      + (entry.items && entry.items.length ? `; items: ${entry.items.join(', ')}` : ''),
  ];
  if (entry.verdicts && entry.verdicts.size) {
    out.push(`  checklist: ${[...entry.verdicts].map(([address, verdict]) => `${address} ${verdict}`).join(', ')}`);
  }
  if (entry.kind === 'cross-file') {
    out.push(`  ${entry.support.length ? 'found' : 'missed'}: ${entry.support.length} supporting findings`);
    for (const finding of entry.support.slice(0, 12)) out.push(`    ${where(finding)} [${ruleOf(finding)}] ${clip(finding.problem, 110)}`);
    return out.join('\n');
  }
  const pairs = result.detail.findings.flatMap((finding) => finding.pairs.filter((pair) => pair.entry === entry));
  out.push(`  ${entry.credits.length ? 'found' : 'missed'}: ${entry.credits.length} crediting of ${pairs.length} pairing findings`);
  for (const pair of pairs.sort(byRank)) {
    const status = pair.status === 'best' || pair.status === 'credited' ? pair.status
      : `${pair.status}${pair.by ? ` by ${pair.by}` : ''}; best ${pair.finding.best.entry.id}`;
    out.push(`    ${status} | ${where(pair.finding)} ${pair.finding.severity} [${ruleOf(pair.finding)}] ${pair.relation}`
      + ` R${pair.ruled} L${pair.placed} N[${pair.named.join(',')}]`
      + (pair.said ? ` S[${pair.said.source}: ${pair.said.words.join(',')}]` : '')
      + (pair.cited.length ? ` W[${pair.cited.join(',')}]` : '')
      + ` score ${pair.score} :: ${clip(pair.finding.problem, 110)}`);
  }
  return out.join('\n');
}

// Entries the scorer can hardly tell found from missed: no name quoted outside an aside
// (a quote as short as `as` is none) and no lines - only the instruction and a finding's
// best pair carry them - and cross-file entries quoting fewer than two names that are no
// instruction's. Also the entries the false-OK count cannot use: naming no checklist item,
// or one no instruction of theirs has - and the checklist items no violation names, which
// the false-OK count never measures.
function lintKey(key) {
  const files = new Set(key.findings.flatMap((entry) => entry.files));
  const resolveFile = fileResolver(files);
  const instructionWords = new Set(key.findings.flatMap((entry) => [...wordsOf(entry.instructions.join(' '))]));
  const { df } = documentFrequency(key.findings.map((entry) => entry.text));
  const bare = key.findings.filter((entry) => termsOf(entry.text, resolveFile, df).bare
    && !Object.keys(entry.lines || {}).length);
  const thin = key.crossFile.filter((entry) => new Set(termsOf(entry.text, resolveFile, df).identifiers
    .flatMap(({ words }) => words).filter((word) => !instructionWords.has(word))).size < 2);
  const itemless = key.findings.filter((entry) => !(entry.items || []).length);
  const stray = key.findings.flatMap((entry) => (entry.items || []).filter((address) => {
    const [id, n] = address.split('#');
    const instruction = loadRules().get(id);
    return !entry.instructions.includes(id) || !instruction || !instruction.items.has(Number(n));
  }).map((address) => `${entry.id} ${address}`));
  const named = new Set(key.findings.flatMap((entry) => entry.items || []));
  const checklist = [...loadRules()].flatMap(([id, instruction]) => [...instruction.items]
    .map(([n, item]) => ({ address: `${id}#${n}`, text: String(item.text ?? item) })));
  const unnamed = checklist.filter(({ address }) => !named.has(address));
  return [
    `violations quoting no name outside an aside and without lines: ${bare.length}/${key.findings.length}`,
    ...bare.map((entry) => `  ${entry.id} [${entry.instructions.join('+')}] ${entry.files[0]} :: ${clip(entry.text, 90)}`),
    `cross-file entries quoting fewer than two names: ${thin.length}/${key.crossFile.length}`,
    ...thin.map((entry) => `  ${entry.id} :: ${clip(entry.text, 110)}`),
    `checklist items no violation names: ${unnamed.length}/${checklist.length}`,
    ...unnamed.map(({ address, text }) => `  ${address} :: ${clip(text, 90)}`),
    `violations naming no checklist item: ${itemless.length}/${key.findings.length}`,
    ...itemless.map((entry) => `  ${entry.id} [${entry.instructions.join('+')}] ${entry.files[0]} :: ${clip(entry.text, 90)}`),
    `items no instruction of their entry has: ${stray.length}`,
    ...stray.map((line) => `  ${line}`),
  ].join('\n');
}

// An `--only-md` report writes no PR fields at all, which the renderer's parser flags on every
// finding; check-part drops the same warnings for that format. A report with any PR field keeps them.
function withoutMdOnlyWarnings(report) {
  const prMissing = /: znalezisko bez pola "PR (?:Problem|Expected|Locations)"\.$/;
  const hasPr = report.files.some((file) => file.findings.some((f) => f.prProblem || f.prExpected || f.prLocations));
  if (hasPr) return report;
  return { ...report, warnings: report.warnings.filter((w) => !prMissing.test(w)) };
}

const reReportData = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/;

// The page's data as the report the Markdown parses into. A walked file's ticks sit under
// its coverage entry, so a file with no block there has none - as in the Markdown. The
// parser's warnings are not on the page (see readReport).
function reportFromHtml(html) {
  const match = html.match(reReportData);
  if (!match) throw new Error('no report data in the page - score the Markdown, or a page render-report.cjs wrote');
  const data = JSON.parse(match[1]);
  return {
    title: data.title,
    datetime: data.datetime,
    skipped: data.skipped,
    emptyState: data.emptyState,
    files: data.files.map((file) => ({
      path: file.path,
      findings: file.findings.map((finding) => {
        // The field as written; a page rendered before `ruleSource` has only the
        // resolved text, whose instruction ids still name the instructions.
        const rule = finding.ruleSource || finding.rule;
        return { ...finding, rule, tags: parseRuleField(rule) };
      }),
    })),
    coverage: data.coverage,
    checklists: data.coverage
      .filter((entry) => entry.items.length)
      .map((entry) => ({ path: entry.path, items: entry.items.map((item) => ({ ...item, ok: item.state !== 'open' })) })),
    warnings: [],
  };
}

// The renderer deletes the Markdown next to its page only when the parser had no warning,
// so a Markdown still there holds the warnings of the report the page shows.
function readReport(file) {
  const text = fs.readFileSync(file, 'utf8');
  const fromMarkdown = (markdown) => withoutMdOnlyWarnings(parseReport(markdown));
  if (!/\.html?$/i.test(file) && !/^\s*<!doctype html/i.test(text)) return fromMarkdown(text);
  const report = reportFromHtml(text);
  const kept = file.replace(/\.html?$/i, '') + '.md';
  if (kept !== file && fs.existsSync(kept)) report.warnings = fromMarkdown(fs.readFileSync(kept, 'utf8')).warnings;
  return report;
}

const usage = 'usage: node score-review.cjs --report <review.md|raport.html> [--key <answer-key.json>] [--limit N] [--json] [--explain <entry id>]\n'
  + '       node score-review.cjs --lint-key [--key <answer-key.json>]\n';

function main(argv) {
  const args = { key: defaultKey, limit: 15, json: false, report: null, explain: null, lintKey: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--report') args.report = argv[++i];
    else if (arg === '--key') args.key = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--json') args.json = true;
    else if (arg === '--explain') args.explain = argv[++i];
    else if (arg === '--lint-key') args.lintKey = true;
  }
  const key = JSON.parse(fs.readFileSync(args.key, 'utf8'));
  if (args.lintKey) {
    process.stdout.write(`${lintKey(key)}\n`);
    return 0;
  }
  if (!args.report) {
    process.stderr.write(usage);
    return 2;
  }
  let report;
  try {
    report = readReport(args.report);
  } catch (err) {
    process.stderr.write(`${args.report}: ${(err && err.message) || err}\n`);
    return 1;
  }
  const result = score(report, key);
  if (args.explain) {
    process.stdout.write(`${formatExplain(result, args.explain)}\n`);
  } else if (args.json) {
    const { detail, ...rest } = result;
    process.stdout.write(`${JSON.stringify({
      ...rest,
      byInstruction: Object.fromEntries(rest.byInstruction),
      misses: rest.misses.map((entry) => entry.id),
      relatedOnly: rest.relatedOnly.map((entry) => entry.id),
      unmatched: rest.unmatched.map((finding) => `${where(finding)} ${finding.problem}`),
      wrongRule: rest.wrongRule.map(({ finding, entry }) => `${entry.id} ${where(finding)}`),
      repeats: rest.repeats.map(({ finding, entry }) => `${entry.id} ${where(finding)}`),
      severityMismatches: rest.severityMismatches.map(({ finding, entry }) => `${entry.id} ${entry.severity}->${finding.severity}`),
      baitHits: rest.baitHits.map(({ finding, bait }) => `${bait.id} ${where(finding)}`),
      itemVerdicts: rest.itemVerdicts.map(({ item, ...verdicts }) => ({
        item,
        ...Object.fromEntries(Object.entries(verdicts).map(([verdict, list]) => [verdict, list.map((entry) => entry.id)])),
      })),
    })}\n`);
  } else {
    process.stdout.write(`${formatScore(result, args.limit)}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { score, formatScore, formatExplain, lintKey, keyIdentifiers, wordsOf, withoutMdOnlyWarnings, reportFromHtml, readReport };
