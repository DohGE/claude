#!/usr/bin/env node
'use strict';
// The project's own styling for the mockups (references/mockup-agent.md, "The project's own
// styling"): the global stylesheet of the app the screens belong to, compiled with the project's
// own Sass into `project-<app>.css` next to the mockups - the one stylesheet a screen links, which
// the preview's `default-src 'self'` policy serves - and the project's Storybook, the source of
// truth for every component when there is one: its stories by id, its theme classes, a static
// build when one exists and the command that builds one into the session, never into the project.
//
// A mockup drawn to "look like" the app drifts from it in every value it guessed; this hands the
// agent the app's own CSS and components instead.
//
// Usage: node project-styles.cjs --project=<dir> --out=<generated-mockups dir> [--app=<angular project>]
// Prints ONE line of JSON: { app, css, bytes, apps, tokens, storybook, warnings, errors }.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// The folder a Storybook is built into: next to the mockups, inside the task's session folder.
const BUILD_DIR = 'storybook-static';
const INDEX_FILE = 'storybook-index.json';
const reStories = /\.stories\.(?:[cm]?[jt]sx?|mdx)$/;
const reTokens = /(^|\/)_?(?:tokens?|variables|theme|themes|palette|colou?rs?)[^/]*\.(?:s[ac]ss|css|json)$/i;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const firstLine = (err) => String((err && err.message) || err).split('\n')[0].trim();

// The project's tracked files, or a shallow walk when it is no git repository.
function listFiles(project) {
  try {
    return execFileSync('git', ['-C', project, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 8) return;
      for (const entry of fs.readdirSync(path.join(project, dir), { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(rel, depth + 1);
        else out.push(rel);
      }
    };
    walk('', 0);
    return out;
  }
}

// Storybook's own story id: `toId(title, storyNameFromExport(name))`.
const sanitize = (text) => String(text).toLowerCase()
  .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/g, '-')
  .replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
const startCase = (name) => String(name)
  .replace(/([a-z\d])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1 $2')
  .replace(/[_-]+/g, ' ').trim();
const storyId = (title, exportName) => `${sanitize(title)}--${sanitize(startCase(exportName))}`;

// The Angular workspace: every project's global styles, and the Storybook targets among its targets.
function angularWorkspace(project) {
  const ws = readJson(path.join(project, 'angular.json'));
  const apps = [];
  const targets = [];
  for (const [name, def] of Object.entries((ws && ws.projects) || {})) {
    const architect = def.architect || def.targets || {};
    const build = (architect.build && architect.build.options) || {};
    const styles = (build.styles || []).map((s) => (typeof s === 'string' ? s : s && s.input)).filter(Boolean);
    const includePaths = (build.stylePreprocessorOptions && build.stylePreprocessorOptions.includePaths) || [];
    if (styles.length > 0) apps.push({ name, styles, includePaths, application: def.projectType === 'application' });
    for (const [target, t] of Object.entries(architect)) {
      const m = String((t && t.builder) || '').match(/@storybook\/angular:(start|build)-storybook/);
      if (!m) continue;
      const o = t.options || {};
      targets.push({ project: name, target, kind: m[1], configDir: o.configDir || null, browserTarget: o.browserTarget || o.buildTarget || null, outputDir: o.outputDir || null });
    }
  }
  return { apps, targets };
}

// The theme classes a Storybook switches (`withThemeByClassName({ themes: { light: '', dark: 'x' } })`).
function themesOf(previewText) {
  const block = String(previewText || '').match(/withThemeByClassName\s*(?:<[^>]*>)?\s*\(\s*\{[\s\S]*?themes\s*:\s*\{([\s\S]*?)\}/);
  if (!block) return null;
  const themes = {};
  for (const m of block[1].matchAll(/(['"]?)([\w-]+)\1\s*:\s*(['"`])([^'"`]*)\3/g)) themes[m[2]] = m[4];
  return Object.keys(themes).length > 0 ? themes : null;
}

function findStorybook({ project, out, files, workspace }) {
  const configDirs = [...new Set(files.filter((f) => /(^|\/)\.storybook\/main\.[cm]?[jt]sx?$/.test(f)).map((f) => path.posix.dirname(f)))];
  const pkg = readJson(path.join(project, 'package.json')) || {};
  const scripts = Object.entries(pkg.scripts || {}).filter(([name, cmd]) => /storybook/i.test(`${name} ${cmd}`)).map(([name]) => name);
  if (configDirs.length === 0 && workspace.targets.length === 0) return null;
  const build = workspace.targets.find((t) => t.kind === 'build') || null;
  const builtAt = [build && build.outputDir, BUILD_DIR].filter(Boolean).map((dir) => path.resolve(project, dir))
    .find((dir) => fs.existsSync(path.join(dir, 'iframe.html'))) || null;
  const stories = files.filter((f) => reStories.test(f));
  const index = stories.map((file) => {
    const text = readText(path.join(project, file)) || '';
    const title = (text.match(/\btitle\s*:\s*(['"`])([^'"`]+)\1/) || [])[2] || null;
    const exports = [...text.matchAll(/^export\s+const\s+(\w+)\s*[:=]/gm)].map((m) => m[1]);
    return { file, title, ids: title ? exports.map((name) => storyId(title, name)) : [] };
  }).filter((entry) => entry.title);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
  const preview = configDirs.flatMap((dir) => ['preview.ts', 'preview.tsx', 'preview.js', 'preview.mjs'].map((name) => path.join(project, dir, name)))
    .find((file) => fs.existsSync(file));
  const buildDir = path.join(path.dirname(out), BUILD_DIR);
  // Into the session, and without compodoc, which writes its documentation.json into the project.
  const command = build
    ? `npx ng run ${build.project}:${build.target} --output-dir="${buildDir}" --compodoc=false`
    : configDirs.length > 0 ? `npx storybook build --config-dir "${configDirs[0]}" --output-dir "${buildDir}"` : null;
  const renders = (build || workspace.targets[0] || {}).browserTarget;
  return {
    configDirs,
    scripts,
    stories: stories.length,
    index: INDEX_FILE,
    themes: themesOf(preview ? readText(preview) : ''),
    static: builtAt,
    build: command,
    buildDir,
    app: renders ? String(renders).split(':')[0] : null,
  };
}

// The project's own Sass (`sass`, else `sass-embedded`), resolving `~package` imports and the
// workspace's include paths the way the Angular CLI does; null when the project has neither.
function projectCompiler(project, includePaths = []) {
  let sass = null;
  for (const name of ['sass', 'sass-embedded']) {
    try {
      sass = require(require.resolve(name, { paths: [project] }));
      break;
    } catch {
      // try the next one
    }
  }
  if (!sass) return null;
  const nodeModules = path.join(project, 'node_modules');
  return (file) => sass.compile(file, {
    loadPaths: [path.dirname(file), project, nodeModules, ...includePaths.map((p) => path.resolve(project, p))],
    importers: [{ findFileUrl: (url) => (url.startsWith('~') ? pathToFileURL(path.join(nodeModules, url.slice(1))) : null) }],
    style: 'expanded',
    quietDeps: true,
    logger: sass.Logger ? sass.Logger.silent : undefined,
  }).css;
}

function projectStyles({ project, out, app = null, files = null, compile = null }) {
  const result = { app: null, css: null, bytes: 0, apps: [], tokens: [], storybook: null, warnings: [], errors: [] };
  const root = path.resolve(project);
  const listed = files || listFiles(root);
  const workspace = angularWorkspace(root);
  result.apps = workspace.apps.map((a) => a.name);
  result.tokens = listed.filter((f) => reTokens.test(f) && !f.includes('node_modules/')).slice(0, 30);
  try {
    result.storybook = findStorybook({ project: root, out, files: listed, workspace });
  } catch (err) {
    result.warnings.push(`The Storybook could not be read: ${firstLine(err)}`);
  }
  if (app && !result.apps.includes(app)) {
    result.errors.push(`No app "${app}" with global styles - the apps are: ${result.apps.join(', ') || 'none'}.`);
    return result;
  }
  const chosen = workspace.apps.find((a) => a.name === app)
    || workspace.apps.find((a) => result.storybook && a.name === result.storybook.app)
    || workspace.apps.find((a) => a.application)
    || workspace.apps[0];
  if (!chosen) {
    result.warnings.push('No global stylesheet in the workspace (angular.json build styles) - the screens take the design language from the code.');
    return result;
  }
  result.app = chosen.name;
  const sassOf = compile || projectCompiler(root, chosen.includePaths);
  const parts = [];
  for (const entry of chosen.styles) {
    const file = path.resolve(root, entry);
    if (/\.s[ac]ss$/i.test(file)) {
      if (!sassOf) {
        result.warnings.push(`${entry} was not compiled: the project has no sass package.`);
        continue;
      }
      try {
        parts.push(`/* ${entry} */\n${sassOf(file)}`);
      } catch (err) {
        result.warnings.push(`${entry} did not compile: ${firstLine(err)}`);
      }
    } else {
      const text = readText(file);
      if (text === null) result.warnings.push(`${entry} is missing.`);
      else parts.push(`/* ${entry} */\n${text}`);
    }
  }
  if (parts.length === 0) return result;
  const css = `/* The global styles of ${chosen.name}, compiled by doh project-styles.cjs - every screen links this file. */\n${parts.join('\n')}\n`;
  fs.mkdirSync(out, { recursive: true });
  result.css = `project-${chosen.name.replace(/[^\w.-]+/g, '-')}.css`;
  fs.writeFileSync(path.join(out, result.css), css);
  result.bytes = Buffer.byteLength(css);
  return result;
}

module.exports = { projectStyles, projectCompiler, storyId, themesOf, angularWorkspace, BUILD_DIR, INDEX_FILE };

function parseArgs(argv) {
  const args = { project: null, out: null, app: null };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'out') args.out = m[2];
    else if (m[1] === 'app') args.app = m[2] || null;
  }
  return args;
}

module.exports.parseArgs = parseArgs;

if (require.main === module) {
  const { project, out, app } = parseArgs(process.argv.slice(2));
  let result;
  if (!project || !out) result = { errors: ['usage: node project-styles.cjs --project=<dir> --out=<generated-mockups dir> [--app=<name>]'] };
  else {
    try {
      result = projectStyles({ project, out: path.resolve(out), app });
    } catch (err) {
      result = { errors: [firstLine(err)] };
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
