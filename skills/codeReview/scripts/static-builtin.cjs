'use strict';

// Builtin static checks: the checklist items a script settles without a model and without the
// reviewed project's ESLint or stylelint - file locations and names, the shape of a models
// barrel, translation keys, config flags turned off, SCSS the projects often run no stylelint
// over, secrets on added lines. static-checks.cjs calls them for the map's `builtin` entries
// (references/static.md is the contract).
//
// Every check is a pure function of `{ file, text, kind, files, changedLines, patch }`:
// `files` is a Map path -> text of the reviewed revision (`files.partial === true` when it is
// not the whole tree), `changedLines` the file's 1-based inclusive ranges (absent = every line
// changed), `patch` its unified diff. A check returns `[{ line, endLine?, message }]`, or `null`
// when it could not run. Each one is narrow on purpose: a `decides` check that is wrong closes or
// fails an item on its own, and a check that is wrong often teaches people to ignore the rest.

// --- helpers -----------------------------------------------------------------------------

const norm = (p) => String(p || '').replace(/\\/g, '/');
// A library keeps its code under `src/lib/` (Nx/ng-packagr): for the layout rules that folder is
// transparent, `libs/x/data-access/src/lib/+state/a.actions.ts` lies in `data-access/+state/`.
const layoutPath = (p) => norm(p).replace(/\/src\/lib\//g, '/').replace(/\/src\/(?=[^/]+$)/, '/');
// Workspace files a library folder carries; never subject to the layout rules.
const reInfraFile = /(?:^|\/)(?:package\.json|ng-package\.json|project\.json|tsconfig[^/]*\.json|jest\.config\.[cm]?[jt]s|test-setup\.ts|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|README\.md)$/;
const dirOf = (p) => { const n = norm(p); const i = n.lastIndexOf('/'); return i < 0 ? '' : n.slice(0, i); };
const baseOf = (p) => { const n = norm(p); return n.slice(n.lastIndexOf('/') + 1); };
const join = (d, b) => (d ? `${d}/${b}` : b);
const reSpec = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const reMockPath = /(?:^|\/)(?:mocks?|__mocks__|fixtures?)\/|\.(?:mock|mocks|fixture|fixtures|stub)\.[cm]?[jt]s$/;
const pascal = (kebab) => kebab.split(/[-_]/).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join('');
const lineAt = (text, index) => { let n = 1; for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1; return n; };
const hasFile = (files, p) => !!files && typeof files.has === 'function' && files.has(p);
const keysOf = (files) => (files && typeof files.keys === 'function' ? [...files.keys()].map(norm) : []);

// The lines a unified patch adds, with their numbers in the new file; removed lines carry the
// new-file line they sat before.
function patchLines(patch) {
  const added = [];
  const removed = [];
  let at = 0;
  let inHunk = false;
  for (const line of String(patch || '').split(/\r?\n/)) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { at = Number(hunk[1]); inHunk = true; continue; }
    if (line.startsWith('diff --git')) { inHunk = false; continue; }
    if (!inHunk || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) { added.push({ line: at, text: line.slice(1) }); at += 1; } else if (line.startsWith('-')) removed.push({ line: Math.max(at, 1), text: line.slice(1) }); else if (line.startsWith(' ')) at += 1;
  }
  return { added, removed };
}

// Lines the change added: from the patch, else the changed ranges, else (an added file) all.
function addedLineSet(text, changedLines, patch) {
  if (patch) return new Set(patchLines(patch).added.map((a) => a.line));
  const count = String(text || '').split(/\r?\n/).length;
  const set = new Set();
  if (!Array.isArray(changedLines)) { for (let i = 1; i <= count; i += 1) set.add(i); return set; }
  for (const [from, to] of changedLines) for (let i = from; i <= to; i += 1) set.add(i);
  return set;
}

// Comments and string contents replaced by spaces, newlines kept: line numbers survive and a
// keyword inside a string or a comment never matches. Good enough for TS and SCSS.
function mask(text, { lineComments = true, strings = true } = {}) {
  const s = String(text || '');
  let out = '';
  let i = 0;
  const blank = (ch) => (ch === '\n' || ch === '\r' ? ch : ' ');
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '/' && n === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end < 0 ? s.length : end + 2;
      for (; i < stop; i += 1) out += blank(s[i]);
      continue;
    }
    if (lineComments && c === '/' && n === '/' && s[i - 1] !== ':') {
      for (; i < s.length && s[i] !== '\n'; i += 1) out += ' ';
      continue;
    }
    if (strings && (c === '"' || c === "'" || c === '`')) {
      out += c;
      i += 1;
      for (; i < s.length && s[i] !== c; i += 1) {
        if (s[i] === '\\') { out += ' '; i += 1; out += blank(s[i] || ''); continue; }
        if (s[i] === '\n' && c !== '`') break;
        out += blank(s[i]);
      }
      if (i < s.length) { out += s[i]; i += 1; }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const one = (message, line = 1) => [{ line, message }];

// --- paths and structure ------------------------------------------------------------------

// A util, pipe, guard, directive or interceptor has its spec in the sibling `tests/` folder.
const reSpecOwner = /\.(?:util|pipe|guard|directive|interceptor)\.ts$/;
function specExists({ file, files }) {
  {
    const p = norm(file);
    if (!reSpecOwner.test(p) || reSpec.test(p) || /(?:^|\/)tests\//.test(p)) return [];
    const expected = join(dirOf(p), `tests/${baseOf(p).replace(/\.ts$/, '.spec.ts')}`);
    if (hasFile(files, expected)) return [];
    if (files && files.partial === true) return null;
    return one(`no spec at \`${expected}\` - every ${baseOf(p).split('.').slice(-2, -1)[0]} has its spec in the sibling \`tests/\` folder`);
  }
}

// A spec whose very existence is the finding: of a routes file, of translation JSON, of an
// HTTP service (the last one has an exception - a service that transforms data).
function specForbidden({ file, kind, text }) {
  const p = norm(file);
  if (kind === 'routes-spec' || /\.routes\.spec\.ts$/.test(p)) return one('a spec of a routes file - route files get no unit specs (lazy loading is verified by the build)');
  if (kind === 'i18n-spec' || (reSpec.test(p) && /(?:^|\/)(?:i18n|locales?|translations?)(?:\/|\.)/.test(p) && /\.json['"]/.test(text || ''))) return one('a spec over translation JSON - translation files get no unit tests');
  if (kind === 'data-access-service-spec' || /\/data-access\/services\/(?:.*\/)?[^/]+\.service\.spec\.ts$/.test(p)) return one('a spec of an HTTP service - a service that only wraps HTTP calls gets no spec (it is covered through the stores and effects that call it)');
  return [];
}

// A spec in a `tests/` folder next to the code; a snapshot in `tests/__snapshots__/`.
function specLocation({ file, kind }) {
  const p = norm(file);
  if (kind === 'e2e-spec' || /(?:^|\/)(?:e2e|cypress|playwright)(?:\/|$)/.test(p)) return [];
  const parts = p.split('/');
  if (/\.snap$/.test(p)) {
    if (parts[parts.length - 2] === '__snapshots__' && parts[parts.length - 3] === 'tests') return [];
    return one('a snapshot outside `tests/__snapshots__/` - snapshots live in `tests/__snapshots__/` next to their spec');
  }
  if (!/\.spec\.ts$/.test(p)) return [];
  if (parts[parts.length - 2] === 'tests') return [];
  return one(`spec \`${baseOf(p)}\` lies in \`${parts[parts.length - 2] || '.'}/\` - specs live in a \`tests/\` folder next to the code under test`);
}

const reComponentFile = /(?:^|\/)components-[^/]+\/(feature|ui)\/([^/]+)\/([^/]+)\.component\.(ts|html|scss)$/;
function componentNaming({ file, text }) {
  const m = norm(file).match(reComponentFile);
  if (!m) return [];
  const [, layer, folder, name, ext] = m;
  const out = [];
  if (!folder.startsWith(`${layer}-`)) out.push({ line: 1, message: `folder \`${folder}/\` under \`${layer}/\` - expected \`${layer}-<segment>/\`` });
  if (name !== folder) out.push({ line: 1, message: `file \`${name}.component.${ext}\` in folder \`${folder}/\` - expected \`${folder}.component.${ext}\`` });
  if (ext !== 'ts' || !folder.startsWith(`${layer}-`)) return out;
  const raw = String(text || '');
  const masked = mask(raw, { strings: false });
  const cls = masked.match(/export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/);
  const expectedClass = `${pascal(folder)}Component`;
  if (cls && cls[1] !== expectedClass) out.push({ line: lineAt(masked, cls.index), message: `class \`${cls[1]}\` - expected \`${expectedClass}\` for folder \`${folder}/\`` });
  const sel = raw.match(/@Component\s*\(\s*\{[\s\S]*?\bselector\s*:\s*['"`]([^'"`]+)['"`]/);
  if (sel && !sel[1].endsWith(`-${folder}`) && sel[1] !== folder) out.push({ line: lineAt(raw, sel.index + sel[0].length - sel[1].length - 1), message: `selector \`${sel[1]}\` - expected \`<app-prefix>-${folder}\`` });
  return out;
}

function componentFolderContents({ file }) {
  const p = layoutPath(file);
  // Library scaffolding, and a spec outside `tests/` (spec-location's finding, not this one's).
  if (reInfraFile.test(p) || baseOf(p) === 'index.ts' || reSpec.test(p) || /\.snap$/.test(p)) return [];
  // A `feature/` or `ui/` folder that is a library of its own has the library's layout inside.
  if (/\/components-[^/]+\/(?:feature|ui)\/src\//.test(norm(file))) return [];
  const m = p.match(/(?:^|\/)components-[^/]+\/(feature|ui)\/(.+)$/);
  if (!m) return [];
  const rest = m[2];
  const segs = rest.split('/');
  const isComponent = /\.component\.(?:ts|html|scss)$/.test(segs[segs.length - 1]);
  if (segs.length === 1) {
    return isComponent ? one(`\`${rest}\` lies directly in \`${m[1]}/\` - a component owns a folder named after it`) : one(`\`${rest}\` in \`${m[1]}/\` - only component folders belong there`);
  }
  if (segs.includes('tests')) return [];
  if (isComponent) return [];
  return one(`\`${segs[segs.length - 1]}\` in a component folder - only \`*.component.{ts,html,scss}\` files and a \`tests/\` folder may be there (models, utils and consts go to their layer)`);
}

// An `index.ts` is a barrel; allowed in `models/` and as a library's public entry point.
const reLibMarker = /^(?:package\.json|ng-package\.json|project\.json|public-api\.ts|public_api\.ts)$/;
function barrelForbidden({ file, files }) {
  const p = norm(file);
  if (baseOf(p) !== 'index.ts') return [];
  const dir = dirOf(p);
  if (baseOf(dir) === 'models') return [];
  if (!files || files.partial === true) return null;
  const all = keysOf(files);
  const siblings = new Set(all.filter((k) => dirOf(k) === dir).map(baseOf));
  if ([...siblings].some((b) => reLibMarker.test(b))) return [];
  if (baseOf(dir) === 'src') {
    const root = dirOf(dir);
    if (all.some((k) => dirOf(k) === root && reLibMarker.test(baseOf(k)))) return [];
  }
  // A tsconfig path alias naming this file makes it an entry consumers import from.
  for (const k of all) {
    if (!/(?:^|\/)tsconfig[^/]*\.json$/.test(k)) continue;
    const t = String(files.get(k) || files.get(k.replace(/\//g, '\\')) || '');
    if (t.includes(p) || t.includes(`${dir}"`) || t.includes(`${dir}/"`)) return [];
  }
  return one('a barrel `index.ts` outside `models/` - consumers import the concrete file');
}

function utilFileName({ file }) {
  const p = layoutPath(file);
  if (reInfraFile.test(p) ||!/(?:^|\/)shared\/utils\//.test(p) || !/\.ts$/.test(p) || reSpec.test(p) || /(?:^|\/)tests\//.test(p) || baseOf(p) === 'index.ts') return [];
  if (/\.utils\.ts$/.test(p)) return one(`\`${baseOf(p)}\` - util files are singular \`.util.ts\``);
  if (!/\.util\.ts$/.test(p)) return one(`\`${baseOf(p)}\` under \`shared/utils/\` - expected \`<verb>-<subject>.util.ts\``);
  return [];
}

const modelSuffix = { consts: '.const.ts', enums: '.enum.ts', interfaces: '.interface.ts', types: '.type.ts' };
function modelsFileSuffix({ file }) {
  const p = norm(file);
  const m = p.match(/(?:^|\/)models\/(consts|enums|interfaces|types)\/(?:.*\/)?([^/]+\.ts)$/);
  if (!m || reSpec.test(p) || /(?:^|\/)tests\//.test(p) || m[2] === 'index.ts') return [];
  if (m[2].endsWith(modelSuffix[m[1]])) return [];
  return one(`\`${m[2]}\` in \`models/${m[1]}/\` - expected the \`${modelSuffix[m[1]]}\` suffix`);
}

function modelsDeclarative({ file, text }) {
  const p = norm(file);
  if (!/(?:^|\/)models\//.test(p) || !/\.ts$/.test(p) || reSpec.test(p) || baseOf(p) === 'index.ts' || /(?:^|\/)tests\//.test(p)) return [];
  const isConst = /\.const\.ts$/.test(p);
  const lines = mask(text).split('\n');
  const out = [];
  let depth = 0;
  lines.forEach((l, i) => {
    if (depth === 0) {
      if (/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\b|class\s)/.test(l)) out.push({ line: i + 1, message: 'a function or class in a models file - models hold only `export interface/type/enum/const` (functions go to `shared/utils/`)' });
      else if (/^\s*@(?:Injectable|Component|Directive|Pipe|NgModule)\b/.test(l)) out.push({ line: i + 1, message: 'a decorated class in a models file - models are purely declarative' });
      else if (/^\s*(?:export\s+)?(?:const|let)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::\s*[^=]+)?=>|[\w$]+\s*=>)/.test(l)) out.push({ line: i + 1, message: 'a function assigned to a const in a models file - functions go to `shared/utils/`' });
      else if (isConst && /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\s+[\w$]|type\s+[\w$]+\s*(?:<[^=]*>)?\s*=|(?:const\s+)?enum\s+[\w$])/.test(l)) out.push({ line: i + 1, message: 'an interface, type or enum in a `.const.ts` file - it goes to its own `.interface.ts`/`.type.ts`/`.enum.ts` file' });
    }
    for (const ch of l) { if (ch === '{' || ch === '(' || ch === '[') depth += 1; else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1); }
  });
  return out;
}

function modelsBarrelShape({ file, text, files }) {
  const p = norm(file);
  if (!/(?:^|\/)models\/index\.ts$/.test(p)) return [];
  if (!files || files.partial === true) return null;
  const dir = dirOf(p);
  const out = [];
  const targets = [];
  let inBlock = false;
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    const t = l.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
    if (!t || t.startsWith('//')) return;
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
    const m = t.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?$/);
    if (m) { targets.push(m[1]); return; }
    out.push({ line: i + 1, message: 'a line other than `export * from \'...\'` in the models barrel - it holds no declarations or named re-exports' });
  });
  const resolved = targets.filter((t) => t.startsWith('.')).map((t) => {
    const segs = [];
    for (const s of `${dir}/${t}`.split('/')) { if (s === '.' || s === '') continue; if (s === '..') segs.pop(); else segs.push(s); }
    return segs.join('/').replace(/\.ts$/, '');
  });
  const lead = p.startsWith('/') ? '/' : '';
  for (const k of keysOf(files)) {
    if (!k.startsWith(`${dir}/`) || !/\.ts$/.test(k) || k === p || reSpec.test(k) || /\/(?:tests|mocks)\//.test(k.slice(dir.length)) || /\.d\.ts$/.test(k)) continue;
    const bare = k.replace(/\.ts$/, '').replace(/^\//, '');
    const covered = resolved.some((r) => { const rr = r.replace(/^\//, ''); return bare === rr || bare === `${rr}/index` || bare.startsWith(`${rr}/`); });
    if (!covered) out.push({ line: 1, message: `\`${lead}${k.slice(dir.length + 1)}\` is not exported by the models barrel - it lists every model file` });
  }
  return out;
}

const reStateFile = /\.(?:store|actions|reducer|selectors|effects|facade)\.ts$/;
function stateFileLocation({ file }) {
  const p = norm(file);
  if (!reStateFile.test(p) || reSpec.test(p)) return [];
  // One slice per subfolder of `+state/` is a common split, and not what the item is about.
  if (/(?:^|\/)data-access\/(?:[^/]+\/)?\+state\//.test(layoutPath(p))) return [];
  return one(`state file \`${baseOf(p)}\` in \`${dirOf(p) || '.'}/\` - expected \`<area>/data-access/+state/\``);
}

function serviceFileLocation({ file, text, kind }) {
  const p = norm(file);
  if (!/\.service\.ts$/.test(p) || reSpec.test(p)) return [];
  // Only an HTTP service: other services (app-level, UI helpers) have no such home.
  if (kind !== 'data-access-service' && !/\bHttpClient\b/.test(mask(text))) return [];
  if (/(?:^|\/)data-access\/(?:[^/]+\/)?services\/[^/]+$/.test(layoutPath(p))) return [];
  return one(`HTTP service \`${baseOf(p)}\` in \`${dirOf(p) || '.'}/\` - expected \`<area>/data-access/services/\``);
}

function guardFileLocation({ file }) {
  const p = norm(file);
  if (!/\.guard\.ts$/.test(p) || reSpec.test(p)) return [];
  if (/(?:^|\/)shared\/guards\/(?:[^/]+\/)?[^/]+$/.test(layoutPath(p))) return [];
  return one(`guard \`${baseOf(p)}\` in \`${dirOf(p) || '.'}/\` - expected \`shared/guards/<predicate>.guard.ts\``);
}

// Inside a feature area: the path runs through an area layer, or a folder above it holds the
// area layers (`data-access/`, `components-*`) - an `<area>/shared/interceptors/` included.
function interceptorLocation({ file, files }) {
  const p = norm(file);
  if (!/\.interceptor\.ts$/.test(p) || reSpec.test(p)) return [];
  if (/(?:^|\/)(?:data-access|\+state|models|components-[^/]+)\//.test(p)) return one('an interceptor inside a feature area - interceptors are app-level');
  const segs = p.split('/');
  const sharedAt = segs.lastIndexOf('shared');
  if (sharedAt > 0 && files && files.partial !== true) {
    const area = segs.slice(0, sharedAt).join('/');
    // The app root may hold data-access of its own; an area is a folder below `app/`.
    if (baseOf(area) !== 'app' && keysOf(files).some((k) => k.startsWith(`${area}/data-access/`) || k.startsWith(`${area}/components-`))) return one(`an interceptor inside feature area \`${area}/\` - interceptors are app-level`);
  }
  return [];
}

// --- translations -------------------------------------------------------------------------

// Every key of a JSON file with its dotted path, line and string value (if a string).
function jsonEntries(text) {
  const s = String(text || '');
  const out = [];
  const stack = [];
  let line = 1;
  let pendingKey = null;
  let i = 0;
  const readString = () => {
    let v = '';
    i += 1;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') { const e = s[i + 1]; v += e === 'n' ? '\n' : e === 't' ? '\t' : e; i += 2; continue; }
      if (s[i] === '\n') line += 1;
      v += s[i]; i += 1;
    }
    i += 1;
    return v;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === '"') {
      const startLine = line;
      const v = readString();
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j += 1;
      const top = stack[stack.length - 1];
      if (s[j] === ':' && top && top.type === 'obj') { pendingKey = { key: v, line: startLine }; continue; }
      if (pendingKey) { out.push({ path: [...stack.filter((x) => x.key != null).map((x) => x.key), pendingKey.key].join('.'), key: pendingKey.key, line: pendingKey.line, value: v }); pendingKey = null; }
      continue;
    }
    if (c === '{' || c === '[') {
      if (pendingKey) out.push({ path: [...stack.filter((x) => x.key != null).map((x) => x.key), pendingKey.key].join('.'), key: pendingKey.key, line: pendingKey.line, value: null });
      stack.push({ type: c === '{' ? 'obj' : 'arr', key: pendingKey ? pendingKey.key : null });
      pendingKey = null;
      i += 1;
      continue;
    }
    if (c === '}' || c === ']') { stack.pop(); i += 1; continue; }
    if (pendingKey && /[-\w]/.test(c)) { out.push({ path: [...stack.filter((x) => x.key != null).map((x) => x.key), pendingKey.key].join('.'), key: pendingKey.key, line: pendingKey.line, value: null }); pendingKey = null; }
    i += 1;
  }
  return out;
}

const isI18nSource = (file, kind) => kind === 'i18n-source' || (!kind && /(?:^|\/)(?:i18n|locales?|translations?)\/(?:.*\/)?en\.json$/.test(norm(file)));

function i18nKeyShape({ file, kind, text, changedLines, patch }) {
  if (!isI18nSource(file, kind)) return [];
  const entries = jsonEntries(text);
  const added = addedLineSet(text, changedLines, patch);
  const leaves = (root) => entries.filter((e) => e.value !== null && e.path.split('.')[0] === root).length;
  const page = leaves('page');
  const pages = leaves('pages');
  const out = [];
  for (const e of entries) {
    if (!added.has(e.line)) continue;
    const root = e.path.split('.')[0];
    if (page && pages && (root === 'page' || root === 'pages') && e.path === root) {
      const other = root === 'page' ? 'pages' : 'page';
      out.push({ line: e.line, message: `\`${root}\` root added while \`${other}\` exists - the base file keeps one page root` });
    } else if (page && pages && (root === 'page' || root === 'pages') && e.value !== null) {
      const mine = root === 'page' ? page : pages;
      const theirs = root === 'page' ? pages : page;
      if (mine < theirs) out.push({ line: e.line, message: `key \`${e.path}\` under \`${root}\` while the base file mostly uses \`${root === 'page' ? 'pages' : 'page'}\` - one page root, never both` });
    }
    // An ALL_CAPS key mirrors a backend enum value the code looks up by value - a convention of its own.
    if (e.value !== null && !/^[a-z][a-zA-Z0-9]*$/.test(e.key) && !/^[A-Z0-9_/\s-]+$/.test(e.key)) out.push({ line: e.line, message: `leaf \`${e.key}\` is not camelCase` });
  }
  return out;
}

function i18nLeafSuffix({ file, kind, text, changedLines, patch }) {
  if (!isI18nSource(file, kind)) return [];
  const entries = jsonEntries(text).filter((e) => typeof e.value === 'string');
  const added = addedLineSet(text, changedLines, patch);
  const byValue = new Map();
  for (const e of entries) if (!/AriaLabel$/.test(e.key)) byValue.set(e.value.trim().toLowerCase(), e.path);
  const out = [];
  for (const e of entries) {
    if (!added.has(e.line)) continue;
    if (/AriaLabel$/.test(e.key) && byValue.has(e.value.trim().toLowerCase())) out.push({ line: e.line, message: `\`${e.key}\` repeats the text of \`${byValue.get(e.value.trim().toLowerCase())}\` - an accessible name that repeats a visible label references the label's key` });
    else if (/(?:Msg|Err|Ttip|Desc|Lbl|Aria|ariaLabel|Arialabel|Tooltips|Hints)$/.test(e.key) && !/^aria$/i.test(e.key)) out.push({ line: e.line, message: `leaf \`${e.key}\` - suffixes are spelled out (\`…Message\`, \`…Tooltip\`, \`…Description\`, \`…AriaLabel\`, ...)` });
  }
  return out;
}

function i18nValueStyle({ file, kind, text, changedLines, patch }) {
  if (!isI18nSource(file, kind)) return [];
  const added = addedLineSet(text, changedLines, patch);
  const out = [];
  for (const e of jsonEntries(text)) {
    if (typeof e.value !== 'string' || !added.has(e.line)) continue;
    const v = e.value.trim();
    const spaced = v.match(/\{\{\s+[\w.]+\s*\}\}|\{\{\s*[\w.]+\s+\}\}/);
    if (spaced) out.push({ line: e.line, message: `interpolation \`${spaced[0]}\` - written \`{{paramName}}\` without spaces` });
    // A label is told by its leaf suffix: a key under `labels` often holds a full-sentence message.
    const isLabel = /(?:Label|Heading|Toggle|Radio|Selection|Title)$/.test(e.key) && !/AriaLabel$/.test(e.key);
    const singleSentence = !/[.!?]\s+\S/.test(v.slice(0, -1));
    if (/[^.]\.$/.test(v) && singleSentence && (isLabel || /Tooltip$/.test(e.key))) out.push({ line: e.line, message: `${isLabel ? 'label' : 'single-sentence tooltip'} \`${e.key}\` ends with a period - written without one` });
  }
  return out;
}

// --- config -------------------------------------------------------------------------------

const strictFlags = ['strict', 'strictTemplates', 'strictInjectionParameters', 'strictInputAccessModifiers', 'strictStandalone', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization', 'noImplicitAny', 'noImplicitThis', 'noImplicitOverride', 'noImplicitReturns', 'noFallthroughCasesInSwitch', 'noPropertyAccessFromIndexSignature', 'noUncheckedIndexedAccess', 'useUnknownInCatchVariables', 'alwaysStrict', 'exactOptionalPropertyTypes', 'forceConsistentCasingInFileNames'];
const reFlag = new RegExp(`["']?(${strictFlags.join('|')})["']?\\s*:\\s*(true|false)\\b`);
const reConfigFile = /(?:^|\/)(?:tsconfig[^/]*\.json|\.eslintrc(?:\.[a-z]+)?|eslint\.config\.[cm]?[jt]s|angular\.json|project\.json)$/;
const reIgnoreKey = /["']?(exclude|ignores|ignorePatterns)["']?\s*:\s*\[/;

function configWeakened({ file, text, patch }) {
  const p = norm(file);
  if (!reConfigFile.test(p) || !patch) return [];
  const isEslint = /eslint/.test(baseOf(p));
  const { added, removed } = patchLines(patch);
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const a of added) {
    const f = a.text.match(reFlag);
    if (f && f[2] === 'false') { out.push({ line: a.line, message: `\`${f[1]}\` turned to \`false\` - the compiler/template contract stays at least as strict as it was` }); continue; }
    if (isEslint && /(?:["'][@\w/-]+["']|[\w-]+)\s*:\s*(?:\[\s*)?(?:["']off["']|0)\s*(?:[,\]}]|$)/.test(a.text.replace(/\/\/.*$/, ''))) { out.push({ line: a.line, message: 'an ESLint rule turned `off` - the rule set stays at least as strict as it was' }); continue; }
    if (reIgnoreKey.test(a.text) && /\[\s*\S[^\]]*\]?/.test(a.text.split('[').slice(1).join('[')) && !/\[\s*\]/.test(a.text)) { out.push({ line: a.line, message: 'a new `exclude`/`ignores` entry - excluded files lose the checks every other file gets' }); continue; }
    // An added entry inside an existing exclude/ignores array.
    if (/^\s*["'][^"']+["']\s*,?\s*$/.test(a.text)) {
      for (let j = a.line - 2; j >= 0 && j >= a.line - 200; j -= 1) {
        const l = lines[j] || '';
        if (reIgnoreKey.test(l)) { out.push({ line: a.line, message: `a new \`${l.match(reIgnoreKey)[1]}\` entry - excluded files lose the checks every other file gets` }); break; }
        if (/[\]{}]/.test(l) || /:\s*\[/.test(l)) break;
      }
    }
  }
  const now = new Set(lines.map((l) => l.match(reFlag)).filter((f) => f && f[2] === 'true').map((f) => f[1]));
  for (const r of removed) {
    const f = r.text.match(reFlag);
    if (f && f[2] === 'true' && !now.has(f[1]) && !added.some((a) => (a.text.match(reFlag) || [])[1] === f[1])) out.push({ line: r.line, message: `\`${f[1]}: true\` removed - the compiler/template contract stays at least as strict as it was` });
  }
  return out;
}

const callLine = (raw, re) => { const m = re.exec(raw); return m ? lineAt(raw, m.index) : 0; };
function appConfigWithFetch({ text }) {
  const t = mask(text, { strings: false });
  const at = callLine(t, /\bprovideHttpClient\s*\(/);
  if (!at || /\bwithFetch\s*\(/.test(t)) return [];
  return one('`provideHttpClient(...)` without `withFetch()`', at);
}
function appConfigInputBinding({ text }) {
  const t = mask(text, { strings: false });
  const at = callLine(t, /\bprovideRouter\s*\(/);
  if (!at || /\bwithComponentInputBinding\s*\(/.test(t)) return [];
  return one('`provideRouter(...)` without `withComponentInputBinding()`', at);
}
const runtimeFlags = ['strictStateImmutability', 'strictActionImmutability', 'strictStateSerializability', 'strictActionSerializability', 'strictActionTypeUniqueness'];
function appConfigRuntimeChecks({ text }) {
  const t = mask(text, { strings: false });
  const at = callLine(t, /\bprovideStore\s*\(/);
  if (!at) return [];
  const missing = runtimeFlags.filter((f) => !new RegExp(`\\b${f}\\s*:\\s*true\\b`).test(t));
  if (!missing.length) return [];
  return one(`\`provideStore(...)\` without \`runtimeChecks\` enabling ${missing.map((f) => `\`${f}\``).join(', ')}`, at);
}
function appConfigBootstrap({ text }) {
  const t = mask(text, { strings: false });
  const out = [];
  const a = callLine(t, /\bplatformBrowserDynamic\s*\(/);
  if (a) out.push({ line: a, message: '`platformBrowserDynamic()` bootstrap - expected `bootstrapApplication(App, appConfig)`' });
  const m = /@NgModule\s*\(\s*\{[\s\S]*?\bbootstrap\s*:\s*\[/.exec(t);
  if (m) out.push({ line: lineAt(t, m.index), message: 'a root `NgModule` with `bootstrap` - expected `bootstrapApplication(App, appConfig)` with a flat `providers` array' });
  return out;
}

// --- styles -------------------------------------------------------------------------------

const isStyle = (file) => /\.(?:scss|css)$/.test(norm(file));
const maskScss = (text) => mask(text, { strings: true }).replace(/url\([^)]*\)/g, (m) => m.replace(/[^\n]/g, ' '));
const reNamedColor = /^(?:white|black|red|green|blue|yellow|orange|purple|gray|grey|pink|brown|silver|navy|maroon|teal|olive|lime|aqua|fuchsia|cyan|magenta|gold|violet|indigo|beige|crimson|lightgr[ae]y|darkgr[ae]y)$/i;
const reColorProp = /^(?:color|background|background-color|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|caret-color|text-decoration-color|column-rule-color|accent-color)$/i;

function scssHardCodedColor({ file, text }) {
  if (!isStyle(file)) return [];
  const themeFile = /theme|palette|variables|tokens/i.test(norm(file));
  const out = [];
  maskScss(text).split('\n').forEach((l, i) => {
    const d = l.match(/^\s*(\$[\w-]+|--[\w-]+|[a-z-]+)\s*:\s*([^{};]*[^{};\s])\s*;?\s*(?:\}\s*)?$/i);
    if (!d || /^[a-z-]+$/i.test(d[1]) && /^(?:hover|focus|active|before|after|not|host|first-child|last-child|nth-child)/i.test(d[2])) return;
    const [, prop, value] = d;
    if (themeFile && /^(?:\$|--)/.test(prop)) return;
    const hex = value.match(/(?:^|[\s,(])(#[0-9a-fA-F]{3,8})\b/);
    const fn = value.match(/\b(?:rgba?|hsla?)\(\s*[\d.]+%?\s*[,\s]/);
    const named = reColorProp.test(prop) && reNamedColor.test(value.replace(/\s*!important$/, '').trim());
    const found = hex ? hex[1] : fn ? `${fn[0].replace(/[,\s]+$/, '')}...)` : named ? value.trim() : null;
    if (found) out.push({ line: i + 1, message: `hard-coded colour \`${found}\` in \`${prop}\` - colours come from the theme palette (\`rgb(var(--...))\` or a theme class)` });
  });
  return out;
}

function scssImport({ file, text }) {
  if (!isStyle(file)) return [];
  const out = [];
  mask(text, { strings: false }).split('\n').forEach((l, i) => {
    if (/^\s*@import\b/.test(l)) out.push({ line: i + 1, message: '`@import` - styles are loaded with `@use`/`@forward`' });
    else if (/^\s*@use\b.*\bas\s+\*/.test(l)) out.push({ line: i + 1, message: '`@use ... as *` - the namespace stays visible' });
  });
  return out;
}

const reKebab = /^[-_]?[a-z0-9]+(?:-[a-z0-9]+)*$/;
function scssKebabNames({ file, text }) {
  if (!/\.scss$/.test(norm(file))) return [];
  const out = [];
  maskScss(text).split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/(?:^|[{;\s])\$([\w-]+)\s*:/g)) if (!reKebab.test(m[1])) out.push({ line: i + 1, message: `variable \`$${m[1]}\` is not kebab-case` });
    const mx = l.match(/@mixin\s+([\w-]+)/);
    if (mx && !reKebab.test(mx[1])) out.push({ line: i + 1, message: `mixin \`${mx[1]}\` is not kebab-case` });
    const ph = l.match(/^\s*%([\w-]+)\s*[{,]/);
    if (ph && !reKebab.test(ph[1])) out.push({ line: i + 1, message: `placeholder \`%${ph[1]}\` is not kebab-case` });
  });
  return out;
}

// The rule blocks of a stylesheet: each `{` with its prelude, line and parent.
function scssBlocks(text) {
  const s = maskScss(text);
  const blocks = [];
  const stack = [];
  let line = 1;
  let start = 0;
  let startLine = 1;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\n') { line += 1; continue; }
    if (c === '#' && s[i + 1] === '{') { const end = s.indexOf('}', i); if (end > 0) { i = end; continue; } }
    if (c === '{') {
      const prelude = s.slice(start, i).trim();
      const pl = startLine + (s.slice(start, i).match(/^\s*/)[0].match(/\n/g) || []).length;
      const b = { prelude, line: pl, parent: stack[stack.length - 1] || null };
      blocks.push(b);
      stack.push(b);
      start = i + 1; startLine = line;
    } else if (c === '}') { stack.pop(); start = i + 1; startLine = line; } else if (c === ';') { start = i + 1; startLine = line; }
  }
  return blocks;
}
const isWrapper = (b) => /^@/.test(b.prelude) || /^:host\b(?:\([^)]*\))?\s*$/.test(b.prelude);
const extendsParent = (b) => /^&(?![\s>+~])/.test(b.prelude);
function selectorDepth(b) {
  let depth = 0;
  for (let x = b; x; x = x.parent) {
    if (/^@keyframes\b|^@(?:-\w+-)?keyframes\b/.test(x.prelude) && x !== b) return 0;
    if (!isWrapper(x) && !extendsParent(x)) depth += 1;
  }
  return depth;
}

function scssNestingDepth({ file, text }) {
  if (!/\.scss$/.test(norm(file))) return [];
  const out = [];
  for (const b of scssBlocks(text)) {
    if (isWrapper(b) || extendsParent(b)) continue;
    if (selectorDepth(b) === 4) out.push({ line: b.line, message: `selector \`${b.prelude.split('\n')[0].slice(0, 60)}\` nested four levels deep - selectors stay three levels or shallower` });
  }
  return out;
}

function scssNgDeep({ file, text }) {
  if (!isStyle(file)) return [];
  const out = [];
  for (const b of scssBlocks(text)) {
    if (!/::ng-deep/.test(b.prelude)) continue;
    let hosted = /^:host\b/.test(b.prelude);
    for (let x = b.parent; x && !hosted; x = x.parent) if (/(?:^|,\s*):host\b/.test(x.prelude)) hosted = true;
    if (!hosted) out.push({ line: b.line, message: '`::ng-deep` outside a `:host { ... }` block - it leaks into every component' });
  }
  return out;
}

function scssOutlineNone({ file, text }) {
  if (!isStyle(file)) return [];
  const out = [];
  maskScss(text).split('\n').forEach((l, i) => {
    if (/(?:^|[\s{;])outline\s*:\s*(?:none|0(?:px)?)\s*(?:!important)?\s*(?:;|}|$)/.test(l)) out.push({ line: i + 1, message: '`outline: none`/`0` - needs an equally visible `:focus-visible` replacement' });
  });
  return out;
}

// --- secrets ------------------------------------------------------------------------------

const secretPatterns = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, 'a private key'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bxox[bapr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, 'an API secret key'],
  [/\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/, 'a JWT'],
];
const reSecretAssign = /\b[\w$-]*(?:password|passwd|secret|token|api[_-]?key)[\w$-]*["']?\s*[:=]\s*(["'`])([^"'`]{12,})\1/i;
const rePlaceholder = /x{3,}|changeme|change[_-]me|<[^>]*>|\$\{|\{\{|%s|your[_-]|example|dummy|placeholder|sample|\*{3,}|^[a-z0-9]+(?:\.[\w-]+)+$|^[A-Z0-9_]+$|^\/|^https?:|\s|^[\w.-]+(?:\/[\w.{}:-]+)+\/?$/i;
function secretInDiff({ file, text, changedLines, patch }) {
  const p = norm(file);
  if (reSpec.test(p) || reMockPath.test(p) || /\.snap$/.test(p)) return [];
  const lines = patch ? patchLines(patch).added : (() => { const set = addedLineSet(text, changedLines, null); return String(text || '').split(/\r?\n/).map((t, i) => ({ line: i + 1, text: t })).filter((a) => set.has(a.line)); })();
  const out = [];
  for (const a of lines) {
    const hit = secretPatterns.find(([re]) => re.test(a.text));
    if (hit) { out.push({ line: a.line, message: `${hit[1]} on an added line - secrets never enter the repository` }); continue; }
    const m = a.text.match(reSecretAssign);
    if (m && !rePlaceholder.test(m[2]) && /\d/.test(m[2]) && /[A-Za-z]/.test(m[2])) out.push({ line: a.line, message: 'a password/secret/token assigned a literal on an added line - secrets come from the environment, never the repository' });
  }
  return out;
}

// --- registry -----------------------------------------------------------------------------

const checks = {
  'spec-exists': specExists,
  'spec-forbidden': specForbidden,
  'spec-location': specLocation,
  'component-naming': componentNaming,
  'component-folder-contents': componentFolderContents,
  'barrel-forbidden': barrelForbidden,
  'util-file-name': utilFileName,
  'models-file-suffix': modelsFileSuffix,
  'models-declarative': modelsDeclarative,
  'models-barrel-shape': modelsBarrelShape,
  'state-file-location': stateFileLocation,
  'service-file-location': serviceFileLocation,
  'guard-file-location': guardFileLocation,
  'interceptor-location': interceptorLocation,
  'i18n-key-shape': i18nKeyShape,
  'i18n-leaf-suffix': i18nLeafSuffix,
  'i18n-value-style': i18nValueStyle,
  'config-weakened': configWeakened,
  'app-config-with-fetch': appConfigWithFetch,
  'app-config-input-binding': appConfigInputBinding,
  'app-config-runtime-checks': appConfigRuntimeChecks,
  'app-config-bootstrap': appConfigBootstrap,
  'scss-hard-coded-color': scssHardCodedColor,
  'scss-import': scssImport,
  'scss-kebab-names': scssKebabNames,
  'scss-nesting-depth': scssNestingDepth,
  'scss-ng-deep': scssNgDeep,
  'scss-outline-none': scssOutlineNone,
  'secret-in-diff': secretInDiff,
};

// The recommendation for static/static-map.json: which items a check settles, at which level,
// and whether the item text holds more than the check covers (`partial`).
const checkItems = {
  'spec-exists': { addresses: ['utils#11', 'pipes#9', 'guards#9', 'directives#8', 'interceptors#9'], level: 'decides', partial: true, files: ['**/*.{util,pipe,guard,directive,interceptor}.ts'], note: 'existence only; what the spec covers stays walked. Map it on the source file kinds (util, pipe, guard, directive, interceptor), the items sit on the spec kinds. null on a partial tree.' },
  'spec-forbidden': { addresses: ['routes#10', 'i18n#12'], level: 'decides', partial: false, note: 'fires on the spec file of kind routes-spec / i18n-spec. http-service#14 (data-access-service-spec): level points, partial - a service that transforms data may keep its spec.' },
  'spec-location': { addresses: ['unit-tests#1'], level: 'decides', partial: false, files: ['**/*.spec.ts', '**/*.snap'], note: 'e2e specs skipped.' },
  'component-naming': { addresses: ['feature-component#1', 'ui-component#1'], level: 'decides', partial: false, files: ['**/components-*/{feature,ui}/**/*.component.{ts,html,scss}'], note: 'folder, file, class, selector suffix; the app prefix of the selector is not checked.' },
  'component-folder-contents': { addresses: ['components-folder#1', 'components-folder#4'], level: 'decides', partial: true, files: ['**/components-*/{feature,ui}/**'], note: 'partial for #4: "a folder another component shares" is not checked.' },
  'barrel-forbidden': { addresses: ['architecture#7', 'components-folder#3', 'utils#10'], level: 'decides', partial: true, files: ['**/index.ts'], note: 'creating a barrel only; imports through one stay walked (architecture#7 partial). Library entry recognised by package.json/ng-package.json/project.json/public-api sibling, lib src/index.ts, or a tsconfig path naming it. null on a partial tree.' },
  'util-file-name': { addresses: ['utils#1'], level: 'decides', partial: true, files: ['**/shared/utils/**/*.ts'], note: 'suffix only; the verb vocabulary is judgement.' },
  'models-file-suffix': { addresses: ['models#1'], level: 'decides', partial: true, files: ['**/models/**/*.ts'], note: 'suffix per folder; what belongs in models/ stays walked.' },
  'models-declarative': { addresses: ['models#5', 'models#6'], level: 'decides', partial: true, files: ['**/models/**/*.ts'], note: 'top-level function/class/arrow-const and, in .const.ts, interface/type/enum; IIFE or computed consts stay walked.' },
  'models-barrel-shape': { addresses: ['models#7'], level: 'decides', partial: true, files: ['**/models/index.ts'], note: 'only `export *` lines, lists every model file; section order and consumer imports stay walked. null on a partial tree.' },
  'state-file-location': { addresses: ['signal-store#1', 'ngrx-actions#1', 'ngrx-reducer#1', 'ngrx-selectors#1', 'ngrx-effects#1', 'ngrx-facade#1'], level: 'decides', partial: true, note: 'location half only (ngrx-selectors#1 is location only, so it may be non-partial).' },
  'service-file-location': { addresses: ['http-service#2'], level: 'points', partial: true, note: 'points: app-wide HTTP services (app/shared/services, a shared api library) have no area to live in; folder only; file name = area and class name stay walked.' },
  'guard-file-location': { addresses: ['guards#1'], level: 'decides', partial: true, note: 'folder and suffix; functional guard shape stays walked.' },
  'interceptor-location': { addresses: ['interceptors#2'], level: 'points', partial: true, note: 'the app-level location is a project convention; fires only on paths clearly inside an area.' },
  'i18n-key-shape': { addresses: ['i18n#3'], level: 'points', partial: true, note: 'both page roots, non-camelCase leaf, on added keys. Legacy keys may legitimately be snake_case in a project.' },
  'i18n-leaf-suffix': { addresses: ['i18n#5'], level: 'points', partial: true, note: 'AriaLabel copying a visible label, abbreviated suffixes.' },
  'i18n-value-style': { addresses: ['i18n#7'], level: 'points', partial: true, note: 'trailing period on labels/single-sentence tooltips, `{{ x }}` spacing. "labels" vs messages is guessed from the key.' },
  'config-weakened': { addresses: ['general#12'], level: 'points', partial: true, files: ['**/tsconfig*.json', '**/.eslintrc*', '**/eslint.config.*', '**/angular.json'], note: 'flags to false / removed true, rules off, new exclude/ignores entries; an exclude may be legitimate (generated code), hence points.' },
  'app-config-with-fetch': { addresses: ['app-config#2'], level: 'decides', partial: true, note: 'withFetch only; interceptor style is walked, withNoXsrfProtection is security#9.' },
  'app-config-input-binding': { addresses: ['app-config#3'], level: 'decides', partial: true, note: 'withComponentInputBinding only; eager imports stay walked.' },
  'app-config-runtime-checks': { addresses: ['app-config#5'], level: 'decides', partial: true, note: 'five flags `: true`; strictActionWithinNgZone vs zoneless stays walked.' },
  'app-config-bootstrap': { addresses: ['app-config#1'], level: 'decides', partial: false, files: ['**/main.ts', '**/app.config.ts', '**/app.module.ts'], note: 'platformBrowserDynamic() or @NgModule({ bootstrap }).' },
  'scss-hard-coded-color': { addresses: ['component-styles#4'], level: 'decides', partial: true, note: 'hex / numeric rgb-hsl / named colour; dark-mode counterpart stays walked. Variable definitions in theme/palette/variables/tokens files skipped.' },
  'scss-import': { addresses: ['component-styles#11'], level: 'decides', partial: false },
  'scss-kebab-names': { addresses: ['component-styles#8'], level: 'decides', partial: false },
  'scss-nesting-depth': { addresses: ['component-styles#9'], level: 'decides', partial: true, note: 'nesting depth > 3 (wrappers, :host and &-suffix blocks not counted); BEM-in-BEM nesting and long single selectors stay walked.' },
  'scss-ng-deep': { addresses: ['component-styles#5'], level: 'decides', partial: true, note: 'the :host wrapper only; "nothing else reaches it" stays walked.' },
  'scss-outline-none': { addresses: ['accessibility#13'], level: 'points', partial: true, note: 'a :focus-visible replacement may exist.' },
  'secret-in-diff': { addresses: ['security#7'], level: 'points', partial: true, note: 'added lines only; specs and mocks skipped.' },
};

module.exports = { checks, checkItems, patchLines, jsonEntries, mask, scssBlocks };
