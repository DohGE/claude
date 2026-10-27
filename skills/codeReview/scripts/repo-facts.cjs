'use strict';

// Facts about the reviewed repository that one open file cannot show its reviewer: who
// imports an export, which translation keys the code asks for and which nothing asks for,
// which literals, conditions and label mappings repeat across files, which state fields the
// initial state forgets. Collected once in Step 1 (review-context.cjs) from the reviewed
// revision: asked for file by file, the cross-file look was in practice skipped, and these
// are exactly the findings that went missing. A fact states what the code is, never a
// finding - the rulebook names the items each fact kind contradicts (an item's `facts`) or
// only points at (`probe: { "fact": ... }`), and check-part.cjs holds those items' verdicts
// to it. Probes are the per-line half: a pattern an item declares, run over each file whose
// plan walks that item.
//
// Everything here is a pure function of `files` (project-relative path -> text): no git, no
// disk, so a test builds a repository out of a Map.

const path = require('node:path');

// FIXED IDENTIFIERS: the rulebook's `facts` and `probe.fact` fields name these kinds, and
// check-part.cjs reads them back from the facts file. Renaming one silently unlinks every
// item that names it.
const factKinds = [
  'export-unused', 'export-single-importer', 'barrel-unused', 'guard-without-route',
  'pipe-unused', 'pipe-single-template',
  'i18n-missing-key', 'i18n-unused-key', 'i18n-duplicate-value', 'i18n-locale-extra-key',
  'cross-area-import', 'repeated-literal', 'repeated-condition', 'mapping-duplicate', 'mapping-duplicate-caller',
  'initial-state-gap', 'reducer-empty-instead-of-null', 'reducer-flag-without-fail', 'action-trio-incomplete',
  'output-untested', 'spec-input-not-set', 'snapshot-outside-folder', 'snapshot-missing',
  'area-routes-twice',
  'spec-zone-based', 'stub-under-multiple-tokens', 'enum-variant-untested', 'snapshot-field-drift',
  'projector-inputs', 'projector-argument-order', 'action-unconsumed', 'template-symbol-not-imported',
  'barrel-bypass', 'dto-casing-mixed', 'component-injects-data-access', 'state-key-literal', 'input-binding-missing',
];
// Kinds that only point at a line: another reading of the code is as likely as the defect.
const hintKinds = new Set(['export-single-importer', 'pipe-single-template', 'snapshot-missing', 'projector-inputs']);
// FIXED IDENTIFIERS as well: a probe's `builtin` names one of these.
const builtinProbes = ['for-without-empty', 'signal-reads-without-let', 'markup-repeat', 'area-root-file', 'hover-without-focus', 'action-label-mismatch'];
// And an item's `answer` names one of these: a second question the script answers from
// the whole repository (collectFacts' `answers`), printed under the item in the bundle.
const builtinAnswers = ['repo-search', 'input-binding', 'area-layout'];
// A duplication is a finding from its third copy: two may still diverge, three are a pattern.
const minCopies = 3;

const reScript = /\.(?:[cm]?[jt]sx?)$/;
const reTemplate = /\.html?$/;
const reSpec = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const reDeclaration = /\.d\.ts$/;
const rePipeFile = /\.pipe\.[cm]?[jt]s$/;
const reKeyShaped = /^[A-Za-z][\w-]*(?:\.[\w-]+)+$/;
const reLocaleDir = /(?:^|\/)(?:i18n|locales?|translations?|lang)\//;
// Files nothing imports by design: the bundler, the test runner or the server starts them.
const reEntryFile = /(?:^|\/)(?:main|main\.server|server|app\.config\.server|app\.routes\.server|polyfills|test|setup-jest|test-setup|jest\.config|karma\.conf|playwright\.config|cypress\.config)\.[cm]?[jt]s$/;
const resolveExtensions = ['', '.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js'];

// Paths worth reading for facts: scripts, templates, JSON (translations, tsconfig) and
// snapshots (only their location matters). Build output and the doh run folders never are.
function isFactSource(p) {
  if (/(?:^|\/)(?:node_modules|dist|coverage|\.angular|\.nx|\.git|\.claude)\//.test(p)) return false;
  return reScript.test(p) || reTemplate.test(p) || /\.json$/.test(p) || /\.snap$/.test(p);
}

// ---------------------------------------------------------------------------------------
// Scanning

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function skipInterpolation(src, j) {
  let depth = 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\'' || c === '"' || c === '`') {
      j = skipString(src, j);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j + 1;
    j++;
  }
  return src.length;
}

// The index right after the closing quote; an unterminated '/" literal ends at its line end.
function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === '\n' && quote !== '`') return j;
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      j = skipInterpolation(src, j + 2);
      continue;
    }
    j++;
  }
  return src.length;
}

const blank = (s) => s.replace(/[^\n]/g, ' ');

// A script with its comments blanked (`code`) and, in `bare`, its string contents blanked
// too - line breaks kept in both, so every offset and line number found in either is the
// one the reviewer's Read shows, and a `'{'` inside a literal cannot derail brace
// matching. Regex literals are not recognised: a quote inside one can misplace the rest of
// that line, which costs a fact, never a wrong line number elsewhere.
function scanScript(text) {
  const src = String(text);
  const n = src.length;
  const code = [];
  const bare = [];
  const strings = [];
  let plain = 0;
  let i = 0;
  const flush = (to) => {
    if (to > plain) {
      const chunk = src.slice(plain, to);
      code.push(chunk);
      bare.push(chunk);
    }
  };
  while (i < n) {
    const ch = src[i];
    if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      flush(i);
      let stop;
      if (src[i + 1] === '/') {
        const end = src.indexOf('\n', i);
        stop = end < 0 ? n : end;
      } else {
        const end = src.indexOf('*/', i + 2);
        stop = end < 0 ? n : end + 2;
      }
      const chunk = blank(src.slice(i, stop));
      code.push(chunk);
      bare.push(chunk);
      i = plain = stop;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      flush(i);
      const stop = skipString(src, i);
      const literal = src.slice(i, stop);
      const closed = stop - i >= 2 && src[stop - 1] === ch;
      const inner = closed ? literal.slice(1, -1) : literal.slice(1);
      code.push(literal);
      bare.push(ch + blank(inner) + (closed ? ch : ''));
      strings.push({
        value: inner.replace(/\\(["'`\\])/g, '$1'),
        start: i,
        end: stop,
        quote: ch,
        interpolated: ch === '`' && inner.includes('${'),
      });
      i = plain = stop;
      continue;
    }
    i++;
  }
  flush(n);
  return { text: src, code: code.join(''), bare: bare.join(''), strings, starts: lineStarts(src) };
}

function scanTemplate(text) {
  const src = String(text);
  return { text: src, code: src.replace(/<!--[\s\S]*?-->/g, blank), bare: null, strings: [], starts: lineStarts(src) };
}

function scanFile(p, text) {
  if (reScript.test(p)) return scanScript(text);
  if (reTemplate.test(p)) return scanTemplate(text);
  return { text: String(text), code: String(text), bare: null, strings: [], starts: lineStarts(String(text)) };
}

// The index of the bracket closing the one at `open`, counting only that bracket kind.
function matchBracket(text, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const opening = text[open];
  const closing = pairs[opening];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === opening) depth++;
    else if (c === closing && --depth === 0) return i;
  }
  return -1;
}

// Top-level pieces of `text` split at `separators`, with their offsets: the members of an
// interface body, the properties of an object literal, the arguments of a call.
function splitTopLevel(text, separators) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
    else if ((c === '}' || c === ')' || c === ']' || (c === '>' && text[i - 1] !== '=')) && depth > 0) depth--;
    else if (depth === 0 && separators.includes(c)) {
      parts.push({ text: text.slice(start, i), at: start });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), at: start });
  return parts.filter((part) => part.text.trim() !== '');
}

// ---------------------------------------------------------------------------------------
// JSON with positions: translation files are read for their keys, each with the line the
// reviewer sees. Parsing goes on past a trailing comma, so one stray comma does not hide
// every key after it; any other syntax error ends it with the keys read so far.
function parseJsonKeys(text) {
  const src = String(text);
  const starts = lineStarts(src);
  const entries = [];
  const objects = [];
  const stop = {};
  let i = 0;
  const line = (at) => lineAt(starts, at);
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const fail = () => {
    throw stop;
  };
  const str = () => {
    const begin = i;
    let j = i + 1;
    let out = '';
    while (j < src.length && src[j] !== '"' && src[j] !== '\n') {
      if (src[j] === '\\') {
        out += src[j + 1] === 'n' ? '\n' : src[j + 1];
        j += 2;
      } else {
        out += src[j++];
      }
    }
    if (src[j] !== '"') fail();
    i = j + 1;
    return { value: out, at: begin };
  };
  const value = (prefix) => {
    ws();
    const c = src[i];
    if (c === '{') return object(prefix);
    if (c === '[') return array(prefix);
    if (c === '"') return { kind: 'string', value: str().value };
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i, i + 64));
    if (!m) fail();
    i += m[0].length;
    return { kind: 'scalar' };
  };
  const array = (prefix) => {
    i++;
    ws();
    if (src[i] === ']') {
      i++;
      return { kind: 'array' };
    }
    for (let index = 0; ; index++) {
      value(`${prefix}[${index}]`);
      ws();
      if (src[i] === ',') {
        i++;
        ws();
        if (src[i] !== ']') continue;
      }
      if (src[i] === ']') {
        i++;
        return { kind: 'array' };
      }
      fail();
    }
  };
  const object = (prefix) => {
    const open = i++;
    if (prefix) objects.push({ key: prefix, line: line(open) });
    ws();
    if (src[i] === '}') {
      i++;
      return { kind: 'object' };
    }
    for (;;) {
      ws();
      if (src[i] !== '"') fail();
      const k = str();
      const key = prefix ? `${prefix}.${k.value}` : k.value;
      const at = line(k.at);
      ws();
      if (src[i] !== ':') fail();
      i++;
      const v = value(key);
      if (v.kind === 'string') entries.push({ key, value: v.value, line: at });
      ws();
      if (src[i] === ',') {
        i++;
        ws();
        if (src[i] !== '}') continue;
      }
      if (src[i] === '}') {
        i++;
        return { kind: 'object' };
      }
      fail();
    }
  };
  try {
    value('');
  } catch (err) {
    if (err !== stop) throw err;
  }
  return { entries, objects };
}

// tsconfig is JSON with comments and trailing commas.
function parseJsonc(text) {
  try {
    return JSON.parse(scanScript(text).code.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Module graph

const reImportFrom = /\bimport\s+(type\s+)?([\w$]+\s*,\s*\{[^}]*\}|[\w$]+\s*,\s*\*\s*as\s+[\w$]+|\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+)\s*from\s*(['"])([^'"\n]+)\3/g;
const reImportBare = /\bimport\s*(['"])([^'"\n]+)\1/g;
const reExportFrom = /\bexport\s+(?:type\s+)?(\*(?:\s*as\s+([\w$]+))?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\3/g;
const reDynamicImport = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const reRequire = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const reExportDecl = /^[ \t]*export\s+(?:declare\s+)?(default\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|const\s+enum|function\s*\*?|const|let|var|namespace)\s+([\w$]+)/gm;
const reExportDefaultExpr = /^[ \t]*export\s+default\s+(?!(?:abstract\s+)?(?:class|interface|function|async)\b)/gm;
const reExportList = /^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm;

function parseSpecifierList(list) {
  return list.split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean).map((s) => {
    const [imported, local] = s.split(/\s+as\s+/);
    return { imported: imported.trim(), local: (local || imported).trim() };
  });
}

function parseImportClause(clause) {
  const out = { names: [], namespace: null, defaultName: null };
  let rest = clause.trim();
  if (!rest.startsWith('{') && !rest.startsWith('*')) {
    const def = rest.match(/^([\w$]+)\s*,?\s*/);
    out.defaultName = def[1];
    rest = rest.slice(def[0].length);
  }
  const ns = rest.match(/^\*\s*as\s+([\w$]+)/);
  if (ns) out.namespace = ns[1];
  const named = rest.match(/^\{([^}]*)\}/);
  if (named) out.names = parseSpecifierList(named[1]);
  return out;
}

function parseModule(scan) {
  const { code, starts } = scan;
  const at = (index) => lineAt(starts, index);
  const imports = [];
  const reexports = [];
  const exports = [];
  for (const m of code.matchAll(reImportFrom)) {
    imports.push({ spec: m[4], line: at(m.index), ...parseImportClause(m[2]) });
  }
  for (const m of code.matchAll(reImportBare)) imports.push({ spec: m[2], line: at(m.index), sideEffect: true, names: [] });
  for (const m of code.matchAll(reDynamicImport)) {
    // `import('./x').then((m) => m.Name)` consumes Name; any other use of the module, all of it.
    const member = code.slice(m.index + m[0].length, m.index + m[0].length + 200)
      .match(/^\s*\.then\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\1\.([\w$]+)/);
    imports.push({ spec: m[2], line: at(m.index), dynamic: true, names: member ? [{ imported: member[2], local: member[2] }] : [], all: !member });
  }
  for (const m of code.matchAll(reRequire)) imports.push({ spec: m[2], line: at(m.index), all: true, names: [] });
  for (const m of code.matchAll(reExportFrom)) {
    const star = m[1].startsWith('*');
    reexports.push({
      spec: m[4],
      line: at(m.index),
      star: star && !m[2],
      namespace: star ? m[2] || null : null,
      names: star ? [] : parseSpecifierList(m[1].slice(1, -1)),
    });
  }
  for (const m of code.matchAll(reExportDecl)) {
    const kind = m[2].replace(/\s+/g, ' ').replace(/\s*\*$/, '');
    exports.push({ name: m[1] ? 'default' : m[3], local: m[3], line: at(m.index + m[0].length - m[3].length), kind });
  }
  for (const m of code.matchAll(reExportDefaultExpr)) exports.push({ name: 'default', local: null, line: at(m.index), kind: 'default' });
  for (const m of code.matchAll(reExportList)) {
    if (/^\s*from\b/.test(code.slice(m.index + m[0].length))) continue;
    for (const s of parseSpecifierList(m[1])) exports.push({ name: s.local, local: s.imported, line: at(m.index), kind: 'list' });
  }
  const isBarrel = reexports.length > 0 && exports.length === 0
    && code.replace(reExportFrom, '').replace(/[\s;]/g, '') === '';
  return { imports, reexports, exports, isBarrel };
}

function loadTsconfig(files, root) {
  const dirOf = (p) => path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p);
  const join = (dir, rel) => path.posix.normalize(dir ? `${dir}/${rel}` : rel).replace(/\/$/, '').replace(/^\.$/, '');
  let current = [root ? `${root}/tsconfig.json` : 'tsconfig.json', root ? `${root}/tsconfig.base.json` : 'tsconfig.base.json']
    .find((p) => files.has(p));
  const chain = [];
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const cfg = parseJsonc(files.get(current));
    if (!cfg) break;
    chain.unshift({ at: current, cfg });
    const ext = cfg.extends;
    current = typeof ext === 'string' && ext.startsWith('.')
      ? [join(dirOf(current), ext), join(dirOf(current), `${ext}.json`)].find((p) => files.has(p))
      : null;
  }
  let baseUrl = null;
  let paths = null;
  let pathsBase = null;
  for (const { at, cfg } of chain) {
    const options = cfg.compilerOptions || {};
    if (typeof options.baseUrl === 'string') baseUrl = join(dirOf(at), options.baseUrl);
    if (options.paths && typeof options.paths === 'object') {
      paths = options.paths;
      pathsBase = baseUrl !== null ? baseUrl : dirOf(at);
    }
  }
  const aliases = Object.entries(paths || {}).map(([pattern, targets]) => {
    const star = pattern.indexOf('*');
    return {
      prefix: star < 0 ? pattern : pattern.slice(0, star),
      suffix: star < 0 ? '' : pattern.slice(star + 1),
      wildcard: star >= 0,
      targets: (Array.isArray(targets) ? targets : []).map((t) => join(pathsBase || '', t)),
    };
  });
  return { baseUrl, aliases, hasPaths: aliases.length > 0 };
}

function makeResolver(files, tsconfig) {
  const tryBase = (base) => {
    for (const ext of resolveExtensions) if (files.has(base + ext)) return base + ext;
    return null;
  };
  return (from, spec) => {
    if (spec.startsWith('.')) {
      const dir = path.posix.dirname(from);
      return tryBase(path.posix.normalize(dir === '.' ? spec : `${dir}/${spec}`));
    }
    for (const alias of tsconfig.aliases) {
      if (alias.wildcard) {
        if (!spec.startsWith(alias.prefix) || !spec.endsWith(alias.suffix) || spec.length < alias.prefix.length + alias.suffix.length) continue;
        const middle = spec.slice(alias.prefix.length, spec.length - alias.suffix.length);
        for (const target of alias.targets) {
          const hit = tryBase(target.replace('*', middle));
          if (hit) return hit;
        }
      } else if (spec === alias.prefix) {
        for (const target of alias.targets) {
          const hit = tryBase(target);
          if (hit) return hit;
        }
      }
    }
    if (tsconfig.baseUrl !== null) return tryBase(path.posix.normalize(tsconfig.baseUrl ? `${tsconfig.baseUrl}/${spec}` : spec));
    return null;
  };
}

// Who consumes each export, through however many barrels it travels: an import of a name
// from a barrel counts for the module that declares it, and a barrel alone consumes nothing.
function buildGraph(index) {
  const { modules, resolve } = index;
  for (const [p, mod] of modules) {
    for (const edge of mod.imports) edge.target = resolve(p, edge.spec);
    for (const edge of mod.reexports) edge.target = resolve(p, edge.spec);
  }
  const originsOf = (p, name, seen = new Set()) => {
    const key = `${p}\0${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const mod = modules.get(p);
    if (!mod) return [];
    if (mod.exports.some((e) => e.name === name)) return [{ path: p, name }];
    const found = [];
    for (const edge of mod.reexports) {
      if (!edge.target) continue;
      if (edge.namespace === name) found.push(...allNames(edge.target).flatMap((n) => originsOf(edge.target, n, seen)));
      for (const s of edge.names) if (s.local === name) found.push(...originsOf(edge.target, s.imported, seen));
      if (edge.star && name !== 'default') found.push(...originsOf(edge.target, name, seen));
    }
    return found;
  };
  const allNames = (p, seen = new Set()) => {
    if (seen.has(p)) return [];
    seen.add(p);
    const mod = modules.get(p);
    if (!mod) return [];
    const names = new Set(mod.exports.map((e) => e.name));
    for (const edge of mod.reexports) {
      for (const s of edge.names) names.add(s.local);
      if (edge.namespace) names.add(edge.namespace);
      if (edge.star && edge.target) for (const n of allNames(edge.target, seen)) if (n !== 'default') names.add(n);
    }
    return [...names];
  };
  const consumers = new Map();
  const note = (origin, importer) => {
    const key = `${origin.path}\0${origin.name}`;
    if (!consumers.has(key)) consumers.set(key, new Set());
    consumers.get(key).add(importer);
  };
  const moduleImporters = new Map();
  for (const [p, mod] of modules) {
    for (const edge of mod.imports) {
      if (!edge.target || edge.target === p) continue;
      if (!moduleImporters.has(edge.target)) moduleImporters.set(edge.target, new Set());
      moduleImporters.get(edge.target).add(p);
      const wanted = edge.namespace || edge.all ? allNames(edge.target) : [
        ...edge.names.map((s) => s.imported),
        ...(edge.defaultName ? ['default'] : []),
      ];
      for (const name of wanted) for (const origin of originsOf(edge.target, name)) note(origin, p);
    }
  }
  index.originsOf = (p, name) => originsOf(p, name);
  index.consumersOf = (p, name) => [...(consumers.get(`${p}\0${name}`) || [])].sort();
  index.importersOfModule = (p) => [...(moduleImporters.get(p) || [])].sort();
}

// ---------------------------------------------------------------------------------------
// The index every detector reads

function buildIndex(files, root) {
  const tsconfig = loadTsconfig(files, root);
  const scans = new Map();
  const modules = new Map();
  for (const [p, text] of files) {
    if (!isFactSource(p) || /\.snap$/.test(p)) continue;
    const scan = scanFile(p, text);
    scans.set(p, scan);
    if (reScript.test(p)) modules.set(p, parseModule(scan));
  }
  const index = { files, root, tsconfig, scans, modules, resolve: makeResolver(files, tsconfig) };
  buildGraph(index);
  index.sourceScripts = [...modules.keys()].filter((p) => !reSpec.test(p) && !reDeclaration.test(p));
  index.templates = [...scans.keys()].filter((p) => reTemplate.test(p));
  return index;
}

// An area may sit any number of folders deep (`src/app/admin/orders/...`): it is every
// folder above the first one of the canonical layout, or the whole folder path of a file
// outside that layout. `rest` is what is left below the area - empty for a file lying
// directly in it.
const reLayoutSegment = /^(?:data-access|models|shared|shell|components-.+)$/;
function areaSplit(p) {
  const m = p.match(/(?:^|\/)src\/app\/(.+)$/);
  if (!m) return null;
  const dirs = m[1].split('/').slice(0, -1);
  if (dirs.length === 0) return null;
  const layout = dirs.findIndex((d) => reLayoutSegment.test(d));
  const cut = layout === -1 ? dirs.length : Math.max(layout, 1);
  return { area: dirs.slice(0, cut).join('/'), rest: dirs.slice(cut) };
}

const areaOf = (p) => {
  const split = areaSplit(p);
  return split ? split.area : null;
};

const short = (p, root) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
const list = (items, limit = 8) => (items.length > limit ? `${items.slice(0, limit).join(', ')} (+${items.length - limit})` : items.join(', '));

// ---------------------------------------------------------------------------------------
// Detectors. Each calls `add(path, kind, lines, text)` for the files it finds something in,
// and `cross(text)` for what the cross-file pass should see in one place.

function routeIdentifiers(index) {
  const names = new Set();
  const re = /\b(?:canActivate|canMatch|canActivateChild|canDeactivate|canLoad)\s*:\s*\[([^\]]*)\]|\bresolve\s*:\s*\{([^}]*)\}/g;
  for (const p of index.sourceScripts) {
    for (const m of index.scans.get(p).code.matchAll(re)) {
      for (const id of (m[1] || m[2]).match(/[A-Za-z_$][\w$]*/g) || []) names.add(id);
    }
  }
  return names;
}

function inlineTemplates(index) {
  const out = [];
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    for (const s of scan.strings) {
      if (s.quote !== '`' && s.quote !== '\'') continue;
      if (/\btemplate\s*:\s*$/.test(scan.code.slice(Math.max(0, s.start - 40), s.start))) out.push({ path: p, text: s.value });
    }
  }
  for (const p of index.templates) out.push({ path: p, text: index.scans.get(p).code });
  return out;
}

function exportFacts(index, add, cross) {
  const routed = routeIdentifiers(index);
  const templates = inlineTemplates(index);
  const exportsByFile = new Map();
  const unused = [];
  for (const p of index.sourceScripts) {
    const mod = index.modules.get(p);
    const scan = index.scans.get(p);
    if (mod.isBarrel) {
      const importers = index.importersOfModule(p);
      const production = importers.filter((q) => !reSpec.test(q));
      if (production.length === 0) {
        const tests = importers.length > 0 ? ` (importują go tylko testy: ${list(importers.map((q) => short(q, index.root)))})` : '';
        add(p, 'barrel-unused', [1], `żaden plik nie importuje przez ten barrel${tests} - każdy konsument sięga do konkretnych plików albo nie ma konsumenta.`);
        unused.push(`${short(p, index.root)} (barrel)`);
      }
      exportsByFile.set(p, []);
      continue;
    }
    const pipe = scan.code.match(/@Pipe\s*\(\s*\{[\s\S]*?\bname\s*:\s*(['"])([^'"]+)\1/);
    const rows = [];
    for (const e of mod.exports) {
      const importers = index.consumersOf(p, e.name);
      const production = importers.filter((q) => !reSpec.test(q));
      const tests = importers.filter((q) => reSpec.test(q));
      const own = e.local ? ((scan.bare || scan.code).match(new RegExp(`(?<![\\w$.])${e.local.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) || []).length > 1 : false;
      rows.push({ name: e.name === 'default' && e.local ? `default (${e.local})` : e.name, line: e.line, importers: production, tests, own });
      if (reEntryFile.test(p)) continue;
      const shown = (qs) => list(qs.map((q) => short(q, index.root)));
      const testNote = tests.length > 0 ? ` Importują go tylko testy: ${shown(tests)}.` : '';
      const isGuard = /\.guard\.[cm]?[jt]s$/.test(p) || /Guard$|guard$/.test(e.name)
        || new RegExp(`\\b${e.local || e.name}\\s*:\\s*(?:Can(?:Activate|Match|ActivateChild|Deactivate|Load)Fn|ResolveFn)`).test(scan.code);
      if (isGuard && e.kind !== 'interface' && e.kind !== 'type') {
        if (!routed.has(e.local || e.name)) {
          add(p, 'guard-without-route', [e.line], `strażnik ${e.name} (L${e.line}) nie występuje w żadnej trasie repozytorium (canActivate/canMatch/canActivateChild/canDeactivate/resolve).${production.length > 0 ? ` Importuje go: ${shown(production)}.` : ''}${testNote}`);
          unused.push(`${short(p, index.root)}:${e.line} ${e.name} (strażnik bez trasy)`);
        }
        continue;
      }
      if (pipe && e.kind === 'class') {
        const users = templates.filter((t) => new RegExp(`(?<!\\|)\\|\\s*${pipe[2].replace(/[.$]/g, '\\$&')}\\b`).test(t.text));
        const where = [...new Set(users.map((t) => short(t.path, index.root)))];
        if (where.length === 0) {
          add(p, 'pipe-unused', [e.line], `pipe "${pipe[2]}" (${e.name}, L${e.line}) nie występuje w żadnym szablonie.`);
          unused.push(`${short(p, index.root)}:${e.line} pipe ${pipe[2]} (bez użycia w szablonach)`);
        } else if (where.length === 1) {
          add(p, 'pipe-single-template', [e.line], `pipe "${pipe[2]}" (${e.name}, L${e.line}) używa tylko jeden szablon: ${where[0]}.`);
        }
        continue;
      }
      // The bootstrap config is main.ts's to consume; whether it does is main.ts's finding.
      if (new RegExp(`\\b${(e.local || e.name).replace(/\$/g, '\\$')}\\s*:\\s*ApplicationConfig\\b`).test(scan.code)) continue;
      if (production.length === 0) {
        const usage = own ? 'używany tylko w tym pliku' : 'nieużywany nawet w tym pliku';
        // Dead code is certain; a surplus `export` on a name the file uses may be deliberate.
        add(p, 'export-unused', [e.line], `eksport ${e.name} (L${e.line}) nie ma konsumenta w repozytorium - ${usage}.${testNote}`, { hint: own });
        unused.push(`${short(p, index.root)}:${e.line} ${e.name}`);
      } else if (production.length === 1 && e.kind !== 'default') {
        add(p, 'export-single-importer', [e.line], `eksport ${e.name} (L${e.line}) importuje tylko jeden plik: ${shown(production)}.${own ? ' Używany też w tym pliku.' : ''}`);
      }
    }
    exportsByFile.set(p, rows);
  }
  if (unused.length > 0) cross(`Eksporty bez konsumenta: ${list(unused, 20)}`);
  return exportsByFile;
}

// ---------------------------------------------------------------------------------------
// Context for the walk, not facts: what a reviewer otherwise looks up with one search each.
// Measured on the runs of 2026-09-28..10-01, who uses a member took 9-14 requests a run and
// which spec covers a file 4-6. Both lists are what such a search returns - a whole-word match
// over the revision - so they are exactly as precise as the search they replace, noise included.

// A member line at the top level of a class body: decorators, modifiers, `get`/`set`, the name.
const reMember = /^[ \t]*(?:@[\w.]+(?![\w.])(?:\([^)]*\))?\s*)*((?:(?:public|private|protected|readonly|static|override|async|abstract|declare|accessor)\s+)*)(?:(get|set)\s+)?(#?[A-Za-z_$][\w$]*)\s*(?:[?!]?\s*[:=(<;]|$)/;

// Members nothing in the repository names because the framework calls them: lifecycle hooks,
// the methods of the interfaces Angular invokes, host listeners and NgRx effects. "Named
// nowhere" would read as dead code for them.
const frameworkMethods = new Set([
  'transform', 'handleError', 'intercept', 'canActivate', 'canActivateChild', 'canDeactivate', 'canMatch', 'canLoad',
  'resolve', 'validate', 'writeValue', 'registerOnChange', 'registerOnTouched', 'setDisabledState',
]);
const isFrameworkMember = (name, decorators, line) => /^ng[A-Z]/.test(name) || frameworkMethods.has(name)
  || decorators.some((d) => d === 'HostListener' || d === 'HostBinding') || /=\s*createEffect\s*\(/.test(line);

// The public members of every class the script exports: [{ cls, name, line, framework }].
function exportedMembers(scan, mod) {
  const exported = new Set(mod.exports.map((e) => e.local || e.name));
  const src = scan.bare || scan.code;
  const out = [];
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g)) {
    if (!exported.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src, open);
    if (close < 0) continue;
    const seen = new Set();
    let depth = 0;
    let offset = open + 1;
    // Decorators standing on lines of their own, waiting for the member they decorate.
    let pending = [];
    for (const line of src.slice(open + 1, close).split('\n')) {
      const d = depth === 0 ? reMember.exec(line) : null;
      if (d && d[3] !== 'constructor' && !d[3].startsWith('#') && !/\b(?:private|protected)\b/.test(d[1]) && !seen.has(d[3])) {
        seen.add(d[3]);
        const decorators = [...pending, ...[...line.matchAll(/@([\w.]+)/g)].map((x) => x[1])];
        out.push({ cls: m[1], name: d[3], line: lineAt(scan.starts, offset + d[0].lastIndexOf(d[3])), framework: isFrameworkMember(d[3], decorators, line) });
      }
      if (depth === 0) {
        const decorator = d ? null : line.match(/^\s*@([\w.]+)/);
        if (decorator) pending.push(decorator[1]);
        else if (line.trim()) pending = [];
      }
      for (const ch of line) {
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
      }
      offset += line.length + 1;
    }
  }
  return out;
}

// Per reviewed script: each public member of its exported classes, and where its name falls
// among the only places that can reach it - the file itself (an inline template included), its
// template, the files importing the class and their templates (a parent binds `[input]` and
// `(output)` there). A same-named member of another class is not counted.
function memberFacts(index, reviewed) {
  const templateOf = (p) => {
    const html = p.replace(/\.[cm]?[jt]s$/, '.html');
    return html !== p && index.scans.has(html) ? html : null;
  };
  const out = new Map();
  for (const p of index.sourceScripts) {
    if (!reviewed.has(p)) continue;
    const scan = index.scans.get(p);
    const members = exportedMembers(scan, index.modules.get(p));
    if (members.length === 0) continue;
    const own = templateOf(p);
    const reach = new Map();
    out.set(p, members.map((member) => {
      if (!reach.has(member.cls)) {
        const importers = index.consumersOf(p, member.cls);
        reach.set(member.cls, [...new Set([...importers, ...importers.map(templateOf).filter(Boolean)])]);
      }
      const re = new RegExp(`(?<![\\w$])${member.name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
      const named = (q) => (index.scans.get(q).code.match(re) || []).length;
      const where = reach.get(member.cls).filter((q) => named(q) > 0);
      return {
        ...member,
        inFile: named(p) > 1,
        template: own ? named(own) > 0 : null,
        files: where.filter((q) => !reSpec.test(q)),
        tests: where.filter((q) => reSpec.test(q)),
      };
    }));
  }
  return out;
}

// Per reviewed script: the specs that import it, each with its describe/it cases and their lines.
function specCases(index, reviewed) {
  const out = new Map();
  for (const p of index.sourceScripts) {
    if (!reviewed.has(p)) continue;
    out.set(p, index.importersOfModule(p).filter((q) => reSpec.test(q)).map((spec) => {
      const scan = index.scans.get(spec);
      const cases = [...scan.code.matchAll(/\b([fx]?(?:describe|it)|test)(?:\.(?:each|only|skip)\b[^(]*)?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g)]
        .map((m) => ({ kind: m[1], line: lineAt(scan.starts, m.index), title: m[3] }));
      return { path: spec, cases };
    }));
  }
  return out;
}

function localeFiles(index) {
  return [...index.files.keys()].filter((p) => /\.json$/.test(p) && reLocaleDir.test(p) && !/(?:^|\/)tests?\//.test(p)).sort();
}

// The file every other locale is held to: English, else the largest.
function localeBase(index, locales) {
  if (locales.length === 0) return null;
  return locales.find((p) => /(?:^|\/)en\.json$/.test(p)) || locales.find((p) => /(?:^|\/)en[-_][\w-]+\.json$/.test(p))
    || locales.slice().sort((a, b) => index.files.get(b).length - index.files.get(a).length)[0];
}

function i18nFacts(index, add, cross, { list: locales, base }) {
  if (!base) return;
  const parsed = new Map(locales.map((p) => [p, parseJsonKeys(index.files.get(p))]));
  const baseKeys = new Map(parsed.get(base).entries.map((e) => [e.key, e]));
  const requested = [];
  const literals = new Set();
  const prefixes = new Set();
  const reHtmlKey = /(['"])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1\s*\|\s*translate\b|\btranslate\s*=\s*"([A-Za-z][\w-]*(?:\.[\w-]+)+)"|\[translate\]\s*=\s*"'([A-Za-z][\w-]*(?:\.[\w-]+)+)'"/g;
  const reScriptKey = /\.(?:instant|get|stream|selectTranslate)\s*\(\s*(['"`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1|\b(?:translate|marker|_)\s*\(\s*(['"`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\3/g;
  const rePrefix = /(['"`])((?:[A-Za-z][\w-]*\.)+)\1\s*\+|`((?:[A-Za-z][\w-]*\.)+)\$\{/g;
  const sources = [...index.sourceScripts, ...index.templates];
  for (const p of sources) {
    const scan = index.scans.get(p);
    const at = (i) => lineAt(scan.starts, i);
    if (reTemplate.test(p)) {
      for (const m of scan.code.matchAll(reHtmlKey)) requested.push({ path: p, key: m[2] || m[3] || m[4], line: at(m.index) });
      for (const m of scan.code.matchAll(/(['"])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g)) literals.add(m[2]);
    } else {
      for (const m of scan.code.matchAll(reScriptKey)) requested.push({ path: p, key: m[2] || m[4], line: at(m.index) });
      for (const s of scan.strings) if (!s.interpolated) literals.add(s.value);
      // An inline template's keys count like a template file's.
      for (const s of scan.strings) {
        for (const m of s.value.matchAll(reHtmlKey)) requested.push({ path: p, key: m[2] || m[3] || m[4], line: at(s.start) });
        for (const m of s.value.matchAll(/(['"])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g)) literals.add(m[2]);
      }
    }
    for (const m of scan.code.matchAll(rePrefix)) prefixes.add(m[2] || m[3]);
  }
  const missing = requested.filter((r) => !baseKeys.has(r.key));
  const baseName = short(base, index.root);
  for (const r of missing) {
    add(r.path, 'i18n-missing-key', [r.line], `klucz "${r.key}" (L${r.line}) nie istnieje w ${baseName}.`);
  }
  if (missing.length > 0) {
    const byKey = new Map();
    for (const r of missing) byKey.set(r.key, [...(byKey.get(r.key) || []), `${short(r.path, index.root)}:${r.line}`]);
    const parentLine = (key) => {
      const parts = key.split('.');
      for (let n = parts.length - 1; n > 0; n--) {
        const parent = parsed.get(base).objects.find((o) => o.key === parts.slice(0, n).join('.'));
        if (parent) return parent.line;
      }
      return 1;
    };
    add(base, 'i18n-missing-key', [...byKey.keys()].map(parentLine), `klucze, o które prosi kod, a których tu nie ma: ${[...byKey].map(([k, at]) => `${k} (${list(at, 3)})`).join('; ')}.`);
    cross(`Brakujące klucze tłumaczeń w ${baseName}: ${[...byKey.keys()].join(', ')}`);
  }
  const used = (key) => literals.has(key) || [...prefixes].some((prefix) => key.startsWith(prefix));
  const unusedKeys = parsed.get(base).entries.filter((e) => !used(e.key));
  if (unusedKeys.length > 0) {
    add(base, 'i18n-unused-key', unusedKeys.map((e) => e.line), `klucze, których nie używa żaden plik: ${unusedKeys.map((e) => `${e.key} (L${e.line})`).join(', ')}.`);
    cross(`Nieużywane klucze ${baseName}: ${list(unusedKeys.map((e) => e.key), 20)}`);
  }
  const byValue = new Map();
  for (const e of parsed.get(base).entries) {
    const norm = e.value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (norm.length < 2) continue;
    byValue.set(norm, [...(byValue.get(norm) || []), e]);
  }
  const twins = [...byValue.values()].filter((group) => group.length > 1);
  if (twins.length > 0) {
    add(base, 'i18n-duplicate-value', twins.flat().map((e) => e.line), `ta sama fraza pod kilkoma kluczami: ${twins.map((group) => `"${group[0].value}" - ${group.map((e) => `${e.key} (L${e.line})`).join(', ')}`).join('; ')}.`);
  }
  for (const p of locales) {
    if (p === base) continue;
    const extra = parsed.get(p).entries.filter((e) => !baseKeys.has(e.key));
    if (extra.length > 0) {
      add(p, 'i18n-locale-extra-key', extra.map((e) => e.line), `klucze, których nie ma w pliku bazowym ${baseName}: ${extra.map((e) => `${e.key} (L${e.line})`).join(', ')}.`);
    }
  }
}

function crossAreaFacts(index, add, cross) {
  const found = [];
  for (const p of index.sourceScripts.concat([...index.modules.keys()].filter((q) => reSpec.test(q)))) {
    const from = areaOf(p);
    if (!from) continue;
    const mod = index.modules.get(p);
    for (const edge of [...mod.imports, ...mod.reexports]) {
      if (!edge.spec.startsWith('.') || !edge.target) continue;
      const to = areaOf(edge.target);
      if (!to || to === from) continue;
      add(p, 'cross-area-import', [edge.line], `import względny "${edge.spec}" (L${edge.line}) wychodzi z obszaru ${from} do obszaru ${to} (${short(edge.target, index.root)}); tsconfig ${index.tsconfig.hasPaths ? 'ma' : 'nie ma'} aliasów "paths".`);
      found.push(`${short(p, index.root)}:${edge.line} → ${to}`);
    }
  }
  if (found.length > 0) cross(`Importy względne między obszarami: ${list(found, 20)}`);
}

// A literal worth comparing across files: a word-bearing text, not an identifier-ish token
// every file repeats (`'id'`, `'email'`), a translation key or a module path.
function distinctive(value) {
  const v = value.trim();
  if (v.length < 5 || v.length > 200) return false;
  if ((v.match(/\p{L}/gu) || []).length < 3) return false;
  if (reKeyShaped.test(v) || /^[./@~]/.test(v) || /^[\w-]+\.(?:html|scss|css|ts|json)$/.test(v)) return false;
  return /\s/.test(v) || /\p{Lu}/u.test(v) || v.length >= 12;
}

const normLiteral = (v) => v.trim().toLowerCase().replace(/\s+/g, ' ');

// Skipped in front of a literal: an import path, Angular metadata and a pipe name repeat by design.
const reSkipBefore = /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\(|\b(?:selector|templateUrl|styleUrls?|styleUrl|providedIn|source)\s*:\s*\[?|@Pipe\s*\(\s*\{[^}]*\bname\s*:)\s*$/;

// A test title names a case (`it('shows the table')`); it is no value the test shares with the code.
const reTestTitleBefore = /\b(?:describe|it|test|xit|xtest|fit|xdescribe|fdescribe)(?:\.(?:only|skip|todo|concurrent))?\s*\(\s*$/;
// The title of a table-driven case (`it.each(rows)('renders %s', ...)`) is told by its placeholder.
const reEachPlaceholder = /%[sdifjoOp#]/;

// The literals of one script worth comparing: [{ norm, line, shown }]. `tests`: of a spec file.
function scriptLiterals(scan, { tests = false } = {}) {
  const out = [];
  for (const s of scan.strings) {
    if (s.interpolated || !distinctive(s.value)) continue;
    const before = scan.code.slice(Math.max(0, s.start - 80), s.start);
    if (reSkipBefore.test(before) || (tests && (reTestTitleBefore.test(before) || reEachPlaceholder.test(s.value)))) continue;
    // An object key (`'Load users': props()`) names, it does not repeat a value.
    if (/^\s*:/.test(scan.code.slice(s.end, s.end + 3)) && /[{,]\s*$/.test(before)) continue;
    out.push({ norm: normLiteral(s.value), line: lineAt(scan.starts, s.start), shown: s.value.trim() });
  }
  // Arrays of string literals (`['name', 'email', 'status']`) repeat as a whole.
  for (const m of scan.code.matchAll(/\[\s*(['"])[^'"\n]*\1(?:\s*,\s*(['"])[^'"\n]*\2)+\s*,?\s*\]/g)) {
    const values = [...m[0].matchAll(/(['"])([^'"\n]*)\1/g)].map((v) => v[2].trim().toLowerCase());
    out.push({ norm: `[${values.join(',')}]`, line: lineAt(scan.starts, m.index), shown: m[0].replace(/\s+/g, ' ') });
  }
  return out;
}

// Object keys whose value repeats by design: Angular metadata and route configuration.
const ignoredPairKeys = new Set([
  'selector', 'template', 'templateUrl', 'styles', 'styleUrl', 'styleUrls', 'providedIn', 'changeDetection', 'encapsulation',
  'path', 'component', 'loadComponent', 'loadChildren', 'pathMatch', 'redirectTo', 'outlet', 'type',
]);

// The `key: value` pairs of a script worth comparing - `pageSize: 10`, `firstName: 'Ann'`: one setting
// or fixture field written in several files: [{ norm, line, shown }]. Numbers of one digit, texts
// of under three characters or two letters, paths and translation keys are left out.
function scriptPairs(scan) {
  const bare = scan.bare || scan.code;
  const strings = new Map(scan.strings.map((s) => [s.start, s]));
  const out = [];
  for (const m of bare.matchAll(/(?<=[{,]\s*|^[ \t]*)([A-Za-z_$][\w$]*)[ \t]*:[ \t]*(?=['"`\d-])/gm)) {
    if (m[1].length < 3 || ignoredPairKeys.has(m[1])) continue;
    const at = m.index + m[0].length;
    const s = strings.get(at);
    let norm;
    let shown;
    let end;
    if (s) {
      const v = s.value.trim();
      if (s.interpolated || v.length < 3 || (v.match(/\p{L}/gu) || []).length < 2 || reKeyShaped.test(v) || /^[./@~]/.test(v)) continue;
      norm = `${m[1]}: '${normLiteral(s.value)}'`;
      shown = `${m[1]}: '${v}'`;
      end = s.end;
    } else {
      const number = scan.code.slice(at, at + 24).match(/^-?\d+(?:\.\d+)?(?![\w.$])/);
      if (!number || number[0].replace(/\D/g, '').length < 2) continue;
      norm = shown = `${m[1]}: ${number[0]}`;
      end = at + number[0].length;
    }
    // A pair ends at a comma, a brace, a bracket or its line; `a ? b : 10 + c` does not.
    if (!/^[ \t]*(?:[,})\]]|;|\r?\n|$)/.test(scan.code.slice(end, end + 8))) continue;
    out.push({ norm, line: lineAt(scan.starts, m.index), shown });
  }
  return out;
}

// norm -> every place the given scripts hold the pair.
function pairOccurrences(index, paths) {
  const out = new Map();
  for (const p of paths) {
    for (const pair of scriptPairs(index.scans.get(p))) {
      if (!out.has(pair.norm)) out.set(pair.norm, []);
      out.get(pair.norm).push({ path: p, line: pair.line, shown: pair.shown });
    }
  }
  return out;
}

// norm -> every place the production sources (scripts, templates, the base translation file) hold the literal.
function literalOccurrences(index, locales) {
  const occurrences = new Map();
  const note = (norm, occurrence) => {
    if (!occurrences.has(norm)) occurrences.set(norm, []);
    occurrences.get(norm).push(occurrence);
  };
  for (const p of index.sourceScripts) {
    for (const l of scriptLiterals(index.scans.get(p))) note(l.norm, { path: p, line: l.line, shown: l.shown });
  }
  const reTextNode = />([^<>]+)</g;
  const reTextAttribute = /\s(?:title|placeholder|aria-label|alt|label)\s*=\s*"([^"{}]+)"/g;
  for (const p of index.templates) {
    const scan = index.scans.get(p);
    for (const m of scan.code.matchAll(reTextNode)) {
      const text = m[1].replace(/\{\{[\s\S]*?\}\}/g, ' ');
      if (!distinctive(text) || /[{}@]/.test(text)) continue;
      const offset = m.index + 1 + m[1].search(/\S/);
      note(normLiteral(text), { path: p, line: lineAt(scan.starts, offset), shown: text.trim().replace(/\s+/g, ' ') });
    }
    for (const m of scan.code.matchAll(reTextAttribute)) {
      if (!distinctive(m[1])) continue;
      note(normLiteral(m[1]), { path: p, line: lineAt(scan.starts, m.index), shown: m[1].trim() });
    }
  }
  if (locales.base) {
    for (const e of parseJsonKeys(index.files.get(locales.base)).entries) {
      if (!distinctive(e.value)) continue;
      note(normLiteral(e.value), { path: locales.base, line: e.line, shown: e.value, key: e.key });
    }
  }
  return occurrences;
}

function literalFacts(index, add, cross, occurrences, record) {
  const groups = [];
  for (const [, list_] of occurrences) {
    const files = new Set(list_.map((o) => o.path));
    for (const p of files) {
      const own = list_.filter((o) => o.path === p);
      record(p, 'literał', own.map((o) => o.line), own[0].shown.startsWith('[') ? own[0].shown : `"${own[0].shown}"`, files.size - 1);
    }
    if (files.size < 2 || list_.length < minCopies) continue;
    // Translations alone repeating each other are the i18n-duplicate-value fact's business.
    if (list_.every((o) => o.key)) continue;
    groups.push(list_);
  }
  for (const group of groups) {
    const where = (o) => `${short(o.path, index.root)}:${o.line}${o.key ? ` (${o.key})` : ''}`;
    // One word (`'Authorization'`, `'Active'`) may be a protocol name or a label that merely
    // coincides; a phrase or a whole array repeated is a copy.
    const hint = !/[\s,]/.test(normLiteral(group[0].shown));
    for (const p of new Set(group.map((o) => o.path))) {
      const own = group.filter((o) => o.path === p);
      const others = group.filter((o) => o.path !== p);
      add(p, 'repeated-literal', own.map((o) => o.line), `wartość "${own[0].shown}" (L${own.map((o) => o.line).join(', L')}) występuje też w: ${list(others.map(where), 6)}.`, { hint });
    }
    cross(`Powtórzona wartość "${group[0].shown}": ${list(group.map(where), 8)}`);
  }
}

function conditionFacts(index, add, cross, record) {
  const re = /([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+)\s*(===|!==|==|!=)\s*(-?\d+(?:\.\d+)?|'[^'\n]*'|"[^"\n]*")/g;
  const ignored = new Set(['length', 'size', 'key', 'code', 'keyCode', 'which', 'nodeType', 'readyState', 'type']);
  const found = new Map();
  for (const p of [...index.sourceScripts, ...index.templates]) {
    const scan = index.scans.get(p);
    for (const m of scan.code.matchAll(re)) {
      const member = m[1].split(/\??\./).pop();
      if (ignored.has(member)) continue;
      const key = `${member} ${m[2].replace(/^(==|!=)$/, '$1=')} ${m[3].replace(/"/g, '\'')}`;
      if (!found.has(key)) found.set(key, []);
      found.get(key).push({ path: p, line: lineAt(scan.starts, m.index), shown: m[0] });
    }
  }
  for (const [key, all] of found) {
    const files = new Set(all.map((o) => o.path));
    for (const p of files) {
      const own = all.filter((o) => o.path === p);
      record(p, 'warunek', own.map((o) => o.line), `\`${own[0].shown}\``, files.size - 1);
    }
    if (all.length < minCopies) continue;
    const where = (o) => `${short(o.path, index.root)}:${o.line}`;
    for (const p of new Set(all.map((o) => o.path))) {
      const own = all.filter((o) => o.path === p);
      const others = all.filter((o) => o !== own[0]);
      add(p, 'repeated-condition', own.map((o) => o.line), `warunek "${own[0].shown}" (L${own.map((o) => o.line).join(', L')}) powtarza się: ${list(others.map(where), 6)}.`);
    }
    cross(`Powtórzony warunek "${key}": ${list(all.map(where), 8)}`);
  }
}

// Function-like units of a script: every `{` whose header reads as a function or method
// head, and the arrow bodies written as `=> ({`. Each unit knows its name and span.
function functionUnits(scan) {
  const units = [];
  const bare = scan.bare || scan.code;
  const reserved = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else', 'try', 'with']);
  let boundary = 0;
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i];
    if (c === ';' || c === '}') {
      boundary = i + 1;
      continue;
    }
    if (c !== '{') continue;
    const header = bare.slice(boundary, i);
    boundary = i + 1;
    let name = null;
    let fn = false;
    const named = header.match(/\bfunction\s*\*?\s*([\w$]+)?\s*(?:<[^>]*>)?\s*\([^]*\)\s*(?::[^]*)?$/);
    const arrow = header.match(/(?:^|[^\w$.])([\w$]+)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:\([^]*\)|[\w$]+)\s*(?::[^=]*)?=>\s*\(?\s*$/);
    const method = header.match(/^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([\w$]+)\s*(?:<[^>]*>)?\s*\([^]*\)\s*(?::\s*[^{};=]+)?$/);
    if (named) {
      fn = true;
      name = named[1] || null;
    } else if (arrow) {
      fn = true;
      name = arrow[1];
    } else if (/=>\s*\(?\s*$/.test(header)) {
      fn = true;
    } else if (method && !reserved.has(method[1])) {
      fn = true;
      name = method[1];
    }
    if (!fn) continue;
    const end = matchBracket(bare, i);
    if (end < 0) continue;
    const headStart = boundary - 1 - header.length + header.search(/\S|$/);
    units.push({ name, start: i, end, line: lineAt(scan.starts, Math.max(0, headStart)) });
  }
  return units;
}

// Label mappings: units handing out two or more word-like literals (returned, assigned,
// picked by a ternary, concatenated). Two units sharing two labels implement one mapping.
function mappingFacts(index, add, cross, record) {
  const isLabel = (v) => (v.match(/\p{L}/gu) || []).length >= 3 && !/[./_#@$<>{}[\]\\|]/.test(v)
    && !(/-/.test(v) && !/\s/.test(v)) && (/\s/.test(v) || /^\s*\p{Lu}/u.test(v));
  const sites = [];
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    const units = functionUnits(scan);
    const labelsOf = new Map();
    for (const s of scan.strings) {
      if (s.interpolated || !isLabel(s.value)) continue;
      const before = scan.code.slice(Math.max(0, s.start - 30), s.start);
      if (!/(?:\breturn|[=?:+]|=>)\s*$/.test(before) || /(?:===|!==|==|!=|\bcase)\s*$/.test(before)) continue;
      if (/:\s*$/.test(before) && /^\s*:/.test(scan.code.slice(s.end, s.end + 3))) continue;
      const unit = units.filter((u) => u.start < s.start && s.start < u.end).sort((a, b) => b.start - a.start)[0];
      if (!unit) continue;
      if (!labelsOf.has(unit)) labelsOf.set(unit, new Map());
      labelsOf.get(unit).set(s.value.trim().toLowerCase(), s.value.trim());
    }
    for (const [unit, labels] of labelsOf) if (labels.size >= 2) sites.push({ path: p, unit, labels });
  }
  const parent = sites.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let a = 0; a < sites.length; a++) {
    for (let b = a + 1; b < sites.length; b++) {
      const shared = [...sites[a].labels.keys()].filter((k) => sites[b].labels.has(k));
      if (shared.length >= 2) parent[find(a)] = find(b);
    }
  }
  const clusters = new Map();
  sites.forEach((site, i) => clusters.set(find(i), [...(clusters.get(find(i)) || []), site]));
  const label = (site) => `${site.unit.name || 'funkcja anonimowa'} (${short(site.path, index.root)}:${site.unit.line})`;
  for (const cluster of clusters.values()) {
    for (const site of cluster) {
      const elsewhere = new Set(cluster.map((s) => s.path).filter((p) => p !== site.path));
      record(site.path, 'mapa etykiet', [site.unit.line], site.unit.name || 'funkcja anonimowa', elsewhere.size);
    }
    if (cluster.length < 2) continue;
    // A mapping also hides where this scan does not look (a record, a template `@switch`, a pipe
    // around it), so two copies found only point at a third - except in a pipe, which duplicates
    // a mapping written elsewhere from the second copy.
    const hint = (p) => cluster.length < minCopies && !rePipeFile.test(p);
    for (const site of cluster) {
      const others = cluster.filter((s) => s !== site).map(label);
      add(site.path, 'mapping-duplicate', [site.unit.line], `${site.unit.name || 'funkcja anonimowa'} (L${site.unit.line}) mapuje na etykiety ${[...site.labels.values()].map((v) => `"${v}"`).join(', ')}; te same etykiety zwraca też: ${others.join(', ')}.`, { hint: hint(site.path) });
    }
    cross(`Jedna mapa etykiet zaimplementowana ${cluster.length} razy: ${cluster.map(label).join(', ')}`);
    const named = cluster.filter((s) => s.unit.name);
    for (const p of index.sourceScripts) {
      const scan = index.scans.get(p);
      for (const site of named) {
        const lines = [];
        for (const m of (scan.bare || scan.code).matchAll(new RegExp(`(?<![\\w$])${site.unit.name.replace(/\$/g, '\\$')}\\s*\\(`, 'g'))) {
          if (p === site.path && m.index >= site.unit.start - 200 && m.index <= site.unit.end) continue;
          if (cluster.some((s) => s.path === p && m.index > s.unit.start && m.index < s.unit.end)) continue;
          lines.push(lineAt(scan.starts, m.index));
        }
        if (lines.length === 0 || cluster.some((s) => s.path === p && s.unit === site.unit)) continue;
        const others = cluster.filter((s) => s !== site).map(label);
        add(p, 'mapping-duplicate-caller', lines, `woła ${site.unit.name} (L${lines.join(', L')}), a tę samą mapę etykiet implementuje też: ${others.join(', ')}.`, { hint: hint(p) });
      }
    }
  }
}

// The interfaces of every script, with their members' lines: [{ name, path, line, fields }].
function interfaceList(index) {
  const out = [];
  for (const p of index.modules.keys()) {
    if (reSpec.test(p)) continue;
    const scan = index.scans.get(p);
    const bare = scan.bare || scan.code;
    for (const m of bare.matchAll(/\binterface\s+([\w$]+)(?:\s*<[^>{]*>)?(?:\s+extends\s+[^{]+)?\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(bare, open);
      if (close < 0) continue;
      const fields = new Map();
      for (const part of splitTopLevel(scan.code.slice(open + 1, close), [';', ',', '\n'])) {
        const member = part.text.match(/^\s*(?:readonly\s+)?(['"]?)([\w$]+)\1(\?)?\s*:\s*([\s\S]*)$/);
        if (!member) continue;
        fields.set(member[2], { optional: !!member[3], type: member[4].trim(), line: lineAt(scan.starts, open + 1 + part.at + part.text.search(/\S/)) });
      }
      out.push({ name: m[1], path: p, line: lineAt(scan.starts, m.index), fields });
    }
  }
  return out;
}

// The same by name: of two interfaces sharing one, the later one stays.
function interfaces(index) {
  return new Map(interfaceList(index).map((item) => [item.name, { path: item.path, line: item.line, fields: item.fields }]));
}

function stateFacts(index, add) {
  const types = interfaces(index);
  const states = new Map([...types].filter(([name]) => /State$/.test(name)));
  if (states.size === 0) return;
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    const bare = scan.bare || scan.code;
    for (const m of bare.matchAll(/\bconst\s+([\w$]+)\s*(?::\s*([\w$]+))?\s*=\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(bare, open);
      if (close < 0) continue;
      const cast = bare.slice(close + 1, close + 80).match(/^\s*as\s+([\w$]+)/);
      const typeName = m[2] || (cast && cast[1]);
      if (!typeName || !states.has(typeName)) continue;
      const state = states.get(typeName);
      const keys = new Map();
      let spread = false;
      for (const part of splitTopLevel(scan.code.slice(open + 1, close), [','])) {
        const text = part.text.trim();
        if (text.startsWith('...')) spread = true;
        const key = text.match(/^(['"]?)([\w$]+)\1\s*(?::|$)/);
        if (key) keys.set(key[2], lineAt(scan.starts, open + 1 + part.at + part.text.search(/\S/)));
      }
      const missing = spread ? [] : [...state.fields.keys()].filter((f) => !keys.has(f));
      const extra = [...keys.keys()].filter((k) => !state.fields.has(k));
      const byCast = !m[2] && cast;
      if (missing.length === 0 && extra.length === 0 && !byCast) continue;
      const line = lineAt(scan.starts, m.index);
      const parts = [];
      if (missing.length > 0) parts.push(`brakuje pól interfejsu: ${missing.join(', ')}`);
      if (extra.length > 0) parts.push(`pola spoza interfejsu: ${extra.map((k) => `${k} (L${keys.get(k)})`).join(', ')}`);
      if (byCast) parts.push(`typ nadany przez "as ${typeName}", więc kompilator nie sprawdza kompletności`);
      add(p, 'initial-state-gap', [line, ...extra.map((k) => keys.get(k))], `stan ${m[1]} (L${line}) względem ${typeName} (${short(state.path, index.root)}:${state.line}): ${parts.join('; ')}.`);
    }
    if (!/\bcreateReducer\s*\(/.test(scan.code)) continue;
    const nullable = new Map();
    for (const [name, state] of states) {
      if (!new RegExp(`\\b${name}\\b`).test(scan.code)) continue;
      for (const [field, info] of state.fields) if (/\[\]|Array</.test(info.type) && /\bnull\b/.test(info.type)) nullable.set(field, `${name}.${field}: ${info.type}`);
    }
    for (const m of scan.code.matchAll(/(?<![\w$.])([\w$]+)\s*:\s*\[\s*\]/g)) {
      if (!nullable.has(m[1])) continue;
      const line = lineAt(scan.starts, m.index);
      add(p, 'reducer-empty-instead-of-null', [line], `${m[1]}: [] (L${line}), a stan modeluje to pole jako ${nullable.get(m[1])} - "brak" to null.`);
    }
  }
}

const eventWords = (key) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase().split(/\s+/);
const actionName = (key) => eventWords(key).map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('');

function actionFacts(index, add) {
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    const bare = scan.bare || scan.code;
    // createActionGroup: a 'X success' needs its 'X fail' and the other way round.
    for (const m of bare.matchAll(/\bcreateActionGroup\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(bare, open);
      if (close < 0) continue;
      const events = [...scan.code.slice(open, close).matchAll(/^\s*(['"])([^'"\n]+)\1\s*:/gm)]
        .map((e) => ({ key: e[2], words: eventWords(e[2]).join(' '), line: lineAt(scan.starts, open + e.index + e[0].search(/['"]/)) }));
      const has = new Set(events.map((e) => e.words));
      for (const e of events) {
        const outcome = e.words.match(/^(.*) (success|fail)$/);
        if (!outcome) continue;
        const partner = `${outcome[1]} ${outcome[2] === 'success' ? 'fail' : 'success'}`;
        if (has.has(partner)) continue;
        add(p, 'action-trio-incomplete', [e.line], `zdarzenie '${e.key}' (L${e.line}) nie ma pary '${partner}'${has.has(outcome[1]) ? '' : ` ani zdarzenia '${outcome[1]}'`} - trio operacji jest niepełne.`);
      }
    }
    if (!/\bcreateReducer\s*\(/.test(scan.code)) continue;
    const handlers = [];
    for (const m of bare.matchAll(/(?<![\w$.])on\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(bare, open);
      if (close < 0) continue;
      const args = splitTopLevel(scan.code.slice(open + 1, close), [',']);
      const refs = [];
      let body = '';
      for (const arg of args) {
        const text = arg.text.trim();
        if (/^[\w$.]+$/.test(text)) refs.push(text.split('.').pop());
        else {
          body = scan.code.slice(open + 1 + arg.at, close);
          break;
        }
      }
      handlers.push({ refs, body, line: lineAt(scan.starts, m.index) });
    }
    const handled = new Set(handlers.flatMap((h) => h.refs));
    for (const h of handlers) {
      const flag = h.body.match(/\b([\w$]*[lL]oading[\w$]*)\b\s*[:=]\s*true\b/);
      if (!flag) continue;
      for (const ref of h.refs) {
        if (/(?:Success|Fail)$/.test(ref)) continue;
        const lacking = [`${ref}Fail`, `${ref}Success`].filter((a) => !handled.has(a));
        if (lacking.length === 0) continue;
        add(p, 'reducer-flag-without-fail', [h.line], `${ref} ustawia ${flag[1]} = true (L${h.line}), a żaden handler nie obsługuje ${lacking.join(' ani ')} - po ${lacking[0].endsWith('Fail') ? 'błędzie' : 'odpowiedzi'} flaga zostaje true.`);
      }
    }
  }
}

// The component a spec tests and the template a component renders: siblings by name, the
// spec possibly one `tests/` folder down.
function companion(index, p, fromSuffix, toSuffix) {
  if (!p.endsWith(fromSuffix)) return null;
  const base = p.slice(0, -fromSuffix.length);
  const candidates = [`${base}${toSuffix}`];
  const m = base.match(/^(.*)\/tests?\/([^/]+)$/);
  if (m) candidates.push(`${m[1]}/${m[2]}${toSuffix}`);
  return candidates.find((c) => index.files.has(c)) || null;
}

function specFacts(index, add) {
  for (const spec of [...index.modules.keys()].filter((p) => reSpec.test(p))) {
    const component = companion(index, spec, '.spec.ts', '.ts');
    if (!component || !/\.component\.ts$/.test(component)) continue;
    const specScan = index.scans.get(spec);
    const compScan = index.scans.get(component);
    if (!specScan || !compScan) continue;
    const c = compScan.code;
    const outputs = new Map();
    const note = (re) => {
      for (const m of c.matchAll(re)) outputs.set(m[1], lineAt(compScan.starts, m.index + m[0].indexOf(m[1])));
    };
    note(/^[ \t]*(?:(?:public|protected|readonly|override)\s+)*([\w$]+)\s*=\s*(?:output|outputFromObservable|model(?:\.required)?)\s*[<(]/gm);
    note(/^[ \t]*(?:(?:public|protected|readonly|override)\s+)*([\w$]+)\s*(?::[^=\n]+)?=\s*new\s+EventEmitter\b/gm);
    for (const m of c.matchAll(/@Output\(\s*(?:['"][^'"]*['"])?\s*\)\s*(?:(?:public|readonly)\s+)*([\w$]+)/g)) outputs.set(m[1], lineAt(compScan.starts, m.index));
    const s = specScan.code;
    const untested = [...outputs].filter(([name]) => !new RegExp(`\\.${name}\\b|['"]${name}['"]`).test(s));
    const describeAt = s.search(/\bdescribe\s*\(/);
    const specLine = describeAt < 0 ? 1 : lineAt(specScan.starts, describeAt);
    if (untested.length > 0) {
      add(spec, 'output-untested', [specLine], `wyjścia komponentu ${short(component, index.root)} bez żadnego odwołania w tym specu: ${untested.map(([name, line]) => `${name} (komponent L${line})`).join(', ')}.`);
    }
    // An `it` calling a method that dereferences an input with `!` while nothing set it.
    const inputs = new Set([...c.matchAll(/^[ \t]*(?:(?:public|protected|readonly|override)\s+)*([\w$]+)\s*=\s*input(?:\.required)?\s*[<(]/gm)].map((m) => m[1]));
    for (const m of c.matchAll(/@Input\(\s*(?:['"][^'"]*['"])?\s*\)\s*(?:(?:public|readonly)\s+)*([\w$]+)/g)) inputs.add(m[1]);
    if (inputs.size === 0) continue;
    const compBare = compScan.bare || c;
    const readers = new Map();
    for (const m of compBare.matchAll(/^[ \t]*(?:(?:public|protected|private|async|override)\s+)*([\w$]+)\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{/gm)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(compBare, open);
      if (close < 0) continue;
      for (const r of c.slice(open, close).matchAll(/\bthis\.([\w$]+)\(\)!/g)) {
        if (inputs.has(r[1])) readers.set(m[1], { input: r[1], line: lineAt(compScan.starts, open + r.index) });
      }
    }
    if (readers.size === 0) continue;
    const specBare = specScan.bare || s;
    const its = [];
    // `it.each(rows)(title, fn)` is a test as well: its body is the second call, never setup.
    for (const m of specBare.matchAll(/\b(?:it|test)\s*(\.\s*each\s*)?\(/g)) {
      let open = m.index + m[0].length - 1;
      if (m[1]) {
        const rows = matchBracket(specBare, open);
        const call = rows < 0 ? null : specBare.slice(rows + 1).match(/^\s*\(/);
        if (!call) continue;
        open = rows + call[0].length;
      }
      const close = matchBracket(specBare, open);
      if (close > 0) its.push({ start: m.index, open, end: close, line: lineAt(specScan.starts, m.index) });
    }
    let setup = s;
    for (const it of its.slice().reverse()) setup = setup.slice(0, it.start) + blank(setup.slice(it.start, it.end + 1)) + setup.slice(it.end + 1);
    const sets = (text, input) => new RegExp(`setInput\\(\\s*['"]${input}['"]|MockRender\\([^;]*\\{[^;]*\\b${input}\\s*:`).test(text);
    for (const it of its) {
      const body = s.slice(it.start, it.end + 1);
      for (const [method, read] of readers) {
        const call = body.search(new RegExp(`\\.${method}\\s*\\(`));
        if (call < 0) continue;
        if (sets(setup, read.input) || sets(body.slice(0, call), read.input)) continue;
        const title = s.slice(it.open, it.end + 1).match(/^\(\s*(['"`])(.*?)\1/);
        add(spec, 'spec-input-not-set', [it.line, lineAt(specScan.starts, it.start + call)], `it(${title ? `'${title[2]}'` : ''}) L${it.line} woła ${method}() (L${lineAt(specScan.starts, it.start + call)}), które czyta this.${read.input}()! (komponent L${read.line}), a spec nie ustawia wejścia ${read.input} przed tym wywołaniem - ani w tym it, ani w beforeAll/beforeEach.`);
      }
    }
  }
}

function snapshotFacts(index, add) {
  const snaps = [...index.files.keys()].filter((p) => /\.snap$/.test(p));
  for (const snap of snaps) {
    if (/\/tests\/__snapshots__\/[^/]+$/.test(snap)) continue;
    const dir = path.posix.dirname(snap);
    const stem = path.posix.basename(snap, '.snap');
    const owner = [`${dir}/${stem}`, `${dir}/${stem}.ts`, `${path.posix.dirname(dir)}/${stem}`, `${path.posix.dirname(dir)}/${stem}.ts`].find((p) => index.files.has(p) && reSpec.test(p));
    const text = `snapshot ${short(snap, index.root)} leży poza tests/__snapshots__/.`;
    add(snap, 'snapshot-outside-folder', [1], text);
    if (owner) add(owner, 'snapshot-outside-folder', [1], text);
  }
  for (const spec of [...index.modules.keys()].filter((p) => reSpec.test(p))) {
    const scan = index.scans.get(spec);
    const call = scan.code.search(/\.toMatch(?:File)?Snapshot\s*\(/);
    if (call < 0) continue;
    const dir = path.posix.dirname(spec);
    const expected = `${dir}/__snapshots__/${path.posix.basename(spec)}.snap`;
    if (index.files.has(expected) && /\/tests\/__snapshots__\//.test(expected)) continue;
    const line = lineAt(scan.starts, call);
    const reason = !/\/tests$/.test(dir) ? `spec nie leży w folderze tests/, więc snapshot trafi do ${short(expected, index.root)}` : `plik ${short(expected, index.root)} nie istnieje w recenzowanej wersji`;
    add(spec, 'snapshot-missing', [line], `spec porównuje ze snapshotem (L${line}), a ${reason}.`);
  }
  // A snapshot of a function's object result whose top-level fields no longer match the
  // fields the function returns.
  for (const spec of [...index.modules.keys()].filter((p) => reSpec.test(p))) {
    const scan = index.scans.get(spec);
    const snap = [`${path.posix.dirname(spec)}/__snapshots__/${path.posix.basename(spec)}.snap`, `${spec.replace(/\.[cm]?[jt]sx?$/, '')}.snap`, `${spec}.snap`].find((q) => index.files.has(q));
    if (!snap) continue;
    const stored = new Set([...String(index.files.get(snap)).matchAll(/^ {2}"([\w$]+)":/gm)].map((m) => m[1]));
    for (const m of scan.bare.matchAll(/\bexpect\s*\(\s*([\w$]+)\s*\(/g)) {
      const close = matchBracket(scan.bare, m.index + m[0].length - 1);
      if (close < 0 || !/^\s*\)\s*\.\s*toMatchSnapshot\s*\(/.test(scan.bare.slice(close + 1))) continue;
      const decl = declarationOf(index, spec, m[1]);
      const returned = decl && returnedFields(index, decl);
      if (!returned || stored.size === 0) continue;
      const added = returned.fields.filter((f) => !stored.has(f));
      const gone = [...stored].filter((f) => !returned.fields.includes(f));
      if (added.length === 0 && gone.length === 0) continue;
      const line = lineAt(scan.starts, m.index);
      const text = `${m[1]}() (${short(decl.path, index.root)} L${returned.line}) zwraca pola ${returned.fields.join(', ')}, a snapshot ${short(snap, index.root)} ma ${[...stored].join(', ')}${added.length > 0 ? ` - brak w nim ${added.join(', ')}` : ''}${gone.length > 0 ? ` - nadmiarowe ${gone.join(', ')}` : ''}; toMatchSnapshot (L${line}) nie przejdzie.`;
      add(spec, 'snapshot-field-drift', [line], text);
      add(decl.path, 'snapshot-field-drift', [returned.line], text);
    }
  }
}

// Where the binding `name` imported into `p` is declared: `{ path, local }`, or null.
function declarationOf(index, p, name) {
  const mod = index.modules.get(p);
  for (const edge of mod ? mod.imports : []) {
    if (!edge.target) continue;
    const s = edge.names.find((n) => n.local === name);
    const imported = s ? s.imported : edge.defaultName === name ? 'default' : null;
    if (!imported) continue;
    const origin = index.originsOf(edge.target, imported)[0] || { path: edge.target, name: imported };
    const own = (index.modules.get(origin.path) || { exports: [] }).exports.find((e) => e.name === origin.name);
    // `export default name;` names its binding only in the expression.
    const scan = index.scans.get(origin.path);
    const named = origin.name === 'default' && scan && scan.bare.match(/\bexport\s+default\s+([\w$]+)\s*;?\s*$/m);
    return { path: origin.path, local: (own && own.local) || (named && named[1]) || origin.name };
  }
  return null;
}

// The `(` of a function's parameter list declared as `function name(` or `name = (`.
function functionParamsAt(bare, name) {
  const n = name.replace(/\$/g, '\\$');
  const m = new RegExp(`(?:\\bfunction\\s+${n}\\s*(?:<[^>]*>)?|(?<![\\w$.])${n}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?)\\(`).exec(bare);
  return m ? m.index + m[0].length - 1 : -1;
}

// The top-level fields of the object literal a function returns, or null when unsure.
function returnedFields(index, decl) {
  const scan = index.scans.get(decl.path);
  if (!scan || !scan.bare) return null;
  const bare = scan.bare;
  const open = functionParamsAt(bare, decl.local);
  const close = open < 0 ? -1 : matchBracket(bare, open);
  if (close < 0) return null;
  const head = bare.slice(close + 1).match(/^\s*(?::[^{=]*)?(=>\s*)?(\(\s*)?\{/);
  if (!head) return null;
  let brace = close + head[0].length;
  if (!head[2]) {
    const end = matchBracket(bare, brace);
    const ret = end < 0 ? null : /\breturn\s*\{/.exec(bare.slice(brace, end));
    if (!ret) return null;
    brace += ret.index + ret[0].length - 1;
  }
  const end = matchBracket(bare, brace);
  if (end < 0) return null;
  const fields = [];
  for (const part of splitTopLevel(bare.slice(brace + 1, end), [','])) {
    const key = part.text.trim().match(/^([\w$]+)\s*(?::|$)/);
    if (!key) return null;
    fields.push(key[1]);
  }
  return { fields, line: lineAt(scan.starts, brace) };
}

// Zoneless production, zone-based specs: a TestBed without provideZonelessChangeDetection()
// runs change detection the way the application never does.
function zoneFacts(index, add) {
  const zoneless = index.sourceScripts.filter((p) => !reEntryFile.test(p) && /\bprovideZonelessChangeDetection\s*\(/.test(index.scans.get(p).bare));
  if (zoneless.length === 0) return;
  const setup = [...index.modules.keys()].some((p) => reEntryFile.test(p) && /\bprovideZonelessChangeDetection\s*\(/.test(index.scans.get(p).bare));
  if (setup) return;
  for (const spec of [...index.modules.keys()].filter((p) => reSpec.test(p))) {
    const scan = index.scans.get(spec);
    if (/\bprovideZonelessChangeDetection\s*\(/.test(scan.bare)) continue;
    const beds = [...scan.bare.matchAll(/\bTestBed\s*\.\s*configureTestingModule\s*\(/g)].map((m) => lineAt(scan.starts, m.index));
    if (beds.length === 0) continue;
    const zoned = [...scan.bare.matchAll(/\b(?:fakeAsync|waitForAsync|tick|flush)\s*\(/g)].map((m) => lineAt(scan.starts, m.index));
    add(spec, 'spec-zone-based', [...beds, ...zoned], `aplikacja działa bez zone.js (provideZonelessChangeDetection w ${list(zoneless.map((p) => short(p, index.root)))}), a TestBed tego specu (L${beds.join(', L')}) go nie dostaje${zoned.length > 0 ? `, za to używa narzędzi strefy (L${zoned.join(', L')})` : ''} - spec sprawdza detekcję zmian, której produkcja nie ma.`);
  }
}

// One stub standing in for several different dependencies: each dependency's own members
// are then missing from it or mixed together.
function stubFacts(index, add) {
  const strip = (t) => t.trim().replace(/^\(\s*([\s\S]*)\)$/, '$1').replace(/(?:\s+as\s+[\w$.<>[\]]+)+$/, '').trim();
  for (const spec of [...index.modules.keys()].filter((p) => reSpec.test(p))) {
    const scan = index.scans.get(spec);
    for (const m of scan.bare.matchAll(/\bnew\s+([\w$]+)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(scan.bare, open);
      if (close < 0) continue;
      const args = splitTopLevel(scan.code.slice(open + 1, close), [',']).map((a) => strip(a.text));
      const counts = new Map();
      for (const a of args) if (/^[\w$]+$/.test(a) && !/^(?:null|undefined|true|false|this)$/.test(a)) counts.set(a, (counts.get(a) || 0) + 1);
      for (const [stub, n] of counts) {
        if (n < 2) continue;
        const line = lineAt(scan.starts, m.index);
        add(spec, 'stub-under-multiple-tokens', [line], `new ${m[1]}(...) (L${line}) dostaje ten sam stub ${stub} za ${n} różne parametry konstruktora - każda zależność potrzebuje własnego stubu z własnymi członkami.`);
      }
    }
    const byStub = new Map();
    for (const m of scan.code.matchAll(/\bprovide\s*:\s*([\w$.]+)\s*,\s*use(?:Value|Class|Existing)\s*:\s*([\w$.]+)/g)) {
      if (!byStub.has(m[2])) byStub.set(m[2], []);
      byStub.get(m[2]).push({ token: m[1], line: lineAt(scan.starts, m.index) });
    }
    for (const [stub, uses] of byStub) {
      const tokens = [...new Set(uses.map((u) => u.token))];
      if (tokens.length < 2) continue;
      add(spec, 'stub-under-multiple-tokens', uses.map((u) => u.line), `ten sam stub ${stub} podany za ${tokens.length} różne tokeny (${tokens.join(', ')}; L${uses.map((u) => u.line).join(', L')}) - każda zależność potrzebuje własnego stubu z własnymi członkami.`);
    }
  }
}

// An enum the code branches on whose variants the companion spec covers only in part.
function enumFacts(index, add) {
  const members = (decl) => {
    const scan = index.scans.get(decl.path);
    const m = scan && new RegExp(`\\benum\\s+${decl.local.replace(/\$/g, '\\$')}\\s*\\{`).exec(scan.bare);
    if (!m) return null;
    const close = matchBracket(scan.bare, m.index + m[0].length - 1);
    if (close < 0) return null;
    return splitTopLevel(scan.bare.slice(m.index + m[0].length, close), [',']).map((part) => part.text.trim().match(/^[\w$]+/)).filter(Boolean).map((k) => k[0]);
  };
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    const stem = p.replace(/\.[cm]?[jt]sx?$/, '');
    const spec = [`${stem}.spec.ts`, `${path.posix.dirname(p)}/tests/${path.posix.basename(stem)}.spec.ts`].find((q) => index.scans.has(q));
    if (!spec) continue;
    const specScan = index.scans.get(spec);
    const cases = new Map();
    for (const m of scan.bare.matchAll(/\bcase\s+([\w$]+)\.([\w$]+)\s*:/g)) {
      if (!cases.has(m[1])) cases.set(m[1], lineAt(scan.starts, m.index));
    }
    for (const [name, line] of cases) {
      const decl = declarationOf(index, p, name) || (new RegExp(`\\benum\\s+${name}\\b`).test(scan.bare) ? { path: p, local: name } : null);
      const variants = decl && members(decl);
      if (!variants || variants.length < 2) continue;
      const specName = [...(index.modules.get(spec).imports)].flatMap((e) => e.names).find((s) => s.imported === decl.local);
      const local = specName ? specName.local : name;
      const used = new Map();
      for (const m of specScan.bare.matchAll(new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\.([\\w$]+)`, 'g'))) {
        if (!used.has(m[1])) used.set(m[1], lineAt(specScan.starts, m.index));
      }
      const missing = variants.filter((v) => !used.has(v));
      if (used.size === 0 || missing.length === 0) continue;
      const text = `${short(p, index.root)} rozgałęzia się po ${name} (L${line}), a ${short(spec, index.root)} sprawdza tylko ${[...used.keys()].join(', ')} - bez przypadku dla ${missing.join(', ')}.`;
      add(spec, 'enum-variant-untested', [...used.values()].slice(0, 1), text);
      add(p, 'enum-variant-untested', [line], text);
    }
  }
}

// A selector projector called in a spec: the inputs and parameter order the selector
// declares, and a call whose argument names are those parameters in another order.
function projectorFacts(index, add) {
  for (const spec of [...index.modules.keys()].filter((p) => reSpec.test(p))) {
    const scan = index.scans.get(spec);
    for (const m of scan.bare.matchAll(/(?<![\w$.])([\w$]+)(?:\s*\.\s*([\w$]+))?\s*\.\s*projector\s*\(/g)) {
      const called = m[2] ? `${m[1]}.${m[2]}` : m[1];
      const open = m.index + m[0].length - 1;
      const close = matchBracket(scan.bare, open);
      const decl = close < 0 ? null : declarationOf(index, spec, m[1]);
      const origin = decl && index.scans.get(decl.path);
      if (!origin) continue;
      // `Group.member.projector`: a member of an exported selector group, `member: local` or shorthand.
      const alias = m[2] && origin.bare.match(new RegExp(`(?<![\\w$.])${m[2]}\\s*:\\s*([\\w$]+)`));
      const local = m[2] ? (alias ? alias[1] : m[2]) : decl.local;
      const sel = new RegExp(`(?<![\\w$.])${local.replace(/\$/g, '\\$')}\\s*(?::[^=]+)?=\\s*createSelector\\s*\\(`).exec(origin.bare);
      const selClose = sel ? matchBracket(origin.bare, sel.index + sel[0].length - 1) : -1;
      if (selClose < 0) continue;
      const parts = splitTopLevel(origin.code.slice(sel.index + sel[0].length, selClose), [',']);
      const fn = parts.pop();
      const params = fn && fn.text.trim().match(/^(?:function\s*[\w$]*\s*)?\(([^)]*)\)/);
      if (!params) continue;
      const names = params[1].split(',').map((s) => s.trim().replace(/[?:].*$/, '').trim()).filter(Boolean);
      const inputs = parts.map((x) => x.text.trim());
      const args = splitTopLevel(scan.code.slice(open + 1, close), [',']).map((a) => a.text.trim());
      const line = lineAt(scan.starts, m.index);
      const selLine = lineAt(origin.starts, sel.index);
      const shape = `${local} (${short(decl.path, index.root)} L${selLine}) łączy wejścia ${inputs.join(', ')} - projektor przyjmuje (${names.join(', ')}) w tej kolejności`;
      add(spec, 'projector-inputs', [line], `${called}.projector(...) L${line}: ${shape}.`);
      const norm = (s) => s.toLowerCase();
      if (args.length !== names.length) {
        add(spec, 'projector-argument-order', [line], `${called}.projector(...) L${line} dostaje ${args.length} argument(y), a ${shape}.`);
      } else if (args.every((a) => /^[\w$]+$/.test(a)) && args.map(norm).sort().join() === names.map(norm).sort().join() && args.map(norm).join() !== names.map(norm).join()) {
        add(spec, 'projector-argument-order', [line], `${called}.projector(${args.join(', ')}) L${line} podaje argumenty w innej kolejności, niż ${shape}.`);
      }
    }
  }
}

// A createActionGroup event nothing outside its declaration refers to (comments ignored).
function unconsumedActionFacts(index, add) {
  const sources = index.sourceScripts.map((p) => ({ p, bare: index.scans.get(p).bare || index.scans.get(p).code }));
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    for (const m of scan.bare.matchAll(/\bcreateActionGroup\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(scan.bare, open);
      if (close < 0) continue;
      for (const e of scan.code.slice(open, close).matchAll(/^\s*(['"])([^'"\n]+)\1\s*:/gm)) {
        const name = actionName(e[2]);
        const re = new RegExp(`\\.\\s*${name}\\b`);
        const used = sources.some((s) => (s.p === p ? re.test(s.bare.slice(0, open) + s.bare.slice(close)) : re.test(s.bare)));
        if (used) continue;
        const line = lineAt(scan.starts, open + e.index + e[0].search(/['"]/));
        add(p, 'action-unconsumed', [line], `zdarzenie '${e[2]}' (L${line}) nie ma konsumenta - żaden reducer, efekt ani komponent nie odwołuje się do .${name} (komentarze się nie liczą).`);
      }
    }
  }
}

// Template symbols of a standalone component whose declarable is missing from `imports`.
const externalSymbols = {
  pipe: {
    translate: ['TranslatePipe', 'TranslateModule'],
    async: ['AsyncPipe', 'CommonModule'], date: ['DatePipe', 'CommonModule'], json: ['JsonPipe', 'CommonModule'],
    uppercase: ['UpperCasePipe', 'CommonModule'], lowercase: ['LowerCasePipe', 'CommonModule'], titlecase: ['TitleCasePipe', 'CommonModule'],
    currency: ['CurrencyPipe', 'CommonModule'], number: ['DecimalPipe', 'CommonModule'], percent: ['PercentPipe', 'CommonModule'],
    slice: ['SlicePipe', 'CommonModule'], keyvalue: ['KeyValuePipe', 'CommonModule'],
  },
  attribute: {
    formControl: ['ReactiveFormsModule'], formControlName: ['ReactiveFormsModule'], formGroup: ['ReactiveFormsModule'],
    formGroupName: ['ReactiveFormsModule'], formArrayName: ['ReactiveFormsModule'], ngModel: ['FormsModule'],
    ngSrc: ['NgOptimizedImage'], ngIf: ['NgIf', 'CommonModule'], ngFor: ['NgFor', 'NgForOf', 'CommonModule'],
    ngClass: ['NgClass', 'CommonModule'], ngStyle: ['NgStyle', 'CommonModule'], ngTemplateOutlet: ['NgTemplateOutlet', 'CommonModule'],
    ngSwitch: ['NgSwitch', 'CommonModule'], routerLink: ['RouterLink', 'RouterModule'], routerLinkActive: ['RouterLinkActive', 'RouterModule'],
  },
  element: { 'router-outlet': ['RouterOutlet', 'RouterModule'] },
};

function declarables(index) {
  const out = { pipe: new Map(), attribute: new Map(), element: new Map() };
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    for (const m of scan.code.matchAll(/@(Component|Directive|Pipe)\s*\(\s*\{/g)) {
      const close = matchBracket(scan.code, m.index + m[0].length - 1);
      const cls = close < 0 ? null : scan.bare.slice(close).match(/\bclass\s+([\w$]+)/);
      if (!cls) continue;
      const body = scan.code.slice(m.index, close);
      const entry = { name: cls[1], path: p, line: lineAt(scan.starts, m.index) };
      if (m[1] === 'Pipe') {
        const name = body.match(/\bname\s*:\s*(['"])([^'"]+)\1/);
        if (name) out.pipe.set(name[2], entry);
        continue;
      }
      const selector = body.match(/\bselector\s*:\s*(['"])([^'"]+)\1/);
      for (const s of selector ? selector[2].split(',').map((x) => x.trim()) : []) {
        const attr = s.match(/^\[([\w-]+)\]$/);
        if (attr) out.attribute.set(attr[1], entry);
        else if (/^[a-z][\w-]*$/.test(s)) out.element.set(s, entry);
      }
    }
  }
  return out;
}

// What a template uses: pipes, bound/plain attribute names, element names, with offsets.
function templateSymbols(code) {
  const used = [];
  for (const m of code.matchAll(/(?<!\|)\|(?!\|)\s*([A-Za-z_$][\w$]*)/g)) used.push({ kind: 'pipe', name: m[1], at: m.index });
  for (const tag of code.matchAll(/<([a-zA-Z][\w-]*)([^<>]*)>/g)) {
    used.push({ kind: 'element', name: tag[1], at: tag.index });
    const attrs = tag[2].replace(/"[^"]*"|'[^']*'/g, '""');
    for (const a of attrs.matchAll(/\s(?:\[\(|\[|\*)?([A-Za-z][\w-]*)/g)) used.push({ kind: 'attribute', name: a[1], at: tag.index + 1 + tag[1].length + a.index });
  }
  return used;
}

function importFacts(index, add) {
  const own = declarables(index);
  const exportsOf = new Map();
  const moduleExports = (decl) => {
    const key = `${decl.path}\0${decl.local}`;
    if (exportsOf.has(key)) return exportsOf.get(key);
    const scan = index.scans.get(decl.path);
    const at = scan ? new RegExp(`@NgModule\\s*\\(\\s*\\{[\\s\\S]*?\\bclass\\s+${decl.local.replace(/\$/g, '\\$')}\\b`).exec(scan.code) : null;
    const list_ = at && at[0].match(/\bexports\s*:\s*\[([^\]]*)\]/);
    const names = new Set(list_ ? list_[1].split(',').map((s) => s.trim()).filter(Boolean) : []);
    exportsOf.set(key, names);
    return names;
  };
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    const comp = /@Component\s*\(\s*\{/.exec(scan.code);
    if (!comp) continue;
    const close = matchBracket(scan.code, comp.index + comp[0].length - 1);
    if (close < 0) continue;
    const body = scan.code.slice(comp.index, close);
    if (/\bstandalone\s*:\s*false\b/.test(body)) continue;
    const importsAt = body.search(/\bimports\s*:\s*\[/);
    if (importsAt < 0 && !/\bstandalone\s*:\s*true\b/.test(body)) continue;
    let imported = [];
    if (importsAt >= 0) {
      const open = comp.index + importsAt + body.slice(importsAt).indexOf('[');
      const end = matchBracket(scan.code, open);
      if (end < 0) continue;
      imported = splitTopLevel(scan.code.slice(open + 1, end), [',']).map((x) => x.text.trim());
      if (imported.some((x) => !/^[\w$]+$/.test(x))) continue;
    }
    const importsLine = lineAt(scan.starts, importsAt >= 0 ? comp.index + importsAt : comp.index);
    let template = null;
    const url = body.match(/\btemplateUrl\s*:\s*(['"])([^'"]+)\1/);
    if (url) {
      const tp = path.posix.normalize(path.posix.join(path.posix.dirname(p), url[2]));
      const tScan = index.scans.get(tp);
      if (tScan) template = { path: tp, code: tScan.code, lineOf: (i) => lineAt(tScan.starts, i) };
    } else {
      const s = scan.strings.find((x) => x.start > comp.index && x.start < close && /\btemplate\s*:\s*$/.test(scan.code.slice(Math.max(0, x.start - 40), x.start)));
      if (s) template = { path: p, code: s.value, lineOf: (i) => lineAt(scan.starts, s.start + 1 + i) };
    }
    if (!template) continue;
    const satisfied = (names) => imported.some((x) => names.includes(x));
    const viaModule = (cls) => imported.some((x) => {
      const decl = declarationOf(index, p, x);
      return decl && moduleExports(decl).has(cls);
    });
    const missing = new Map();
    for (const u of templateSymbols(template.code)) {
      const mine = own[u.kind].get(u.name);
      let label = null;
      let entry = null;
      if (mine) {
        if (mine.path === p || satisfied([mine.name]) || viaModule(mine.name)) continue;
        label = mine.name;
        entry = mine;
      } else {
        const ext = externalSymbols[u.kind][u.name];
        if (!ext || satisfied(ext)) continue;
        label = ext.join('/');
      }
      if (!missing.has(label)) missing.set(label, { use: `${u.kind === 'pipe' ? '| ' : ''}${u.name}`, lines: [], entry });
      missing.get(label).lines.push(template.lineOf(u.at));
    }
    for (const [label, miss] of missing) {
      const lines = [...new Set(miss.lines)];
      const where = `${short(template.path, index.root)} L${lines.join(', L')}`;
      const text = `szablon ${short(p, index.root)} używa ${miss.use} (${where}), a imports komponentu (L${importsLine}) nie zawiera ${label} ani modułu, który go eksportuje - kompilacja go nie rozpozna.`;
      add(p, 'template-symbol-not-imported', [importsLine], text);
      if (template.path !== p) add(template.path, 'template-symbol-not-imported', lines, text);
      if (miss.entry) add(miss.entry.path, 'template-symbol-not-imported', [miss.entry.line], text);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Probes: the per-line half. A rulebook item declares one (or a list) under `probe`:
//   { "pattern": "<regex>", "flags": "m", "message": "...", "paths": "<regex>", "min": 2 }
//   { "absent": "<regex>", "anchor": "<regex>", "message": "..." }
//   { "builtin": "for-without-empty" }
//   { "fact": "export-single-importer" }   (a fact kind, pointed at instead of contradicted)
// A hit is `{ line, text }`. The regex runs over the file with comments blanked; a named
// group `at` places the hit on its own line instead of the match start.

function compileProbe(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('a probe is an object');
  const kinds = ['pattern', 'absent', 'builtin', 'fact'].filter((k) => spec[k] !== undefined);
  if (kinds.length !== 1) throw new Error('a probe declares exactly one of "pattern", "absent", "builtin", "fact"');
  const flags = (spec.flags || '').replace(/[gd]/g, '');
  if (spec.pattern !== undefined) new RegExp(spec.pattern, `${flags}dg`);
  if (spec.absent !== undefined) new RegExp(spec.absent, flags);
  if (spec.anchor !== undefined) new RegExp(spec.anchor, flags);
  if (spec.paths !== undefined) new RegExp(spec.paths);
  if (spec.builtin !== undefined && !builtinProbes.includes(spec.builtin)) throw new Error(`unknown builtin probe "${spec.builtin}" (known: ${builtinProbes.join(', ')})`);
  if (spec.fact !== undefined && !factKinds.includes(spec.fact)) throw new Error(`unknown fact kind "${spec.fact}"`);
  if (spec.min !== undefined && !(Number.isInteger(spec.min) && spec.min >= 1)) throw new Error('"min" is a positive integer');
  if (spec.pattern !== undefined || spec.absent !== undefined) {
    if (typeof spec.message !== 'string' || spec.message.trim() === '') throw new Error('a pattern probe needs a "message"');
  }
  return spec;
}

function componentMembers(text) {
  const scan = scanScript(text);
  const bare = scan.bare;
  const methods = new Set([...bare.matchAll(/^[ \t]*(?:(?:public|protected|private|static|async|override)\s+)*([\w$]+)\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{/gm)].map((m) => m[1]));
  return { methods };
}

function runBuiltin(name, p, scan, context) {
  const hits = [];
  const at = (i) => lineAt(scan.starts, i);
  const code = scan.code;
  if (name === 'for-without-empty') {
    if (!reTemplate.test(p) && !context.inlineTemplate) return hits;
    for (const m of code.matchAll(/@for\s*\(/g)) {
      const close = matchBracket(code, m.index + m[0].length - 1);
      if (close < 0) continue;
      const brace = code.indexOf('{', close);
      const end = brace < 0 ? -1 : matchBracket(code, brace);
      if (end < 0) continue;
      if (/^\s*@empty\b/.test(code.slice(end + 1))) continue;
      const subject = code.slice(m.index + m[0].length, close).split(';')[0].trim();
      hits.push({ line: at(m.index), text: `@for (${subject}) bez bloku @empty` });
    }
  } else if (name === 'signal-reads-without-let') {
    if (!reTemplate.test(p)) return hits;
    const members = context.companionText ? componentMembers(context.companionText) : null;
    const events = [...code.matchAll(/\(\s*[\w.-]+\s*\)\s*=\s*"[^"]*"/g)].map((m) => [m.index, m.index + m[0].length]);
    const inEvent = (i) => events.some(([s, e]) => i >= s && i < e);
    const reads = new Map();
    for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\(\s*\)/g)) {
      if (inEvent(m.index) || (members && members.methods.has(m[1]))) continue;
      reads.set(m[1], [...(reads.get(m[1]) || []), at(m.index)]);
    }
    for (const [signal, lines] of reads) {
      if (lines.length < 2) continue;
      if (new RegExp(`@let\\s+[\\w$]+\\s*=\\s*${signal.replace(/\$/g, '\\$')}\\(\\s*\\)`).test(code)) continue;
      hits.push({ line: lines[0], text: `${signal}() czytane ${lines.length} razy (L${lines.join(', L')}) bez @let` });
    }
  } else if (name === 'markup-repeat') {
    if (!reTemplate.test(p)) return hits;
    const shapes = new Map();
    code.split('\n').forEach((line, i) => {
      const tags = line.match(/<[a-zA-Z][^<>]*>/g) || [];
      const attributes = tags.reduce((sum, t) => sum + (t.match(/\s[^\s=<>"']+\s*=\s*"/g) || []).length, 0);
      if (attributes < 2) return;
      const shape = line.trim().replace(/"[^"]*"/g, '""').replace(/>[^<]*</g, '><').replace(/\s+/g, ' ');
      shapes.set(shape, [...(shapes.get(shape) || []), i + 1]);
    });
    for (const lines of shapes.values()) {
      if (lines.length < minCopies) continue;
      for (const line of lines) hits.push({ line, text: `ten sam fragment znaczników w L${lines.join(', L')} - różnią się tylko wartościami atrybutów i tekstem` });
    }
  } else if (name === 'area-root-file') {
    const split = areaSplit(p);
    if (split && split.rest.length === 0 && !reLayoutSegment.test(split.area)) hits.push({ line: 1, text: `plik leży bezpośrednio w katalogu obszaru ${split.area}, poza podfolderami jego układu` });
  } else if (name === 'hover-without-focus') {
    if (reTemplate.test(p) || context.inlineTemplate) {
      for (const tag of code.matchAll(/<([a-zA-Z][\w-]*)([^<>]*)>/g)) {
        const hover = tag[2].match(/\(\s*(mouseenter|mouseover)\s*\)/);
        if (hover && !/\(\s*(?:focus|focusin)\s*\)/.test(tag[2])) hits.push({ line: at(tag.index), text: `<${tag[1]}> reaguje na (${hover[1]}) bez (focus)/(focusin) - z klawiatury treść się nie pokaże` });
      }
    } else if (reScript.test(p) && !/@HostListener\s*\(\s*['"](?:focus|focusin)['"]/.test(code)) {
      for (const m of code.matchAll(/@HostListener\s*\(\s*['"](mouseenter|mouseover)['"]/g)) hits.push({ line: at(m.index), text: `@HostListener('${m[1]}') bez słuchacza focus/focusin - z klawiatury efekt się nie pojawi` });
    }
  } else if (name === 'action-label-mismatch') {
    if (!reTemplate.test(p)) return hits;
    const groups = new Map();
    for (const tag of code.matchAll(/<([a-zA-Z][\w-]*)([^<>]*)>/g)) {
      const handler = tag[2].match(/\((?:click|mousedown|mouseup|keydown\.enter)\)\s*=\s*"\s*([\w$.]+)\s*\(/);
      if (!handler) continue;
      const attr = tag[2].match(/\b(?:aria-label|title)\s*=\s*"([^"{}]+)"/);
      const inner = code.slice(tag.index + tag[0].length).match(/^\s*([^<>{}]*?)\s*<\//);
      const label = attr ? attr[1].trim() : inner && inner[1].trim();
      if (!label) continue;
      if (!groups.has(handler[1])) groups.set(handler[1], []);
      groups.get(handler[1]).push({ line: at(tag.index), label });
    }
    for (const [call, uses] of groups) {
      const labels = [...new Set(uses.map((u) => u.label.toLowerCase()))];
      if (labels.length < 2) continue;
      for (const u of uses) hits.push({ line: u.line, text: `${call}() ma różne etykiety: ${uses.map((x) => `'${x.label}' L${x.line}`).join(', ')} - ta sama funkcja, ta sama nazwa dostępna` });
    }
  }
  return hits;
}

// Hits of one probe in one file. `facts` are the file's facts (for `{ fact }` probes);
// `context.companionText` is the component class of a template (for signal reads).
function runProbe(spec, p, text, facts = [], context = {}) {
  if (spec.paths !== undefined && !new RegExp(spec.paths).test(p)) return [];
  if (spec.fact !== undefined) {
    return facts.filter((f) => f.kind === spec.fact).flatMap((f) => f.lines.map((line) => ({ line, text: f.text })));
  }
  const scan = scanFile(p, text);
  if (spec.builtin !== undefined) return runBuiltin(spec.builtin, p, scan, context);
  const flags = (spec.flags || '').replace(/[gd]/g, '');
  if (spec.absent !== undefined) {
    if (new RegExp(spec.absent, flags).test(scan.code)) return [];
    const anchor = spec.anchor ? new RegExp(spec.anchor, flags).exec(scan.code) : null;
    return [{ line: anchor ? lineAt(scan.starts, anchor.index) : 1, text: spec.message }];
  }
  const hits = [];
  for (const m of scan.code.matchAll(new RegExp(spec.pattern, `${flags}dg`))) {
    const index = m.indices && m.indices.groups && m.indices.groups.at ? m.indices.groups.at[0] : m.index;
    hits.push({ line: lineAt(scan.starts, index), text: spec.message });
  }
  if (hits.length < (spec.min || 1)) return [];
  const seen = new Set();
  return hits.filter((h) => !seen.has(h.line) && seen.add(h.line));
}

// The canonical layout keeps an area's routes in `shared/routes/` or, for a multi-step
// wizard, in `shell/` - never both. Every routes file of both sides gets the fact, so the
// defect is reported on each side instead of on whichever file the review saw last.
function layoutFacts(index, add, cross) {
  const areas = new Map();
  for (const p of index.sourceScripts) {
    const m = p.match(/(?:^|\/)src\/app\/(.+?)\/(shared\/routes|shell)\/[^/]+\.routes\.[cm]?[jt]s$/);
    if (!m) continue;
    if (!areas.has(m[1])) areas.set(m[1], { 'shared/routes': [], shell: [] });
    areas.get(m[1])[m[2]].push(p);
  }
  for (const [area, sides] of areas) {
    if (sides['shared/routes'].length === 0 || sides.shell.length === 0) continue;
    const named = (paths) => paths.map((p) => short(p, index.root)).join(', ');
    const text = `obszar \`${area}\` ma trasy i w \`shared/routes/\` (${named(sides['shared/routes'])}), i w \`shell/\` (${named(sides.shell)}) - układ obszaru ma tylko jedno z nich.`;
    for (const p of [...sides['shared/routes'], ...sides.shell]) add(p, 'area-routes-twice', [1], text);
    cross(`Obszar ${area} ma trasy i w shared/routes/, i w shell/: ${named([...sides['shared/routes'], ...sides.shell])}`);
  }
}

// `models/index.ts` is the one door into a models folder: a file outside it that imports one
// of its modules directly leaves the barrel with a consumer it does not serve. The fact stands
// on the barrel, on its own line for each bypassed module (line 1 for a module it forgot).
function barrelBypassFacts(index, add, cross) {
  const found = [];
  for (const [barrel, mod] of index.modules) {
    if (!mod.isBarrel || reSpec.test(barrel) || !/(?:^|\/)models\/index\.[cm]?[jt]s$/.test(barrel)) continue;
    const dir = path.posix.dirname(barrel);
    const inside = (p) => p.startsWith(`${dir}/`);
    const exported = new Map();
    for (const edge of mod.reexports) if (edge.target && !exported.has(edge.target)) exported.set(edge.target, edge.line);
    const bypass = [];
    for (const [p, importer] of index.modules) {
      if (inside(p)) continue;
      for (const edge of importer.imports) {
        if (edge.target && edge.target !== barrel && inside(edge.target)) bypass.push({ path: p, line: edge.line, spec: edge.spec, target: edge.target });
      }
    }
    if (bypass.length === 0) continue;
    const rows = bypass.map((b) => `${short(b.path, index.root)}:${b.line} "${b.spec}"${exported.has(b.target) ? '' : ' (barrel nie re-eksportuje tego modułu)'}`);
    add(barrel, 'barrel-bypass', bypass.map((b) => exported.get(b.target) || 1),
      `pliki spoza ${short(dir, index.root)}/ importują moduły modeli z pominięciem tego barrela: ${list(rows, 8)}.`);
    found.push(...rows);
  }
  if (found.length > 0) cross(`Importy z pominięciem barrela modeli: ${list(found, 12)}`);
}

const reSnakeName = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const reCamelName = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
// The interfaces that mirror one API endpoint: `<endpoint>-(request|response|payload|dto).interface.ts`.
const reApiInterfaceFile = /(?:^|\/)models\/interfaces\/[^/]+-(?:request|response|payload|dto)\.interface\.[cm]?ts$/;

// An API interface keeps the casing the API sends: one that spells some fields camelCase and
// others snake_case has re-spelled part of the contract. The odd side is the style fewer
// fields use (camelCase on a tie); single-word names belong to both styles.
function dtoCasingFacts(index, add, cross) {
  const found = [];
  for (const item of interfaceList(index)) {
    if (!reApiInterfaceFile.test(item.path)) continue;
    const named = (re) => [...item.fields].filter(([name]) => re.test(name)).map(([name, field]) => ({ name, line: field.line }));
    const camel = named(reCamelName);
    const snake = named(reSnakeName);
    if (camel.length === 0 || snake.length === 0) continue;
    const [odd, major] = camel.length <= snake.length ? [camel, snake] : [snake, camel];
    const show = (fields) => fields.map((f) => `${f.name} L${f.line}`).join(', ');
    add(item.path, 'dto-casing-mixed', [...odd.map((f) => f.line), major[0].line],
      `interfejs ${item.name} (L${item.line}) miesza style nazw pól: camelCase (${show(camel)}) i snake_case (${show(snake)}) - interfejs API odwzorowuje kontrakt w jednym stylu.`);
    found.push(`${short(item.path, index.root)} ${item.name}`);
  }
  if (found.length > 0) cross(`Interfejsy API z mieszanymi stylami nazw pól: ${list(found, 12)}`);
}

// The classes a script injects, through `inject(Type)` or a constructor parameter of that type.
function injectedTypes(scan) {
  const bare = scan.bare || scan.code;
  const out = [];
  for (const m of bare.matchAll(/\binject\s*(?:<[^>()]*>)?\s*\(\s*([A-Z][\w$]*)\b/g)) out.push({ name: m[1], line: lineAt(scan.starts, m.index) });
  const ctor = /\bconstructor\s*\(/.exec(bare);
  const open = ctor ? ctor.index + ctor[0].length - 1 : -1;
  const close = open < 0 ? -1 : matchBracket(bare, open);
  if (close > open) {
    for (const part of splitTopLevel(bare.slice(open + 1, close), [','])) {
      const param = part.text.match(/^\s*(?:@[\w$]+\s*\([^)]*\)\s*)*(?:(?:private|protected|public|readonly)\s+)*[\w$]+\??\s*:\s*([A-Z][\w$]*)\b/);
      if (param) out.push({ name: param[1], line: lineAt(scan.starts, open + 1 + part.at + part.text.search(/\S/)) });
    }
  }
  return out;
}

// Components, directives and pipes reach state and data through the area's facade: one that
// injects the `Store` or a class of a `data-access/` folder that is no facade has skipped a
// layer. The fact stands on the injecting file and on each class it injects.
function injectionFacts(index, add, cross) {
  const users = new Map();
  const found = [];
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    if (!/@(?:Component|Directive|Pipe)\s*\(/.test(scan.bare || scan.code)) continue;
    const mod = index.modules.get(p);
    const direct = [];
    for (const injected of injectedTypes(scan)) {
      const edge = mod.imports.find((e) => e.names.some((s) => s.local === injected.name));
      if (!edge) continue;
      const imported = edge.names.find((s) => s.local === injected.name).imported;
      if (edge.spec === '@ngrx/store' && imported === 'Store') {
        direct.push({ ...injected, label: 'Store (@ngrx/store)' });
        continue;
      }
      if (!edge.target) continue;
      for (const origin of index.originsOf(edge.target, imported)) {
        if (!/(?:^|\/)data-access\//.test(origin.path) || /\.facade\.[cm]?[jt]s$/.test(origin.path)) continue;
        direct.push({ ...injected, label: `${origin.name} (${short(origin.path, index.root)})` });
        const key = `${origin.path}\0${origin.name}`;
        if (!users.has(key)) users.set(key, { origin, by: [] });
        users.get(key).by.push({ path: p, line: injected.line });
      }
    }
    if (direct.length === 0) continue;
    add(p, 'component-injects-data-access', direct.map((d) => d.line),
      `wstrzykuje warstwę danych z pominięciem fasady: ${list(direct.map((d) => `${d.label} L${d.line}`), 6)} - komponent, dyrektywa i pipe sięgają do stanu i danych przez fasadę obszaru.`);
    found.push(...direct.map((d) => `${short(p, index.root)}:${d.line} ${d.label.replace(/ \(.*$/, '')}`));
  }
  for (const { origin, by } of users.values()) {
    const exported = index.modules.get(origin.path).exports.find((e) => e.name === origin.name);
    const line = exported ? exported.line : 1;
    add(origin.path, 'component-injects-data-access', [line],
      `${origin.name} (L${line}) jest wstrzykiwana bezpośrednio przez ${list(by.map((b) => `${short(b.path, index.root)}:${b.line}`), 6)} - komponent, dyrektywa i pipe sięgają do niej z pominięciem fasady.`);
  }
  if (found.length > 0) cross(`Komponenty, dyrektywy i pipe wstrzykujące Store lub klasę data-access z pominięciem fasady: ${list(found, 12)}`);
}

// `provideState('x', reducer)` registers the slice under a string of its own, while the
// selectors read it by the exported feature key: the two can drift apart. With such a
// constant in the repository the fact is certain; without one it only points at the line.
function stateKeyFacts(index, add) {
  const consts = new Map();
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    for (const m of scan.code.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$'"| ]+)?=\s*(['"])([^'"\n]+)\2\s*(?:as\s+const\s*)?[;\n]/g)) {
      if (!consts.has(m[3])) consts.set(m[3], []);
      consts.get(m[3]).push({ name: m[1], path: p, line: lineAt(scan.starts, m.index) });
    }
  }
  const re = /\b(?:provideState|StoreModule\s*\.\s*forFeature)\s*\(\s*(?:\{\s*name\s*:\s*)?(['"])([^'"\n]+)\1/g;
  const named = (cs) => list(cs.map((c) => `${c.name} (${short(c.path, index.root)}:${c.line})`), 3);
  for (const p of index.sourceScripts) {
    const scan = index.scans.get(p);
    for (const m of scan.code.matchAll(re)) {
      const line = lineAt(scan.starts, m.index);
      const same = consts.get(m[2]) || [];
      const keys = same.filter((c) => /feature|key|slice|state|store/i.test(c.name));
      if (keys.length > 0) {
        add(p, 'state-key-literal', [line], `wycinek stanu rejestrowany pod literałem '${m[2]}' (L${line}), a ta sama wartość jest wyeksportowana jako ${named(keys)} - rejestruj pod stałą, inaczej klucz może rozjechać się z kluczem selektora.`);
      } else {
        add(p, 'state-key-literal', [line], `wycinek stanu rejestrowany pod literałem '${m[2]}' (L${line})${same.length > 0 ? `; ta sama wartość jest też stałą ${named(same)}` : '; żadna wyeksportowana stała nie ma tej wartości'} - klucz wycinka to stała, z której korzysta też selektor.`, { hint: true });
      }
    }
  }
}

// An area whose files read route parameters by hand (`location.search`, `ActivatedRoute`) is
// routing without `withComponentInputBinding()`'s `input()`s: the fact stands on one routing
// file of the area - `shared/routes/` before `shell/` - at its `Routes` declaration. Certain
// when no file of the repository turns the binding on, a hint when one does.
function inputBindingFacts(index, add) {
  const reads = new Map();
  for (const p of index.sourceScripts) {
    const area = areaOf(p);
    if (!area) continue;
    const scan = index.scans.get(p);
    const bare = scan.bare || scan.code;
    const at = [...bare.matchAll(/\blocation\.search\b/g)].map((m) => m.index);
    if (/\bActivatedRoute\b/.test(bare)) at.push(...[...bare.matchAll(/\.(?:paramMap|queryParamMap|queryParams|params)\b/g)].map((m) => m.index));
    if (at.length === 0) continue;
    if (!reads.has(area)) reads.set(area, []);
    reads.get(area).push(...at.map((i) => ({ path: p, line: lineAt(scan.starts, i) })));
  }
  if (reads.size === 0) return;
  const places = (re) => index.sourceScripts.flatMap((p) => {
    const scan = index.scans.get(p);
    return [...(scan.bare || scan.code).matchAll(re)].map((m) => `${short(p, index.root)}:${lineAt(scan.starts, m.index)}`);
  });
  const on = places(/\bwithComponentInputBinding\s*\(/g);
  const routing = new Map();
  for (const p of [...index.sourceScripts].sort()) {
    const split = /\.routes\.[cm]?[jt]s$/.test(p) ? areaSplit(p) : null;
    if (!split) continue;
    const side = split.rest.join('/');
    const rank = side === 'shared/routes' ? 0 : side === 'shell' ? 1 : 2;
    if (!routing.has(split.area) || rank < routing.get(split.area).rank) routing.set(split.area, { path: p, rank });
  }
  for (const [area, found] of reads) {
    if (!routing.has(area)) continue;
    const file = routing.get(area).path;
    const scan = index.scans.get(file);
    const declaration = (scan.bare || scan.code).match(/\b(?:const|let)\s+[\w$]+\s*:\s*Routes\b/);
    const line = declaration ? lineAt(scan.starts, declaration.index) : 1;
    const where = list([...new Set(found.map((r) => `${short(r.path, index.root)}:${r.line}`))], 6);
    add(file, 'input-binding-missing', [line],
      `pliki obszaru ${area} czytają parametry trasy ręcznie (${where}); withComponentInputBinding() ${on.length > 0 ? `jest włączone w ${list(on, 4)}` : 'nie jest włączone w żadnym pliku repozytorium'} - parametry nie docierają do komponentu jako input().`,
      { hint: on.length > 0 });
  }
}

// The folders of the canonical layout, relative to the area (rulebook: architecture#1).
const reCanonicalFolder = /^(?:data-access\/(?:\+state|services)|models\/(?:consts|enums|interfaces|types)|shared\/(?:utils|guards|pipes|directives|routes)|shell|components-[^/]+\/(?:feature|ui)(?:\/[^/]+)?)(?:\/tests)?$/;

// `area-layout`: which folder of its area's layout holds a file, and what else the area keeps -
// the folders with their file counts, what lies outside the layout, barrels beyond `models/`,
// interceptors and the routing files. A folder outside the layout is an area of its own to
// `areaSplit`; it is counted back to the feature area it lies in.
function areaLayoutAnswer(index) {
  const areas = new Map();
  for (const p of index.files.keys()) {
    const split = isFactSource(p) ? areaSplit(p) : null;
    if (!split) continue;
    if (!areas.has(split.area)) areas.set(split.area, []);
    areas.get(split.area).push({ path: p, rest: split.rest });
  }
  const features = new Set([...areas].filter(([, entries]) => entries.some((e) => e.rest.length > 0)).map(([area]) => area));
  const place = (p) => {
    const split = areaSplit(p);
    if (!split) return null;
    if (features.has(split.area)) return split;
    const parent = [...features].filter((f) => split.area.startsWith(`${f}/`)).sort((a, b) => b.length - a.length)[0];
    return parent ? { area: parent, rest: split.area.slice(parent.length + 1).split('/') } : null;
  };
  const members = new Map([...features].map((area) => [area, []]));
  for (const entries of areas.values()) {
    for (const e of entries) {
      const at = place(e.path);
      if (at) members.get(at.area).push({ path: e.path, rest: at.rest });
    }
  }
  const inLayout = (p, folder) => (folder === 'models' ? /^index\.[cm]?[jt]s$/.test(path.posix.basename(p)) : reCanonicalFolder.test(folder));
  const summary = new Map();
  for (const [area, entries] of members) {
    const folders = new Map();
    const outside = [];
    const barrels = [];
    const interceptors = [];
    const routes = { 'shared/routes': [], shell: [] };
    const relative = (p) => p.slice(p.indexOf(`src/app/${area}/`) + `src/app/${area}/`.length);
    for (const { path: p, rest } of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const folder = rest.join('/');
      if (!inLayout(p, folder)) outside.push(relative(p));
      const key = rest[0] === 'shell' ? 'shell' : rest.slice(0, 2).join('/') || '(korzeń)';
      folders.set(key, (folders.get(key) || 0) + 1);
      if (reSpec.test(p) || !index.modules.has(p)) continue;
      if (index.modules.get(p).isBarrel && folder !== 'models') barrels.push(relative(p));
      if (/\.interceptor\.[cm]?[jt]s$/.test(p)) interceptors.push(relative(p));
      if (/\.routes\.[cm]?[jt]s$/.test(p) && (folder === 'shared/routes' || folder === 'shell')) routes[folder].push(path.posix.basename(p));
    }
    const both = routes['shared/routes'].length > 0 && routes.shell.length > 0;
    const routing = [
      routes['shared/routes'].length > 0 && `w shared/routes/ (${routes['shared/routes'].join(', ')})`,
      routes.shell.length > 0 && `w shell/ (${routes.shell.join(', ')})`,
    ].filter(Boolean).join(' i ');
    summary.set(area, `Foldery obszaru (liczba plików): ${[...folders].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ')}. `
      + `Poza układem: ${outside.length > 0 ? list(outside, 6) : 'nic'}. Barrele poza models/: ${barrels.length > 0 ? list(barrels, 4) : 'nic'}. `
      + `Interceptory w obszarze: ${interceptors.length > 0 ? list(interceptors, 4) : 'nic'}. `
      + `Trasy: ${routing ? `${routing}${both ? ' - obszar ma tylko jedno z nich' : ''}` : 'brak plików tras'}. `
      + 'Liczone są tylko skrypty, szablony, JSON i migawki - bez stylów i obrazów.');
  }
  const listed = list([...features].sort(), 8);
  return (p) => {
    const here = place(p);
    if (here) {
      const folder = here.rest.join('/');
      const where = folder === '' ? 'korzeniu obszaru' : `\`${folder}\``;
      return `obszar \`${here.area}\`; ten plik leży w ${where}${inLayout(p, folder) ? '' : ' - poza kanonicznym układem'}. ${summary.get(here.area)}`;
    }
    return `plik leży poza obszarem o kanonicznym układzie (\`src/app/<obszar>/{data-access,models,shared,shell,components-*}\`); obszary repozytorium: ${listed || 'żadnego'}.`;
  };
}

// What the repo-search answer adds to the literal, condition and mapping passes: the
// `key: value` pairs of the scripts and, of a test file, its literals and pairs against the
// other tests and the code - the cross-references a spec review otherwise searches for one by one.
function searchRecords(index, occurrences, record, reviewed) {
  const specs = [...index.modules.keys()].filter((p) => reSpec.test(p) && !reDeclaration.test(p));
  const codePairs = pairOccurrences(index, index.sourceScripts);
  for (const all of codePairs.values()) {
    const files = new Set(all.map((o) => o.path));
    for (const p of files) {
      const own = all.filter((o) => o.path === p);
      record(p, 'para', own.map((o) => o.line), own[0].shown, files.size - 1);
    }
  }
  const mine = specs.filter((p) => reviewed.has(p));
  if (mine.length === 0) return;
  const testLiterals = new Map();
  for (const p of specs) {
    for (const l of scriptLiterals(index.scans.get(p), { tests: true })) {
      if (!testLiterals.has(l.norm)) testLiterals.set(l.norm, []);
      testLiterals.get(l.norm).push({ path: p, line: l.line, shown: l.shown });
    }
  }
  const testPairs = pairOccurrences(index, specs);
  const others = (map, norm, p) => new Set((map.get(norm) || []).filter((o) => o.path !== p).map((o) => o.path)).size;
  const grouped = (items) => {
    const out = new Map();
    for (const item of items) {
      if (!out.has(item.norm)) out.set(item.norm, []);
      out.get(item.norm).push(item);
    }
    return out;
  };
  for (const p of mine) {
    const scan = index.scans.get(p);
    for (const [norm, own] of grouped(scriptLiterals(scan, { tests: true }))) {
      const tests = others(testLiterals, norm, p);
      const code = others(occurrences, norm, p);
      record(p, 'literał', own.map((o) => o.line), own[0].shown.startsWith('[') ? own[0].shown : `"${own[0].shown}"`, tests + code, { tests, code });
    }
    for (const [norm, own] of grouped(scriptPairs(scan))) {
      const tests = others(testPairs, norm, p);
      const code = others(codePairs, norm, p);
      record(p, 'para', own.map((o) => o.line), own[0].shown, tests + code, { tests, code });
    }
  }
}

// `repo-search`: what the literal, condition, mapping and pair passes compared of one file
// with the others, repeated or not - `nigdzie indziej` is the search a review need not run
// again. A test file is compared with the other tests as well as with the code (`tests`).
function repoSearchAnswer(entries, { tests = false } = {}) {
  // What `distinctive` and the passes leave out: an answer read as complete would hide them.
  const limits = 'Skrypt nie porównuje pojedynczych krótkich słów (`\'active\'`), ścieżek i adresów (`\'/api/…\'`), kluczy z kropką, literałów z `${}` ani pól, wywołań i wyrażeń bez literału - te wyszukaj sam.'
    + (entries.some((e) => e.what === 'para') ? ' Para `klucz: wartość` to ten sam zapis w obiekcie (liczba od dwóch cyfr, tekst od trzech znaków), nie ta sama wartość pod inną nazwą.' : '');
  if (entries.length === 0) return `${tests ? 'w pliku nie ma literału ani pary `klucz: wartość` do porównania z innymi testami i kodem' : 'w pliku nie ma literału, warunku z wartością ani mapy etykiet do porównania'}. ${limits}`;
  const cut = (text) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);
  const elsewhere = (n) => (n === 0 ? 'nigdzie indziej' : n === 1 ? 'w 1 innym pliku' : `w ${n} innych plikach`);
  const elsewhereTests = (e) => (e.elsewhere === 0 ? 'nigdzie indziej' : [
    e.tests > 0 && `w ${e.tests} ${e.tests === 1 ? 'innym pliku testowym' : 'innych plikach testowych'}`,
    e.code > 0 && `w ${e.code} ${e.code === 1 ? 'pliku kodu' : 'plikach kodu'}`,
  ].filter(Boolean).join(' i '));
  // A label mapping is the same as another when the two share two labels (mappingFacts).
  const same = (e) => (e.what !== 'mapa etykiet' ? (tests ? elsewhereTests(e) : elsewhere(e.elsewhere))
    : e.elsewhere === 0 ? 'żadna funkcja innego pliku nie ma dwóch z jej etykiet' : `dwie z jej etykiet ma też funkcja ${elsewhere(e.elsewhere)}`);
  const limit = 40;
  // Past the limit what is repeated goes first: of a literal found nowhere else the reviewer
  // learns no more from the answer than from the search it saves.
  const hit = (e) => Number(e.elsewhere > 0 || e.count > 1);
  const kept = entries.length > limit ? [...entries].sort((a, b) => hit(b) - hit(a)).slice(0, limit) : entries;
  const shown = [...kept].sort((a, b) => a.lines[0] - b.lines[0])
    .map((e) => `${e.what} ${cut(e.shown)} L${e.lines.join(', L')} - ${e.count > 1 ? `${e.count}× w tym pliku, ` : ''}${same(e)}`);
  const listed = entries.length > limit ? `${shown.join('; ')} (+${entries.length - limit} dalszych - te wyszukaj sam)` : shown.join('; ');
  const against = tests ? 'z innymi testami oraz ze skryptami (bez testów)' : 'ze skryptami (bez testów)';
  // A value a spec repeats in its own cases is test data: the shape of the spec, not duplicated
  // logic - every High in a measured run was such a fixture literal, reported twice.
  const ownData = tests && entries.some((e) => e.count > 1)
    ? ' Powtórzenie w obrębie jednego specu to dane testowe: unit-tests#12 (Medium), nie code-quality#1.'
    : '';
  return `porównane ${against}, szablonami i bazowym plikiem tłumaczeń repozytorium: ${listed}.${ownData} ${limits}`;
}

// `input-binding`: where the routing setup turns on `withComponentInputBinding()`, and
// where code reads route parameters by hand (`ActivatedRoute`, `location.search`).
function inputBindingAnswer(index) {
  const hits = (re) => [...new Set(index.sourceScripts.flatMap((p) => {
    const scan = index.scans.get(p);
    return [...(scan.bare || scan.code).matchAll(re)].map((m) => `${short(p, index.root)}:${lineAt(scan.starts, m.index)}`);
  }))];
  const on = hits(/\bwithComponentInputBinding\s*\(/g);
  const manual = hits(/\binject\s*\(\s*ActivatedRoute\b|:\s*ActivatedRoute\b|\blocation\.search\b|\bnew\s+URLSearchParams\s*\(/g);
  return `withComponentInputBinding(): ${on.length > 0 ? list(on) : 'nie ma go w żadnym pliku repozytorium'}; parametry trasy czytane ręcznie (\`ActivatedRoute\`, \`location.search\`, \`URLSearchParams\`): ${manual.length > 0 ? list(manual) : 'nigdzie'}.`;
}

// ---------------------------------------------------------------------------------------
// Entry point

// `files`: project-relative path -> text of the reviewed revision (the universe the facts
// speak about); `reviewed`: the paths that get facts; `root`: the folder the universe was
// taken from ('' for the project root), for tsconfig and for shortening paths in texts.
function collectFacts({ files, reviewed, root = '' }) {
  const index = buildIndex(files, root);
  const facts = new Map();
  const crossLines = [];
  // A `hint` fact binds like a probe hit - the verdict answers its line - instead of
  // contradicting an OK outright.
  const add = (p, kind, lines, text, { hint = false } = {}) => {
    if (!reviewed.has(p)) return;
    if (!facts.has(p)) facts.set(p, []);
    const fact = { kind, lines: [...new Set(lines)].sort((a, b) => a - b), text };
    if (hint || hintKinds.has(kind)) fact.hint = true;
    facts.get(p).push(fact);
  };
  const cross = (text) => crossLines.push(text);
  // Everything the literal, condition and mapping passes compared, per reviewed file.
  const searched = new Map();
  // `detail` splits `elsewhere` for a test file: { tests, code }.
  const record = (p, what, lines, shown, elsewhere, detail) => {
    if (!reviewed.has(p)) return;
    if (!searched.has(p)) searched.set(p, []);
    searched.get(p).push({ what, lines: [...new Set(lines)].sort((a, b) => a - b), count: lines.length, shown, elsewhere, ...detail });
  };
  const list_ = localeFiles(index);
  const locales = { list: list_, base: localeBase(index, list_) };
  const exportsByFile = exportFacts(index, add, cross);
  i18nFacts(index, add, cross, locales);
  crossAreaFacts(index, add, cross);
  const occurrences = literalOccurrences(index, locales);
  literalFacts(index, add, cross, occurrences, record);
  conditionFacts(index, add, cross, record);
  mappingFacts(index, add, cross, record);
  layoutFacts(index, add, cross);
  barrelBypassFacts(index, add, cross);
  dtoCasingFacts(index, add, cross);
  injectionFacts(index, add, cross);
  stateKeyFacts(index, add);
  inputBindingFacts(index, add);
  searchRecords(index, occurrences, record, reviewed);
  stateFacts(index, add);
  actionFacts(index, add);
  specFacts(index, add);
  snapshotFacts(index, add);
  zoneFacts(index, add);
  stubFacts(index, add);
  enumFacts(index, add);
  projectorFacts(index, add);
  unconsumedActionFacts(index, add);
  importFacts(index, add);
  // Per reviewed file, the `builtinAnswers` texts: `repo-search` only for a file the literal
  // passes read (a script, a template, the base locale) or, against the other tests and the
  // code, a spec - of any other it would claim a search that never ran.
  const read = new Set([...index.sourceScripts, ...index.templates, locales.base].filter(Boolean));
  const binding = inputBindingAnswer(index);
  const layout = areaLayoutAnswer(index);
  const answers = new Map();
  for (const p of reviewed) {
    const own = {};
    if (read.has(p)) own['repo-search'] = repoSearchAnswer(searched.get(p) || []);
    else if (index.modules.has(p) && reSpec.test(p) && !reDeclaration.test(p)) own['repo-search'] = repoSearchAnswer(searched.get(p) || [], { tests: true });
    own['input-binding'] = binding;
    own['area-layout'] = layout(p);
    answers.set(p, own);
  }
  return {
    facts, exportsByFile, membersByFile: memberFacts(index, reviewed), specsByFile: specCases(index, reviewed),
    cross: crossLines, tsconfig: index.tsconfig, answers,
  };
}

module.exports = {
  factKinds, hintKinds, builtinProbes, builtinAnswers, isFactSource, scanScript, scanTemplate, parseJsonKeys, parseModule, loadTsconfig,
  makeResolver, functionUnits, compileProbe, runProbe, collectFacts, lineStarts, lineAt, areaOf,
};
