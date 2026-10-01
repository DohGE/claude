'use strict';

// The rulebook: one JSON file per FILE KIND under `instructions/`, layered with the
// reviewed project's `.claude/doh/instructions/`. A kind names the paths it covers
// (`pattern`) and carries the whole checklist a file of that kind is walked against -
// instruction by instruction, every item keeping the `<id>#<n>` address it has in its
// instruction. A file is reviewed against the ONE kind that describes it most
// specifically (matchKind), so its plan is decided by that choice alone: nothing is
// narrowed per item, per scope or per audience any more.

const fs = require('node:fs');
const path = require('node:path');
const { factKinds, builtinAnswers, compileProbe } = require('./repo-facts.cjs');

// The address grammar every consumer shares: check-part's `reAddress`, the report's
// `reRuleAddress` and the checklist block all read an id as this.
const reInstructionId = /^[a-z0-9][a-z0-9-]*$/;
const reItemId = /^([a-z0-9][a-z0-9-]*)#([1-9]\d*)$/;
// What a later definition of an instruction may restate. `items` merges per number.
const instructionProps = ['name', 'gate', 'findings', 'preamble', 'checklistSize', 'severity'];
// The report's severity keys (render-report's ladder). A `severity` on an instruction
// or on one item fixes the one every finding naming it is reported with.
const severityLevels = ['critical', 'high', 'medium', 'low', 'missing-unit-test'];
// Rank for "the strictest of the fixed severities a finding names": Missing Unit Test
// sits off the ladder, between High and Critical, so it wins over any softer level.
const severityRank = { low: 1, medium: 2, high: 3, 'missing-unit-test': 3.5, critical: 4 };
// What a NIEZWERYFIKOWANE verdict opens its reason with (check-part), and so what an
// item's prepared `unverified` verdict must start with.
const unverifiedReasons = ['narzędzie:', 'poza recenzją:', 'działająca aplikacja:'];

// `[1,2,3,5,9,10]` -> `1-3,5,9-10`: the plan says WHICH items a file walks, not
// just how many, so a narrowed checklist stays addressable as `<id>#<n>`.
function formatItemSpec(numbers) {
  const parts = [];
  let start = null;
  let prev = null;
  for (const n of numbers) {
    if (start === null) {
      start = prev = n;
      continue;
    }
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  if (start !== null) parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(',');
}

// `(a|b)` alternatives are expanded before anything else, innermost group first, so
// `<name>.component.(scss|css)` is two plain patterns and a nested group needs no
// grammar of its own.
function expandAlternations(pattern) {
  const group = pattern.match(/\(([^()]*)\)/);
  if (!group) return [pattern];
  const head = pattern.slice(0, group.index);
  const tail = pattern.slice(group.index + group[0].length);
  return [...new Set(group[1].split('|').flatMap((choice) => expandAlternations(head + choice + tail)))];
}

// One path segment: `<name>` is one or more characters of a single segment, `*` any
// run of them (none included), everything else is itself. `literal` counts those
// last characters - how much of the segment the pattern actually spells out.
function compileSegment(segment) {
  let re = '';
  let literal = 0;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '<') {
      const close = segment.indexOf('>', i);
      if (close <= i + 1) throw new Error(`"<" without a named "<...>" placeholder in "${segment}"`);
      re += '[^/]+';
      i = close;
    } else if (ch === '*') {
      if (segment[i + 1] === '*') throw new Error(`"**" must be a whole path segment, not part of "${segment}"`);
      re += '[^/]*';
    } else if ('()|>'.includes(ch)) {
      throw new Error(`unbalanced "${ch}" in "${segment}"`);
    } else if ('{}'.includes(ch)) {
      throw new Error(`braces are not alternatives here - write (a|b) in "${segment}"`);
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/, '\\$&');
      literal++;
    }
  }
  return { re, literal };
}

// A variant matches the END of a path (`(?:^|/)`), so a kind written for
// `src/app/...` also covers the same tree inside a workspace (`apps/web/src/app/...`).
// `baseRegex` is its file-name segment alone: the match a file keeps when it sits
// somewhere the kind does not expect - still that kind of file, reviewed as one, and
// its misplacement is one of the kind's own items.
function compileVariant(variant) {
  const segments = variant.split('/');
  if (segments.some((segment) => segment === '')) throw new Error(`empty path segment in "${variant}"`);
  const last = segments.length - 1;
  let body = '';
  let dirLiteral = 0;
  let base = null;
  segments.forEach((segment, i) => {
    if (segment === '**') {
      body += i === last ? '(?:[^/]+/)*[^/]+' : '(?:[^/]+/)*';
      return;
    }
    const compiled = compileSegment(segment);
    body += i === last ? compiled.re : `${compiled.re}/`;
    if (i === last) base = compiled;
    else dirLiteral += compiled.literal;
  });
  return {
    regex: new RegExp(`(?:^|/)${body}$`),
    baseRegex: base && last > 0 ? new RegExp(`^${base.re}$`) : null,
    baseLiteral: base ? base.literal : 0,
    dirLiteral,
  };
}

function compilePattern(pattern) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  if (patterns.length === 0 || patterns.some((p) => typeof p !== 'string' || p.trim() === '')) {
    throw new Error('"pattern" must be a non-empty string or a list of them');
  }
  const negated = patterns.find((p) => p.startsWith('!'));
  if (negated) throw new Error(`"${negated}" cannot exclude - a more specific kind takes the files it describes`);
  return patterns.flatMap(expandAlternations).map(compileVariant);
}

// Every `.json` under the folder in name order, so which of two clashing files wins
// never depends on the file system. The `.md` files are collected to be named: a
// project rulebook written before kinds existed is ignored, and must be told so.
function rulebookFilesUnder(dir) {
  const json = [];
  const markdown = [];
  (function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) json.push(full);
      else if (entry.name.endsWith('.md')) markdown.push(full);
    }
  })(dir);
  return { json, markdown };
}

// What an item may carry besides its text, each checked where it is read so a typo
// warns instead of silently binding nothing: `facts` - repository fact kinds
// (repo-facts.cjs) that contradict an OK on the item; `probe` - one probe or a list,
// lines the verdict must answer; `secondQuestion` - what an OK must also answer, for
// items reviews mark OK wrongly; `answer` - the repo-facts.cjs answer to that question
// (`builtinAnswers`), printed per file; `severity` - the fixed severity of its findings;
// `sameAs` - items one defect breaks together, reported as ONE finding naming both;
// `unverified` - the prepared NIEZWERYFIKOWANE reason of an item no review can check
// from the files (the test order, a green spec run).
function readItemExtras(item, address, where, warnings) {
  const extras = {};
  if (item.facts !== undefined) {
    const kinds = Array.isArray(item.facts) ? item.facts : [];
    const unknown = kinds.filter((kind) => !factKinds.includes(kind));
    if (!Array.isArray(item.facts) || unknown.length > 0) {
      warnings.push(`${where}: ${address} "facts" ${JSON.stringify(Array.isArray(item.facts) ? unknown : item.facts)} names no known fact kind - ignored.`);
    }
    const known = kinds.filter((kind) => factKinds.includes(kind));
    if (known.length > 0) extras.facts = known;
  }
  if (item.probe !== undefined) {
    const probes = [];
    for (const spec of [].concat(item.probe)) {
      try {
        probes.push(compileProbe(spec));
      } catch (err) {
        warnings.push(`${where}: ${address} probe ${JSON.stringify(spec)} - ${err.message}; ignored.`);
      }
    }
    if (probes.length > 0) extras.probes = probes;
  }
  if (item.secondQuestion !== undefined) {
    if (typeof item.secondQuestion === 'string' && item.secondQuestion.trim() !== '') extras.secondQuestion = item.secondQuestion.trim();
    else warnings.push(`${where}: ${address} "secondQuestion" is not a text - ignored.`);
  }
  if (item.answer !== undefined) {
    if (builtinAnswers.includes(item.answer)) extras.answer = item.answer;
    else warnings.push(`${where}: ${address} "answer" ${JSON.stringify(item.answer)} is not one of ${builtinAnswers.join(', ')} - ignored.`);
  }
  if (item.severity !== undefined) {
    if (severityLevels.includes(item.severity)) extras.severity = item.severity;
    else warnings.push(`${where}: ${address} "severity" ${JSON.stringify(item.severity)} is not one of ${severityLevels.join(', ')} - ignored.`);
  }
  if (item.sameAs !== undefined) {
    const targets = Array.isArray(item.sameAs) ? item.sameAs : [];
    const bad = targets.filter((target) => typeof target !== 'string' || !reItemId.test(target) || target === address);
    if (!Array.isArray(item.sameAs) || bad.length > 0) {
      warnings.push(`${where}: ${address} "sameAs" ${JSON.stringify(Array.isArray(item.sameAs) ? bad : item.sameAs)} names no other item address - ignored.`);
    }
    const good = [...new Set(targets.filter((target) => !bad.includes(target)))];
    if (good.length > 0) extras.sameAs = good;
  }
  if (item.unverified !== undefined) {
    const reason = typeof item.unverified === 'string' ? item.unverified.trim() : '';
    if (unverifiedReasons.some((prefix) => reason.startsWith(prefix) && reason.length > prefix.length + 1)) extras.unverified = reason;
    else warnings.push(`${where}: ${address} "unverified" ${JSON.stringify(item.unverified)} is not "${unverifiedReasons.join('" / "')}" with a reason - ignored.`);
  }
  return Object.keys(extras).length > 0 ? extras : null;
}

// One instruction as a kind file carries it, validated. Items keep only what can be
// addressed: an id of this instruction with a number, and a text - plus their extras.
function readInstruction(entry, where, warnings) {
  if (!entry || typeof entry.id !== 'string' || !reInstructionId.test(entry.id)) {
    warnings.push(`${where}: instruction id ${JSON.stringify(entry && entry.id)} is not a lowercase \`a-z0-9-\` name - the instruction is skipped.`);
    return null;
  }
  const items = new Map();
  const extras = new Map();
  for (const item of Array.isArray(entry.items) ? entry.items : []) {
    const m = String(item && item.id).match(reItemId);
    if (!m || m[1] !== entry.id || typeof item.text !== 'string' || item.text.trim() === '') {
      warnings.push(`${where}: item ${JSON.stringify(item && item.id)} is not an \`${entry.id}#<n>\` id with a text - skipped.`);
      continue;
    }
    const n = Number(m[2]);
    if (items.has(n)) {
      warnings.push(`${where}: item ${entry.id}#${n} is listed twice - the first one is kept.`);
      continue;
    }
    items.set(n, item.text);
    const extra = readItemExtras(item, item.id, where, warnings);
    if (extra) extras.set(n, extra);
  }
  const numbers = [...items.keys()].sort((a, b) => a - b);
  if (entry.selectedItems !== undefined && formatItemSpec(numbers) !== String(entry.selectedItems)) {
    warnings.push(`${where}: "${entry.id}" declares selectedItems ${entry.selectedItems} but lists ${formatItemSpec(numbers) || 'no item'}.`);
  }
  if (Number.isInteger(entry.checklistSize) && numbers.some((n) => n > entry.checklistSize)) {
    warnings.push(`${where}: "${entry.id}" lists an item beyond its checklistSize ${entry.checklistSize}.`);
  }
  if (entry.findings !== undefined && entry.findings !== 'per-file') {
    warnings.push(`${where}: "${entry.id}" declares findings ${JSON.stringify(entry.findings)} - only "per-file" exists, so it is ignored.`);
  }
  if (entry.severity !== undefined && !severityLevels.includes(entry.severity)) {
    warnings.push(`${where}: "${entry.id}" declares severity ${JSON.stringify(entry.severity)} - not one of ${severityLevels.join(', ')}, so it is ignored.`);
  }
  const props = {};
  for (const prop of instructionProps) {
    if (entry[prop] === undefined) continue;
    if (prop === 'findings' && entry.findings !== 'per-file') continue;
    if (prop === 'severity' && !severityLevels.includes(entry.severity)) continue;
    props[prop] = prop === 'preamble' ? [].concat(entry.preamble).map(String) : entry[prop];
  }
  return { id: entry.id, props, items, extras, numbers };
}

// One layer's view of an instruction, gathered from every kind that carries it. The
// generator writes one dictionary into all of them, so two kinds of one layer
// disagreeing is an edit that reached one copy only: reported, the first one kept.
// An item's extras travel with its text - one edit, one copy.
function absorbInstruction(defs, instruction, where, warnings) {
  let def = defs.get(instruction.id);
  if (!def) {
    def = { props: {}, items: new Map(), extras: new Map(), from: where };
    defs.set(instruction.id, def);
  }
  for (const [prop, value] of Object.entries(instruction.props)) {
    if (def.props[prop] === undefined) def.props[prop] = value;
    else if (JSON.stringify(def.props[prop]) !== JSON.stringify(value)) {
      warnings.push(`${where}: "${instruction.id}" ${prop} differs from ${def.from} - the one in ${def.from} is kept.`);
    }
  }
  for (const [n, text] of instruction.items) {
    const extra = instruction.extras.get(n) || null;
    if (!def.items.has(n)) {
      def.items.set(n, text);
      if (extra) def.extras.set(n, extra);
    } else if (def.items.get(n) !== text) {
      warnings.push(`${where}: ${instruction.id}#${n} differs from ${def.from} - the one in ${def.from} is kept.`);
    } else if (JSON.stringify(def.extras.get(n) || null) !== JSON.stringify(extra)) {
      warnings.push(`${where}: ${instruction.id}#${n} extras (facts, probe, secondQuestion, answer, severity, sameAs, unverified) differ from ${def.from} - the ones in ${def.from} are kept.`);
    }
  }
}

// `dirs` is the layered list, lowest priority first: the skill's `instructions/`,
// then the project's `.claude/doh/instructions/` (null or a missing folder = no layer).
// A project kind of the same name REPLACES the skill's kind - its pattern and plan
// with it - and every other project kind is one more. An instruction a project kind
// restates overrides, for every kind, only what it restates: its name, gate,
// findings, preamble or size, and the texts of the item numbers it lists.
function loadRulebook(dirs) {
  const warnings = [];
  const kindsByName = new Map();
  const layerDefs = [];
  (Array.isArray(dirs) ? dirs : [dirs]).forEach((dir, layer) => {
    if (!dir) return;
    const { json, markdown } = rulebookFilesUnder(dir);
    if (layer > 0 && markdown.length > 0) {
      const shown = markdown.slice(0, 5).map((f) => path.relative(dir, f).split(path.sep).join('/')).join(', ');
      const rest = markdown.length > 5 ? `, (+${markdown.length - 5} more)` : '';
      warnings.push(`${dir} holds Markdown instructions (${shown}${rest}) - the rulebook is JSON file kinds now, so they are ignored.`);
    }
    const defs = new Map();
    layerDefs.push(defs);
    const seen = new Map();
    for (const file of json) {
      const where = path.relative(dir, file).split(path.sep).join('/');
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        warnings.push(`${where}: not valid JSON (${(err && err.message) || err}) - skipped.`);
        continue;
      }
      if (!raw || typeof raw.kind !== 'string' || raw.kind.trim() === '') {
        warnings.push(`${where}: no "kind" name - skipped.`);
        continue;
      }
      if (seen.has(raw.kind)) {
        warnings.push(`${where}: kind "${raw.kind}" is already defined by ${seen.get(raw.kind)} - the first one is kept.`);
        continue;
      }
      let variants;
      try {
        variants = compilePattern(raw.pattern);
      } catch (err) {
        warnings.push(`${where}: invalid pattern ${JSON.stringify(raw.pattern)} (${err.message}) - kind "${raw.kind}" is skipped.`);
        continue;
      }
      seen.set(raw.kind, where);
      const plan = [];
      for (const entry of Array.isArray(raw.instructions) ? raw.instructions : []) {
        const instruction = readInstruction(entry, where, warnings);
        if (!instruction) continue;
        if (plan.some((step) => step.id === instruction.id)) {
          warnings.push(`${where}: "${instruction.id}" appears twice in kind "${raw.kind}" - the first one is kept.`);
          continue;
        }
        absorbInstruction(defs, instruction, where, warnings);
        if (instruction.numbers.length > 0) plan.push({ id: instruction.id, numbers: instruction.numbers });
      }
      const itemCount = plan.reduce((n, step) => n + step.numbers.length, 0);
      if (raw.itemCount !== undefined && raw.itemCount !== itemCount) {
        warnings.push(`${where}: kind "${raw.kind}" declares itemCount ${raw.itemCount} but lists ${itemCount} items.`);
      }
      kindsByName.set(raw.kind, {
        name: raw.kind,
        pattern: raw.pattern,
        role: typeof raw.role === 'string' ? raw.role : '',
        notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
        exactLocation: raw.exactLocation === true,
        variants,
        plan,
        itemCount,
        file,
        layer,
      });
    }
  });

  // A layer restating an item replaces it whole: a probe written for the skill's text
  // need not fit the project's.
  const instructions = new Map();
  for (const defs of layerDefs) {
    for (const [id, def] of defs) {
      const merged = instructions.get(id) || { props: {}, items: new Map(), extras: new Map() };
      Object.assign(merged.props, def.props);
      for (const [n, text] of def.items) {
        merged.items.set(n, text);
        if (def.extras.has(n)) merged.extras.set(n, def.extras.get(n));
        else merged.extras.delete(n);
      }
      instructions.set(id, merged);
    }
  }
  for (const [id, { props, items, extras }] of instructions) {
    instructions.set(id, {
      id,
      name: typeof props.name === 'string' && props.name.trim() ? props.name : id,
      gate: typeof props.gate === 'string' && props.gate.trim() ? props.gate : null,
      findings: props.findings || null,
      preamble: props.preamble || [],
      severity: props.severity || null,
      size: Number.isInteger(props.checklistSize) ? props.checklistSize : Math.max(0, ...items.keys()),
      items,
      extras,
    });
  }
  // A pair is one defect seen from two instructions, so each side names the other:
  // a one-sided or dangling `sameAs` is an edit that reached one side only.
  for (const [id, ins] of instructions) {
    for (const [n, extra] of ins.extras) {
      for (const target of extra.sameAs || []) {
        const [, otherId, otherN] = target.match(reItemId);
        const other = instructions.get(otherId);
        if (!other || !other.items.has(Number(otherN))) {
          warnings.push(`${id}#${n} "sameAs" names ${target}, which no kind carries.`);
          continue;
        }
        const back = other.extras.get(Number(otherN));
        if (!back || !(back.sameAs || []).includes(`${id}#${n}`)) warnings.push(`${id}#${n} "sameAs" names ${target}, which does not name it back.`);
      }
    }
  }
  return { kinds: [...kindsByName.values()], instructions, warnings };
}

// The severity every finding naming `<id>#<n>` is reported with, or null when the
// reviewer decides it: the item's own, else its instruction's.
function fixedSeverity(instruction, n) {
  if (!instruction) return null;
  const extra = instruction.extras && instruction.extras.get(n);
  return (extra && extra.severity) || instruction.severity || null;
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// How specifically a kind describes a path, as a tuple compared left to right: the
// literal characters of its file-name segment (`<name>.component.html` beats `*.html`
// wherever both match), then whether the whole path matched rather than the file
// name alone, then the literal characters of its folders. null = not this kind.
function scoreOf(kind, normalized) {
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  let best = null;
  for (const variant of kind.variants) {
    let score = null;
    if (variant.regex.test(normalized)) score = [variant.baseLiteral, 1, variant.dirLiteral];
    else if (!kind.exactLocation && variant.baseRegex && variant.baseRegex.test(base)) score = [variant.baseLiteral, 0, 0];
    if (score && (!best || compareScores(score, best) > 0)) best = score;
  }
  return best;
}

// The kind a path is reviewed as, or null. Two kinds describing a path equally well
// is a rulebook defect the caller reports (`tied`); the pick stays deterministic -
// the project's kind before the skill's, then by name.
function matchKind(rulebook, relPath) {
  const normalized = String(relPath).replace(/\\/g, '/');
  let best = null;
  let tied = [];
  for (const kind of rulebook.kinds) {
    const score = scoreOf(kind, normalized);
    if (!score) continue;
    const cmp = best ? compareScores(score, best) : 1;
    if (cmp > 0) {
      best = score;
      tied = [kind];
    } else if (cmp === 0) tied.push(kind);
  }
  if (!best) return { kind: null, tied: [] };
  tied.sort((a, b) => (b.layer - a.layer) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: tied[0], tied: tied.length > 1 ? tied.map((kind) => kind.name) : [] };
}

// The copy of an instruction the reviewer reads: its preamble, then only the items
// this run's plans walk, each already written as the `<id>#<n>` it is ticked and
// cited by - numbering bullets by eye is where a tick came to name the wrong item.
function renderNumbered(instruction, numbers) {
  const lines = [`# ${instruction.name} (\`${instruction.id}\`)`, ''];
  for (const paragraph of instruction.preamble) lines.push(paragraph, '');
  lines.push(`Only the items this run walks are listed; each keeps its rulebook address \`${instruction.id}#<n>\`, so a gap in the numbers is expected.`, '');
  for (const n of numbers) {
    lines.push(`- ${instruction.id}#${n}: ${instruction.items.get(n)}`);
    const extra = instruction.extras && instruction.extras.get(n);
    if (extra && extra.secondQuestion) lines.push(`  - drugie pytanie: ${extra.secondQuestion}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  reInstructionId, formatItemSpec, expandAlternations, compilePattern, loadRulebook, matchKind, renderNumbered,
  severityLevels, severityRank, unverifiedReasons, fixedSeverity,
};
