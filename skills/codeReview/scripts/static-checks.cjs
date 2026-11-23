'use strict';

// The static-check runner (references/static.md, "The runner"): settles the checklist items a
// linter can settle. Why: an item like "OnPush change detection" costs the walker a read of the
// whole file and is still missed now and then; ESLint answers it for certain in milliseconds.
//
// The engines are the REVIEWED PROJECT's (its node_modules), never ours: the plugin stays
// dependency-free and a missing engine, plugin or rule only leaves the item in the walk. The
// project's own ESLint config is NOT loaded - an overlay holding only the mapped rules runs, so
// the verdict does not depend on what the project happened to turn on.
//
// Pure parts (planFor, overlayConfig, mapMessages, inChange, globMatch) take literal inputs and
// are tested without ESLint; run() does the I/O around them.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const defaultMapPath = path.join(__dirname, '..', 'static', 'static-map.json');
const defaultPluginDohPath = path.join(__dirname, '..', 'static', 'eslint-plugin-doh.cjs');
// Windows caps a command line at ~8191 chars; leave room for node, eslint and the flags.
const maxCommandChars = 6000;
const reTs = /\.[cm]?tsx?$/;
const reHtml = /\.html?$/;
const reStyle = /\.(?:s?css|less)$/;

// Prefix -> package of the plugins we know by name; any other prefix tries the ESLint naming
// convention (eslint-plugin-<prefix>, @scope/eslint-plugin).
const knownPlugins = {
  '@angular-eslint': '@angular-eslint/eslint-plugin',
  '@angular-eslint/template': '@angular-eslint/eslint-plugin-template',
  '@typescript-eslint': '@typescript-eslint/eslint-plugin',
  '@ngrx': '@ngrx/eslint-plugin',
  'rxjs-x': 'eslint-plugin-rxjs-x',
  '@nx': '@nx/eslint-plugin',
  jest: 'eslint-plugin-jest',
};

// ---- small helpers ---------------------------------------------------------------------------

// Our own glob matcher: `**`, `*`, `?`, `{a,b}` over project-relative forward-slash paths. Kept
// local so the runner does not depend on rulebook.cjs being loaded in the same shape.
function globToRegExp(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { depth += 1; re += '(?:'; }
    else if (c === '}' && depth) { depth -= 1; re += ')'; }
    else if (c === ',' && depth) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function globMatch(pattern, p) { return globToRegExp(pattern).test(p); }
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const toPosix = (p) => String(p).replace(/\\/g, '/');

// "@angular-eslint/template/x" -> "@angular-eslint/template"; "no-console" -> "" (core).
function rulePrefix(ruleId) {
  const parts = ruleId.split('/');
  if (parts.length === 1) return '';
  if (ruleId.startsWith('@angular-eslint/template/')) return '@angular-eslint/template';
  return parts.slice(0, -1).join('/');
}
function pluginModule(prefix) {
  if (knownPlugins[prefix]) return knownPlugins[prefix];
  if (prefix.startsWith('@')) return prefix.includes('/') ? prefix : `${prefix}/eslint-plugin`;
  return `eslint-plugin-${prefix}`;
}
const isTemplateRule = (rule) => /^@angular-eslint\/template\/|^doh\/template-/.test(rule || '');

// The language an entry defaults to when it names no `files`.
function defaultLanguage(entry) {
  if (entry.engine === 'eslint') return isTemplateRule(entry.rule) ? reHtml : reTs;
  if (entry.engine === 'stylelint') return reStyle;
  return null;
}
function entryLabel(entry) {
  if (entry.rule) return entry.rule;
  if (entry.check) return entry.check;
  if (entry.selector) return 'no-restricted-syntax';
  if (entry.restrictedImport) return 'no-restricted-imports';
  return '?';
}
function normalizeItem(value) {
  if (Array.isArray(value)) return { partial: false, entries: value };
  return { partial: Boolean(value && value.partial), entries: (value && value.entries) || [] };
}

// ---- plan ------------------------------------------------------------------------------------

// Which entries apply to which file: the item must be walked by the file's kind, and the entry's
// `files` / `excludeFiles` / default language must take the path.
// -> [{ path, kind, entries: [{ id, address, partial, entry }] }]
function planFor({ files, map, kindItems }) {
  const items = (map && map.items) || {};
  return (files || []).map(({ path: p, kind }) => {
    const walked = new Set((kindItems && kindItems[kind]) || []);
    const entries = [];
    for (const address of Object.keys(items)) {
      if (!walked.has(address)) continue;
      const item = normalizeItem(items[address]);
      item.entries.forEach((entry, i) => {
        const only = asList(entry.files);
        if (only.length ? !only.some((g) => globMatch(g, p)) : !(defaultLanguage(entry) || /./).test(p)) return;
        if (asList(entry.excludeFiles).some((g) => globMatch(g, p))) return;
        entries.push({ id: `${address}@${i}`, address, partial: item.partial, entry });
      });
    }
    return { path: p, kind, entries };
  });
}

// ---- overlay ---------------------------------------------------------------------------------

// `available`: { core: Set|array of core rule names, plugins: { prefix: { module, rules: [...] } | null },
// parsers: { ts: bool, html: bool } }. Groups [{ files: [patterns], ignores?, entries }] -> config text.
// `typed`: the parserOptions that give the TS parser type information (`{ projectService: true }`
// or `{ project: ... }`), or null - then a `needsTypes` entry is skipped.
function buildOverlay(groups, { available, pluginDohPath, typed, projectRoot, sourceRoot, header, portable = false }) {
  const core = new Set(available.core || []);
  const plugins = available.plugins || {};
  const parsers = available.parsers || { ts: true, html: true };
  const skipped = [];
  const usedPrefixes = new Set();
  const blocks = [];
  const skip = (g, e, reason) => skipped.push({ id: e.id, address: e.address, engine: 'eslint', rule: entryLabel(e.entry), reason, paths: g.paths || null });
  const has = (ruleId) => {
    const prefix = rulePrefix(ruleId);
    if (!prefix) return core.has(ruleId) ? null : 'rule not found in ESLint core';
    const plugin = plugins[prefix];
    if (!plugin) return `plugin ${prefix === 'doh' ? 'doh' : pluginModule(prefix)} not installed`;
    return asList(plugin.rules).includes(ruleId.slice(prefix.length + 1)) ? null : 'rule not found in installed plugin';
  };
  const restrictedImportsRule = plugins['@typescript-eslint'] && asList(plugins['@typescript-eslint'].rules).includes('no-restricted-imports')
    ? '@typescript-eslint/no-restricted-imports' : 'no-restricted-imports';

  for (const g of groups) {
    const rules = {};
    const ruleOwner = {};
    const selectors = [];
    const importPaths = [];
    const importPatterns = [];
    for (const e of g.entries) {
      const { entry } = e;
      if (entry.needsTypes && !typed) { skip(g, e, 'needs type information'); continue; }
      if (entry.selector || entry.restrictedImport) {
        const prefix = `[doh:${e.address}] `;
        if (entry.selector) selectors.push({ selector: entry.selector, message: prefix + (entry.message || entry.selector) });
        else {
          const ri = entry.restrictedImport;
          const message = prefix + (entry.message || 'restricted import');
          if (ri.name) importPaths.push({ ...ri, message });
          else importPatterns.push({ ...ri, message });
        }
        continue;
      }
      const missing = has(entry.rule);
      if (missing) { skip(g, e, missing); continue; }
      const value = ['error', ...asList(entry.options)];
      if (rules[entry.rule]) {
        if (JSON.stringify(rules[entry.rule]) !== JSON.stringify(value)) skip(g, e, `rule ${entry.rule} already configured with other options by ${ruleOwner[entry.rule]}`);
        continue;
      }
      rules[entry.rule] = value;
      ruleOwner[entry.rule] = e.address;
      const prefix = rulePrefix(entry.rule);
      if (prefix) usedPrefixes.add(prefix);
    }
    if (selectors.length) rules['no-restricted-syntax'] = ['error', ...selectors];
    if (importPaths.length || importPatterns.length) {
      const opt = {};
      if (importPaths.length) opt.paths = importPaths;
      if (importPatterns.length) opt.patterns = importPatterns;
      rules[restrictedImportsRule] = ['error', opt];
      if (restrictedImportsRule.startsWith('@')) usedPrefixes.add('@typescript-eslint');
    }
    if (Object.keys(rules).length) blocks.push({ files: g.files, ignores: g.ignores, rules });
  }

  const lines = [];
  if (header) lines.push(header);
  lines.push("import { createRequire } from 'node:module';");
  // Anchored at the project root, so plugins resolve from its node_modules wherever this file is.
  // A preset lives in the project and is committed: it resolves from its own place, never from
  // the path of the machine that generated it.
  lines.push(portable ? 'const require = createRequire(import.meta.url);' : `const require = createRequire(${JSON.stringify(toPosix(path.join(projectRoot || '.', 'package.json')))});`);
  lines.push('const load = (m) => { const x = require(m); return x && x.default && x.default.rules ? x.default : x; };');
  const pluginLines = [...usedPrefixes].sort().map((prefix) => {
    const src = prefix === 'doh' ? `load(${JSON.stringify(portable ? './eslint-plugin-doh.cjs' : toPosix(pluginDohPath))})` : `load(${JSON.stringify(plugins[prefix].module || pluginModule(prefix))})`;
    return `  ${JSON.stringify(prefix)}: ${src},`;
  });
  lines.push(`const plugins = {\n${pluginLines.join('\n')}\n};`);
  lines.push('export default [');
  lines.push("  { linterOptions: { reportUnusedDisableDirectives: 'off' } },");
  if (parsers.ts) {
    const po = typed ? `, parserOptions: ${JSON.stringify({ ...typed, tsconfigRootDir: toPosix(sourceRoot || projectRoot || '.') })}` : '';
    lines.push(`  { files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'], languageOptions: { parser: require('@typescript-eslint/parser')${po} } },`);
  }
  if (parsers.html) lines.push("  { files: ['**/*.html', '**/*.htm'], languageOptions: { parser: require('@angular-eslint/template-parser') } },");
  for (const b of blocks) {
    const ign = b.ignores && b.ignores.length ? `, ignores: ${JSON.stringify(b.ignores)}` : '';
    lines.push(`  { files: ${JSON.stringify(b.files)}${ign}, plugins, rules: ${JSON.stringify(b.rules)} },`);
  }
  lines.push('];');
  return { text: `${lines.join('\n')}\n`, skipped };
}

// One config object per distinct set of entries, with explicit path lists, so each rule runs only
// where its entries apply. Returns { text, skipped: [{ id, address, engine, rule, reason, paths }] }.
// `typed` as in buildOverlay; `tsconfig` (a path) is the older spelling of `{ project: [tsconfig] }`.
function overlayConfig({ plan, available, pluginDohPath = defaultPluginDohPath, typed, tsconfig, projectRoot, sourceRoot }) {
  if (!typed && tsconfig) typed = { project: [toPosix(tsconfig)] };
  const parsers = (available && available.parsers) || { ts: true, html: true };
  const groups = new Map();
  const pre = [];
  for (const f of plan) {
    const eslint = f.entries.filter((e) => e.entry.engine === 'eslint');
    if (!eslint.length) continue;
    // A file whose parser is missing runs nothing: the parse would fail anyway.
    const parserMissing = (reHtml.test(f.path) && !parsers.html) || (reTs.test(f.path) && !parsers.ts);
    if (parserMissing) { for (const e of eslint) pre.push({ id: e.id, address: e.address, engine: 'eslint', rule: entryLabel(e.entry), reason: 'parser not installed', paths: [f.path] }); continue; }
    const key = eslint.map((e) => e.id).join('\n');
    if (!groups.has(key)) groups.set(key, { files: [], paths: [], entries: eslint });
    groups.get(key).files.push(f.path);
    groups.get(key).paths.push(f.path);
  }
  const out = buildOverlay([...groups.values()], { available: available || {}, pluginDohPath, typed, projectRoot, sourceRoot });
  return { text: out.text, skipped: [...pre, ...out.skipped] };
}

// ---- results -> document ---------------------------------------------------------------------

// Does [line, endLine] meet any changed range? `ranges` undefined = every line changed.
function inChange(line, endLine, ranges) {
  if (ranges == null) return true;
  const from = Number(line) || 1;
  const to = Math.max(from, Number(endLine) || from);
  return ranges.some(([a, b]) => from <= b && to >= a);
}

// Anywhere in the message: no-restricted-imports puts its own lead-in ("'x' import is restricted
// from being used.") before the custom message; the stored message keeps only what follows the tag.
const rePrefix = /\[doh:([^\]]+)\] /;

// `results`: ESLint's JSON ([{ filePath, messages: [{ ruleId, line, endLine, message, fatal }] }]),
// optionally with stylelint / builtin results converted to the same shape (a message may carry
// `entryId` to bind to one entry directly). `plan` entries with `ran === false` did not run.
// -> the document's `files` part.
function mapMessages(results, plan, changedLines, { sourceRoot } = {}) {
  const byPath = new Map();
  const root = sourceRoot ? toPosix(path.resolve(sourceRoot)).replace(/\/$/, '') : null;
  const norm = (fp) => {
    let p = toPosix(fp);
    if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) p = p.slice(root.length + 1);
    return p;
  };
  for (const r of results || []) {
    const p = norm(r.filePath || r.source || '');
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(...(r.messages || []));
  }
  const out = {};
  for (const f of plan) {
    const ranges = changedLines ? changedLines[f.path] : undefined;
    const doc = { decided: [], clean: {}, hits: [] };
    const ran = f.entries.filter((e) => e.ran !== false && !(f.notRun && f.notRun.has(e.id)));
    const hitIds = new Set();
    for (const m of byPath.get(f.path) || []) {
      if (m.fatal) { doc.error = String(m.message || 'parse error').slice(0, 300); continue; }
      const prefix = rePrefix.exec(m.message || '');
      let targets;
      if (m.entryId) targets = ran.filter((e) => e.id === m.entryId);
      else if (prefix) {
        const kind = /restricted-imports$/.test(m.ruleId || '') ? 'restrictedImport' : 'selector';
        targets = ran.filter((e) => e.address === prefix[1] && e.entry[kind]);
        // Several selector entries of one item share the prefix: bind to the one whose message it is.
        const exact = targets.filter((e) => (m.message.slice(prefix.index + prefix[0].length)) === (e.entry.message || e.entry.selector));
        if (exact.length) targets = exact.slice(0, 1);
      } else if (m.ruleId) {
        // `messageIds` narrows an entry to some of its rule's messages; without it every message of
        // the rule is credited to every entry mapping it (two items may share a rule on one file).
        targets = ran.filter((e) => e.entry.rule === m.ruleId && (!e.entry.messageIds || e.entry.messageIds.includes(m.messageId)));
      }
      else targets = [];
      for (const e of targets) {
        const hit = {
          address: e.address,
          level: e.entry.level,
          line: m.line || 1,
          endLine: m.endLine || m.line || 1,
          rule: m.ruleId || entryLabel(e.entry),
          message: prefix ? m.message.slice(prefix.index + prefix[0].length) : m.message,
          inChange: inChange(m.line, m.endLine, ranges),
        };
        doc.hits.push(hit);
        if (hit.inChange) hitIds.add(e.id);
      }
    }
    if (!doc.error) {
      const byItem = new Map();
      for (const e of f.entries) {
        if (!byItem.has(e.address)) byItem.set(e.address, []);
        byItem.get(e.address).push(e);
      }
      for (const [address, entries] of byItem) {
        if (entries[0].partial) {
          const clean = entries.filter((e) => ran.includes(e) && !hitIds.has(e.id)).map((e) => entryLabel(e.entry));
          if (clean.length) doc.clean[address] = [...new Set(clean)];
        } else {
          const decides = entries.filter((e) => e.entry.level === 'decides');
          if (decides.length && decides.every((e) => ran.includes(e))) doc.decided.push(address);
        }
      }
    }
    doc.hits.sort((a, b) => a.line - b.line);
    out[f.path] = doc;
  }
  return out;
}

// ---- I/O -------------------------------------------------------------------------------------

function lazy(file) {
  try { return fs.existsSync(file) ? require(file) : null; } catch { return null; }
}

// Load each plugin the plan names (through the project's resolution) and read its rule names.
function detectAvailable(projectRoot, prefixes, pluginDohPath) {
  const req = createRequire(path.join(projectRoot, 'package.json'));
  const tryLoad = (m) => { try { const x = req(m); return x && x.default && x.default.rules ? x.default : x; } catch { return null; } };
  const canResolve = (m) => { try { req.resolve(m); return true; } catch { return false; } };
  let core = [];
  try { core = [...req('eslint/use-at-your-own-risk').builtinRules.keys()]; } catch { /* no eslint */ }
  const plugins = {};
  for (const prefix of prefixes) {
    if (prefix === 'doh') {
      const p = fs.existsSync(pluginDohPath) ? lazy(pluginDohPath) : null;
      plugins.doh = p && p.rules ? { module: pluginDohPath, rules: Object.keys(p.rules) } : null;
      continue;
    }
    const module = pluginModule(prefix);
    const p = tryLoad(module);
    plugins[prefix] = p && p.rules ? { module, rules: Object.keys(p.rules) } : null;
  }
  return { core, plugins, parsers: { ts: canResolve('@typescript-eslint/parser'), html: canResolve('@angular-eslint/template-parser') } };
}

function chunks(paths, budget) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const p of paths) {
    if (cur.length && len + p.length + 3 > budget) { out.push(cur); cur = []; len = 0; }
    cur.push(p);
    len += p.length + 3;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Runs a linter's CLI per chunk of files; -> { results } or { error }. `timeoutMs` bounds the whole
// call, not one chunk. `okStatus`: the exit codes that mean "linted" (ESLint 0/1; stylelint 0/2).
// The JSON array is read from stdout, else from stderr (stylelint 16+ prints its formatter there).
function runCli(bin, args, paths, { cwd, timeoutMs, okStatus = [0, 1] }) {
  const results = [];
  const fixed = [process.execPath, bin, ...args].join(' ').length;
  const deadline = Date.now() + timeoutMs;
  const parse = (s) => { try { const j = JSON.parse(String(s || '').trim()); return Array.isArray(j) ? j : null; } catch { return null; } };
  for (const part of chunks(paths, Math.max(500, maxCommandChars - fixed))) {
    const left = deadline - Date.now();
    if (left <= 0) return { error: `timed out after ${Math.round(timeoutMs / 1000)} s` };
    const r = spawnSync(process.execPath, [bin, ...args, ...part], { cwd, encoding: 'utf8', timeout: left, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    if (r.error) return { error: /ETIMEDOUT/.test(r.error.code || r.error.message) ? `timed out after ${Math.round(timeoutMs / 1000)} s` : String(r.error.message).slice(0, 300) };
    const json = parse(r.stdout) || parse(r.stderr);
    if (!okStatus.includes(r.status) || !json) return { error: String(r.stderr || r.stdout || `exit ${r.status}`).slice(0, 300) };
    results.push(...json);
  }
  return { results };
}

const majorOf = (v) => Number(String(v || '').split('.')[0]) || 0;
function packageVersion(projectRoot, name) {
  try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version || null; } catch { return null; }
}

// The parserOptions that give `@typescript-eslint/parser` types for the files under `sourceRoot`,
// -> { typed } or { reason }. v8+: the project service (each file finds its own tsconfig, the way
// the editor does); v6/v7: `project: true` (the nearest tsconfig.json); older: the root tsconfig.json.
function typedParserOptions({ projectRoot, sourceRoot, tsconfig }) {
  if (tsconfig) return { typed: { project: [toPosix(tsconfig)] } };
  const version = packageVersion(projectRoot, '@typescript-eslint/parser');
  if (!version) return { reason: 'needs type information: @typescript-eslint/parser not installed' };
  if (majorOf(version) >= 8) return { typed: { projectService: true }, version };
  if (majorOf(version) >= 6) return { typed: { project: true }, version };
  const root = path.join(sourceRoot, 'tsconfig.json');
  return fs.existsSync(root) ? { typed: { project: [toPosix(root)] }, version } : { reason: 'needs type information: no tsconfig.json found' };
}

// A stylelint warning's text ends with " (<rule>)"; the hit keeps the words only.
const stripRuleSuffix = (text, rule) => String(text || '').replace(new RegExp(` \\(${String(rule).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\)$`), '');

function markNotRun(plan, skipped) {
  for (const s of skipped) {
    for (const f of plan) {
      if (s.paths && !s.paths.includes(f.path)) continue;
      if (!f.entries.some((e) => e.id === s.id)) continue;
      if (!f.notRun) f.notRun = new Set();
      f.notRun.add(s.id);
    }
  }
}

// Collapse per-file skip records into the document's list (one line per address+rule+reason).
function publicSkipped(skipped) {
  const seen = new Map();
  for (const s of skipped) {
    const key = `${s.address}\0${s.engine}\0${s.rule}\0${s.reason}`;
    if (!seen.has(key)) seen.set(key, { address: s.address, engine: s.engine, rule: s.rule, reason: s.reason });
  }
  return [...seen.values()];
}

// One ESLint invocation over `subPlan` (its entries only): overlay in the project's cache folder,
// removed afterwards. -> { results, skipped } or { error, skipped }.
function eslintPass({ subPlan, available, pluginDohPath, typed, projectRoot, sourceRoot, eslintBin, timeoutMs, tag }) {
  const overlay = overlayConfig({ plan: subPlan, available, pluginDohPath, typed, projectRoot, sourceRoot });
  const paths = [...new Set(subPlan.filter((f) => f.entries.length).map((f) => f.path))];
  if (!paths.length) return { results: [], skipped: overlay.skipped };
  const cacheDir = path.join(projectRoot, 'node_modules', '.cache', 'doh-static');
  const overlayPath = path.join(cacheDir, `overlay-${tag}-${process.pid}-${Date.now()}.mjs`);
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(overlayPath, overlay.text);
    const r = runCli(eslintBin, ['--no-config-lookup', '-c', overlayPath, '--format', 'json', '--no-error-on-unmatched-pattern', '--no-warn-ignored'], paths, { cwd: sourceRoot, timeoutMs });
    return { ...r, skipped: overlay.skipped };
  } finally {
    try { fs.rmSync(overlayPath, { force: true }); } catch { /* best effort */ }
  }
}

// `typed`: true = type-aware entries run (the caller vouches that `sourceRoot` is a complete tree
// with its tsconfigs and node_modules); `tsconfig` (a path) = the same with that one tsconfig.
// Type-aware entries run in an ESLint invocation of their own, bounded by `typedTimeoutMs`:
// whatever happens there only skips them, never the other entries.
function run({
  projectRoot, files, map, kindItems, changedLines = {}, sourceRoot, tsconfig, typed = false, timeoutMs = 120000, typedTimeoutMs = 240000,
  builtin, texts, patches = {}, pluginDohPath = defaultPluginDohPath,
}) {
  projectRoot = path.resolve(projectRoot);
  sourceRoot = path.resolve(sourceRoot || projectRoot);
  const plan = planFor({ files, map, kindItems });
  const engines = {};
  const skipped = [];
  const results = [];
  const of = (engine) => plan.flatMap((f) => f.entries.filter((e) => e.entry.engine === engine).map((e) => ({ f, e })));
  const notRunAll = (list, reason, engine) => { for (const { f, e } of list) skipped.push({ id: e.id, address: e.address, engine, rule: entryLabel(e.entry), reason, paths: [f.path] }); };
  const subPlan = (keep) => plan.map((f) => ({ path: f.path, kind: f.kind, entries: f.entries.filter(keep) }));

  // ESLint
  const eslintBin = path.join(projectRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const eslintEntries = of('eslint');
  if (!fs.existsSync(eslintBin)) {
    engines.eslint = { available: false, reason: 'not installed' };
    notRunAll(eslintEntries, 'eslint not installed', 'eslint');
  } else {
    engines.eslint = { available: true, version: packageVersion(projectRoot, 'eslint') };
    if (eslintEntries.length) {
      const prefixes = new Set(eslintEntries.map(({ e }) => (e.entry.rule ? rulePrefix(e.entry.rule) : '')).filter(Boolean));
      prefixes.add('@typescript-eslint');
      const available = detectAvailable(projectRoot, prefixes, pluginDohPath);
      const common = { available, pluginDohPath, projectRoot, sourceRoot, eslintBin };
      const isTyped = (e) => e.entry.engine === 'eslint' && Boolean(e.entry.needsTypes);
      const plain = eslintPass({ ...common, subPlan: subPlan((e) => e.entry.engine === 'eslint' && !isTyped(e)), typed: null, timeoutMs, tag: 'u' });
      skipped.push(...plain.skipped);
      if (plain.error) { engines.eslint.error = plain.error; notRunAll(eslintEntries.filter(({ e }) => !isTyped(e)), 'eslint failed', 'eslint'); } else results.push(...plain.results);

      const typedList = eslintEntries.filter(({ e }) => isTyped(e));
      if (typedList.length) {
        const opts = typed || tsconfig ? typedParserOptions({ projectRoot, sourceRoot, tsconfig }) : { reason: 'needs type information' };
        if (!opts.typed) notRunAll(typedList, opts.reason, 'eslint');
        else {
          const started = Date.now();
          const t = eslintPass({ ...common, subPlan: subPlan(isTyped), typed: opts.typed, timeoutMs: typedTimeoutMs, tag: 't' });
          skipped.push(...t.skipped);
          engines.eslint.typed = { mode: opts.typed.projectService ? 'projectService' : 'project', ms: Date.now() - started };
          if (t.error) { engines.eslint.typed.error = t.error; notRunAll(typedList, `type-aware eslint failed: ${t.error.slice(0, 120)}`, 'eslint'); } else {
            // A file the type-aware parse failed on (no tsconfig includes it...) loses only its
            // type-aware entries; the untyped run's verdict on it stands.
            for (const r of t.results) {
              const fatal = (r.messages || []).find((m) => m.fatal);
              const rel = toPosix(path.relative(sourceRoot, r.filePath || ''));
              if (!fatal) {
                // A rule that says it needs `strictNullChecks` (no-unnecessary-condition...) judges
                // nothing on a file whose tsconfig lacks it: its words there are no verdict.
                const blind = new Set((r.messages || []).filter((m) => /requires the `strictNullChecks` compiler option/.test(m.message || '')).map((m) => m.ruleId));
                if (blind.size) notRunAll(typedList.filter(({ f, e }) => f.path === rel && blind.has(e.entry.rule)), 'type-aware rule needs strictNullChecks', 'eslint');
                results.push({ ...r, messages: (r.messages || []).filter((m) => !blind.has(m.ruleId)) });
                continue;
              }
              const why = /not found by the project service|not included in|was not found in any of the provided project/i.test(fatal.message || '') ? 'the file is in no tsconfig' : String(fatal.message || '').slice(0, 120);
              notRunAll(typedList.filter(({ f }) => f.path === rel), `type-aware parse failed: ${why}`, 'eslint');
            }
          }
        }
      }
    }
  }

  // stylelint: one config for all style files (a rule has one setting per run); mapMessages binds
  // by rule per file. `.scss` needs postcss-scss: without it a `.scss` file's entries are skipped.
  const styleEntries = of('stylelint');
  const stylelintBin = ['stylelint.mjs', 'stylelint.js'].map((b) => path.join(projectRoot, 'node_modules', 'stylelint', 'bin', b)).find((b) => fs.existsSync(b));
  if (!stylelintBin) {
    engines.stylelint = { available: false, reason: 'not installed' };
    notRunAll(styleEntries, 'stylelint not installed', 'stylelint');
  } else {
    engines.stylelint = { available: true, version: packageVersion(projectRoot, 'stylelint') };
    let scssSyntax = null;
    try { scssSyntax = toPosix(createRequire(path.join(projectRoot, 'package.json')).resolve('postcss-scss')); } catch { /* not installed */ }
    const owners = [];
    const rules = {};
    for (const x of styleEntries) {
      const v = x.e.entry.options === undefined ? true : x.e.entry.options;
      if (/\.scss$/i.test(x.f.path) && !scssSyntax) notRunAll([x], 'postcss-scss not installed (needed for .scss)', 'stylelint');
      else if (rules[x.e.entry.rule] !== undefined && JSON.stringify(rules[x.e.entry.rule]) !== JSON.stringify(v)) notRunAll([x], 'rule already configured with other options', 'stylelint');
      else { rules[x.e.entry.rule] = v; owners.push(x); }
    }
    if (owners.length) {
      const config = { rules };
      if (scssSyntax) config.overrides = [{ files: ['**/*.scss'], customSyntax: scssSyntax }];
      const cacheDir = path.join(projectRoot, 'node_modules', '.cache', 'doh-static');
      const cfgPath = path.join(cacheDir, `stylelint-${process.pid}-${Date.now()}.json`);
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(config));
        // Exit 2 = problems found (0 = none); the json formatter writes to stdout (15) or stderr (16+).
        const r = runCli(stylelintBin, ['--formatter', 'json', '--config', cfgPath, '--allow-empty-input'], [...new Set(owners.map(({ f }) => f.path))], { cwd: sourceRoot, timeoutMs, okStatus: [0, 2] });
        if (r.error) { engines.stylelint.error = r.error; notRunAll(owners, 'stylelint failed', 'stylelint'); } else {
          // An unknown rule comes back as a warning "Unknown rule x." and a bad option as an
          // invalidOptionWarning: that rule did not run - its entries are skipped, its words no hit.
          const broken = new Map();
          for (const s of r.results) {
            for (const w of s.warnings || []) if (/^Unknown rule /.test(w.text || '')) broken.set(w.rule, 'rule not found in installed stylelint');
            for (const w of s.invalidOptionWarnings || []) { const m = /for rule "([^"]+)"/.exec(w.text || ''); if (m) broken.set(m[1], `invalid options: ${w.text}`); }
          }
          for (const x of owners) if (broken.has(x.e.entry.rule)) notRunAll([x], broken.get(x.e.entry.rule), 'stylelint');
          for (const s of r.results) {
            const messages = (s.warnings || []).filter((w) => !broken.has(w.rule))
              .map((w) => ({ ruleId: w.rule, line: w.line, endLine: w.endLine, message: stripRuleSuffix(w.text, w.rule), fatal: w.rule === 'CssSyntaxError' }));
            for (const p of s.parseErrors || []) messages.push({ fatal: true, line: p.line, message: p.text });
            results.push({ filePath: s.source, messages });
          }
        }
      } finally {
        try { fs.rmSync(cfgPath, { force: true }); } catch { /* best effort */ }
      }
    }
  }

  // Builtin checks
  const checks = builtin || ((lazy(path.join(__dirname, 'static-builtin.cjs')) || {}).checks) || {};
  engines.builtin = { available: true };
  for (const { f, e } of of('builtin')) {
    const fn = checks[e.entry.check];
    if (typeof fn !== 'function') { skipped.push({ id: e.id, address: e.address, engine: 'builtin', rule: e.entry.check, reason: 'unknown builtin check', paths: [f.path] }); continue; }
    let text = texts && texts.get(f.path);
    if (text == null) { try { text = fs.readFileSync(path.join(sourceRoot, f.path), 'utf8'); } catch { text = null; } }
    let found = null;
    try { found = text == null ? null : fn({ file: f.path, text, kind: f.kind, files: texts || new Map([[f.path, text]]), changedLines: changedLines[f.path], patch: patches[f.path] }); } catch (err) {
      skipped.push({ id: e.id, address: e.address, engine: 'builtin', rule: e.entry.check, reason: `check threw: ${String(err.message).slice(0, 200)}`, paths: [f.path] });
      continue;
    }
    if (!Array.isArray(found)) { if (!f.notRun) f.notRun = new Set(); f.notRun.add(e.id); continue; }
    results.push({ filePath: f.path, messages: found.map((h) => ({ entryId: e.id, ruleId: e.entry.check, line: h.line, endLine: h.endLine, message: h.message })) });
  }

  markNotRun(plan, skipped);
  return { version: 1, engines, skipped: publicSkipped(skipped), files: mapMessages(results, plan, changedLines, { sourceRoot }) };
}

// ---- project preset (--emit-config) ---------------------------------------------------------

function emitConfig({ projectRoot, map, pluginDohPath = defaultPluginDohPath }) {
  projectRoot = path.resolve(projectRoot);
  const groups = [];
  const prefixes = new Set(['@typescript-eslint']);
  for (const [address, value] of Object.entries((map && map.items) || {})) {
    normalizeItem(value).entries.forEach((entry, i) => {
      if (entry.engine !== 'eslint') return;
      if (entry.rule && rulePrefix(entry.rule)) prefixes.add(rulePrefix(entry.rule));
      const files = asList(entry.files).length ? asList(entry.files) : [isTemplateRule(entry.rule) ? '**/*.html' : '**/*.ts'];
      groups.push({ files, ignores: asList(entry.excludeFiles), entries: [{ id: `${address}@${i}`, address, entry }] });
    });
  }
  const available = detectAvailable(projectRoot, prefixes, pluginDohPath);
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || version; } catch { /* no manifest */ }
  const header = `// GENERATED by the doh plugin ${version} (skills/codeReview/scripts/static-checks.cjs --emit-config).\n// The rules the doh code review checks statically; regenerate instead of editing.`;
  // Type-aware entries need the project's own parserOptions; the preset leaves them out.
  return buildOverlay(groups, { available, pluginDohPath, projectRoot, header, portable: true });
}

// ---- CLI -------------------------------------------------------------------------------------

function main(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m && (m[1] === 'project' || m[1] === 'input' || m[1] === 'out' || m[1] === 'emit-config')) args[m[1]] = m[2];
  }
  if (!args.project) { process.stderr.write('usage: static-checks.cjs --project=<dir> (--input=<json> --out=<file> | --emit-config=<path>)\n'); return 2; }
  if (args['emit-config']) {
    const input = args.input ? JSON.parse(fs.readFileSync(args.input, 'utf8')) : {};
    const map = JSON.parse(fs.readFileSync(path.resolve(input.mapPath || defaultMapPath), 'utf8'));
    const out = emitConfig({ projectRoot: args.project, map });
    fs.writeFileSync(args['emit-config'], out.text);
    // The plugin's own rules travel with the preset: the plugin cache path changes with every version.
    if (/["']doh["']:/.test(out.text) && fs.existsSync(defaultPluginDohPath)) fs.copyFileSync(defaultPluginDohPath, path.join(path.dirname(path.resolve(args['emit-config'])), 'eslint-plugin-doh.cjs'));
    for (const s of publicSkipped(out.skipped)) process.stderr.write(`skipped ${s.address} ${s.rule}: ${s.reason}\n`);
    return 0;
  }
  if (!args.input || !args.out) { process.stderr.write('--input and --out are required\n'); return 2; }
  const input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const map = JSON.parse(fs.readFileSync(path.resolve(input.mapPath || defaultMapPath), 'utf8'));
  const doc = run({ ...input, map, projectRoot: args.project });
  fs.writeFileSync(args.out, `${JSON.stringify(doc, null, 2)}\n`);
  return 0;
}

module.exports = { planFor, overlayConfig, mapMessages, inChange, run, emitConfig, globMatch, rulePrefix, pluginModule, detectAvailable, chunks, typedParserOptions };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
