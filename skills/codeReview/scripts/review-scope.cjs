'use strict';

// The part of a repository of several projects that a review reads beyond its own files: the
// projects holding the reviewed files and the projects their imports reach. The duplication
// scan (duplication-scan.cjs) exports only this part to jscpd and the repository facts
// (review-context.cjs loadFactUniverse) read only it. Measured on an Angular monorepo of 7 700
// fact sources (2026-10-27): the whole repository made every fact a mere hint (the 5 000-file
// cap) and let one boilerplate block of an unrelated library chain 9 332 copies; the reviewed
// application and the libraries it imports hold 4 800. A reviewed file another project imports
// through a tsconfig alias from outside the scope is `open`: its facts only point, because a
// consumer the facts did not read would turn "nobody imports this" into a false fact. A
// repository without project markers below its root, or a reviewed script outside every
// project, means the whole repository, as before.
//
// Pure: the caller hands in the revision's paths, the texts it needs and the search for importers.

const path = require('node:path');
const repoFacts = require('./repo-facts.cjs');

// A folder holding one of these is a project: Angular CLI, Nx, npm workspaces.
const projectMarkers = new Set(['package.json', 'project.json', 'ng-package.json', 'tsconfig.app.json', 'tsconfig.lib.json']);
const reScript = /\.(?:[cm]?[jt]sx?)$/;

const dirOf = (p) => {
  const at = p.lastIndexOf('/');
  return at < 0 ? '' : p.slice(0, at);
};

// Every project folder below the repository root, deepest first: a folder with a marker file,
// and every `root` an Angular CLI or Nx workspace file declares (a Storybook project has none
// of the markers).
function projectRoots(paths, readText = () => null) {
  const roots = new Set();
  for (const p of paths) {
    const dir = dirOf(p);
    if (dir && projectMarkers.has(p.slice(dir.length + 1))) roots.add(dir);
  }
  for (const name of ['angular.json', 'workspace.json']) {
    if (!paths.has(name)) continue;
    let workspace = null;
    try {
      workspace = JSON.parse(readText(name) || 'null');
    } catch {}
    for (const project of Object.values((workspace && workspace.projects) || {})) {
      const root = project && typeof project === 'object' && typeof project.root === 'string' ? project.root.replace(/\\/g, '/').replace(/^\.\/|\/$/g, '') : '';
      if (root && root !== '.') roots.add(root);
    }
  }
  return [...roots].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

// The project a path belongs to. A path under a folder that holds projects (`projects/`,
// `libs/`) but in none of them is a project of its own, named by its first folder there: a
// Storybook or e2e folder that no workspace file lists still imports like an application.
function rootOf(roots, p) {
  const own = roots.find((root) => p === root || p.startsWith(`${root}/`));
  if (own) return own;
  const parent = roots.map(dirOf).filter((dir) => dir && p.startsWith(`${dir}/`)).sort((a, b) => b.length - a.length)[0];
  if (!parent) return null;
  const next = p.slice(parent.length + 1).split('/')[0];
  return p.slice(parent.length + 1).includes('/') ? `${parent}/${next}` : null;
}

// The tsconfig aliases of the repository root, where a workspace declares them.
function rootAliases(paths, readText) {
  const files = new Map();
  for (const name of ['tsconfig.json', 'tsconfig.base.json']) {
    if (!paths.has(name)) continue;
    const text = readText(name);
    if (typeof text === 'string') files.set(name, text);
  }
  // One level of `extends` inside the root is what a workspace uses; loadTsconfig follows it.
  for (const text of [...files.values()]) {
    const ext = (text.match(/"extends"\s*:\s*"(\.[^"]+)"/) || [])[1];
    if (!ext) continue;
    const name = path.posix.normalize(ext.endsWith('.json') ? ext : `${ext}.json`);
    if (paths.has(name) && !files.has(name)) {
      const extended = readText(name);
      if (typeof extended === 'string') files.set(name, extended);
    }
  }
  return repoFacts.loadTsconfig(files, '').aliases;
}

// The projects one file's imports reach: an alias or a relative specifier leading into a project.
function importedRoots(roots, file, text, resolve, aliases) {
  const out = new Set();
  if (!reScript.test(file)) return out;
  let module;
  try {
    module = repoFacts.parseModule(repoFacts.scanScript(text));
  } catch {
    return out;
  }
  for (const { spec } of [...module.imports, ...module.reexports]) {
    let target = resolve(file, spec);
    if (!target) {
      // An alias whose target the listing cannot resolve to a file still names its folder.
      const alias = aliases.find((a) => (a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix));
      target = alias && alias.targets[0] ? alias.targets[0].replace(/\*.*$/, '').replace(/\/$/, '') : null;
    }
    const root = target ? rootOf(roots, target) : null;
    if (root) out.add(root);
  }
  return out;
}

// The aliases through which another project can import `p`: one whose target folder holds it,
// and one naming a single file of its project (a barrel may re-export any file of it).
function exposingAliases(roots, aliases, p) {
  const own = rootOf(roots, p);
  return aliases.filter((alias) => alias.prefix && alias.targets.some((t) => {
    const target = t.replace(/\*.*$/, '').replace(/\/$/, '');
    if (alias.wildcard) return p.startsWith(`${target}/`);
    return own !== null && rootOf(roots, target) === own;
  }));
}

// `paths`: every path of the reviewed revision (a Set); `reviewed`: the reviewed files, path ->
// text (null for a deleted or binary one); `readText(p)`: a file of the revision, for the root
// tsconfig and the workspace file; `importersOf(needles)`: per literal needle, the paths of the
// revision whose text holds it (a Map, from git grep -F), or null when the search could not run.
// Returns null for "the whole repository", else `{ roots, has(p), open }`: the reviewed projects
// and the ones their imports reach, and `open`, the reviewed files another project imports
// through an alias from outside those - what the facts say of them only points (a consumer may
// sit where the facts did not read).
function reviewScope({ paths, reviewed, readText = () => null, importersOf = () => null }) {
  const all = paths instanceof Set ? paths : new Set(paths);
  const roots = projectRoots(all, readText);
  if (roots.length === 0 || reviewed.size === 0) return null;
  const scope = new Set();
  for (const p of reviewed.keys()) {
    const root = rootOf(roots, p);
    // A workspace file outside every project (package.json, angular.json) has no importers to
    // miss; a script there might, so it keeps the whole repository.
    if (!root && reScript.test(p)) return null;
    if (root) scope.add(root);
  }
  if (scope.size === 0) return null;
  const aliases = rootAliases(all, readText);
  const resolve = repoFacts.makeResolver(all, { aliases, baseUrl: null });
  for (const [p, text] of reviewed) {
    if (typeof text !== 'string') continue;
    for (const root of importedRoots(roots, p, text, resolve, aliases)) scope.add(root);
  }
  const sorted = [...scope].sort();
  const has = (p) => sorted.some((root) => p === root || p.startsWith(`${root}/`));
  // The bare prefix is searched: `@lib` also finds `@lib/sub`, wider but never a missed importer.
  const exposedBy = new Map([...reviewed.keys()].map((p) => [p, exposingAliases(roots, aliases, p).map((alias) => alias.prefix)]));
  const needles = [...new Set([...exposedBy.values()].flat())];
  const outside = new Set();
  if (needles.length > 0) {
    const importers = importersOf(needles);
    for (const needle of needles) {
      // A search that did not run leaves every importer unknown.
      const found = importers === null ? null : importers.get(needle) || [];
      // The tsconfig declaring the alias, a README naming it: not importers.
      if (found === null || found.some((p) => reScript.test(p) && !has(p))) outside.add(needle);
    }
  }
  const open = new Set([...exposedBy].filter(([, prefixes]) => prefixes.some((prefix) => outside.has(prefix))).map(([p]) => p));
  return { roots: sorted, has, open };
}

module.exports = { projectMarkers, projectRoots, rootOf, exposingAliases, reviewScope };
