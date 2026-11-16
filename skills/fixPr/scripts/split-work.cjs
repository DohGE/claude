#!/usr/bin/env node
'use strict';

// The items of one fix agent, cut into groups of whole folders for parallel workers.
//
// A part with many items is the run's slowest: part-1 of DPXN-12003 had 30 codeReview findings,
// took 48.5 min, and every part above it waited for its landing (2026-11-16). Its context grew to
// 330k tokens, every turn re-reading what the earlier fixes had read. Workers (`doh:pipeline-worker`)
// each fix the items of a few folders - a component's folder with its tests/ folded in, so a
// fix and its spec stay together and no two workers edit one file - while the fix agent keeps
// the items that belong to no file, then checks, reviews and commits the whole change.
//
// Usage:
//   node split-work.cjs --comments=<commentsPath> --out-dir=<dir> [--groups=3] [--min-items=12] [--vars=<brief vars json>]
// Prints one JSON object: { split, groups: [{ k, path, result, prompt?, files, items }], lead, warnings, errors }.
// With --vars (the fix agent's own values, fixpr-launch.cjs) each group's worker brief is rendered.

const fs = require('node:fs');
const path = require('node:path');

const template = path.join(__dirname, '..', 'references', 'fix-worker-agent.md');
// The placeholders of fix-worker-agent.md: GROUP* come from here, the rest from the fix agent's values.
const workerNames = ['ROOT', 'BRANCH', 'PR_NUMBER', 'PROJECT', 'SKILL_DIR', 'RULEBOOK', 'LANGUAGE', 'LOCAL', 'GROUP', 'GROUP_FILE', 'GROUP_RESULT', 'GROUP_FILES'];

function parseArgs(argv) {
  const args = { comments: '', outDir: '', groups: 3, minItems: 12, vars: '' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'comments') args.comments = m[2];
    else if (m[1] === 'out-dir') args.outDir = m[2];
    else if (m[1] === 'groups' && /^\d+$/.test(m[2])) args.groups = Number(m[2]);
    else if (m[1] === 'min-items' && /^\d+$/.test(m[2])) args.minItems = Number(m[2]);
    else if (m[1] === 'vars') args.vars = m[2];
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --comments, --out-dir, --groups, --min-items, --vars).`);
  if (!args.comments || !args.outDir) throw new Error('--comments and --out-dir are required.');
  return args;
}

// A file's folder, its tests/ folder folded into the folder it tests.
const areaOf = (file) => path.posix.dirname(String(file).replace(/\\/g, '/')).replace(/\/(tests|__tests__|test|spec)$/, '');

function split(options) {
  const data = JSON.parse(fs.readFileSync(options.comments, 'utf8'));
  const result = { split: false, groups: [], lead: [], warnings: [], errors: [] };
  const located = [
    ...(data.threads || []).map((x) => ({ key: `thread:${x.id}`, list: 'threads', item: x, file: x.path })),
    ...(data.findings || []).map((x) => ({ key: `finding:${x.id}`, list: 'findings', item: x, file: x.path })),
  ].filter((x) => x.file);
  const loose = [
    ...(data.threads || []).filter((x) => !x.path).map((x) => `thread:${x.id}`),
    ...(data.findings || []).filter((x) => !x.path).map((x) => `finding:${x.id}`),
    ...(data.conversation || []).map((x) => `conversation:${x.id}`),
    ...(data.reviews || []).map((x) => `review:${x.id}`),
    ...(data.task ? ['task'] : []),
  ];
  result.lead = loose;
  const areas = new Map();
  for (const entry of located) {
    const area = areaOf(entry.file);
    if (!areas.has(area)) areas.set(area, []);
    areas.get(area).push(entry);
  }
  if (located.length + loose.length < (options.minItems || 12) || areas.size < 2) return result;
  const count = Math.min(options.groups || 3, areas.size);
  const groups = Array.from({ length: count }, () => ({ areas: [], entries: [] }));
  const ordered = [...areas.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  for (const [area, entries] of ordered) {
    const target = groups.reduce((best, g) => (g.entries.length < best.entries.length ? g : best), groups[0]);
    target.areas.push(area);
    target.entries.push(...entries);
  }
  fs.mkdirSync(options.outDir, { recursive: true });
  let values = null;
  if (options.vars) values = JSON.parse(fs.readFileSync(options.vars, 'utf8'));
  groups.forEach((g, i) => {
    const k = i + 1;
    const file = path.join(options.outDir, `group-${k}.json`);
    const keys = new Set(g.entries.map((e) => e.key));
    const own = (list, prefix) => (data[list] || []).filter((x) => keys.has(`${prefix}:${x.id}`));
    fs.writeFileSync(file, `${JSON.stringify({ ...data, threads: own('threads', 'thread'), findings: own('findings', 'finding'), conversation: [], reviews: [], task: undefined }, null, 2)}\n`, 'utf8');
    const entry = { k, path: file, result: path.join(options.outDir, `group-${k}.result.json`), files: [...g.areas].sort(), items: g.entries.map((e) => e.key) };
    if (values) {
      const rap = require('../../../scripts/render-agent-prompt.cjs');
      const rendered = rap.renderFile({
        template,
        out: path.join(options.outDir, `group-${k}-prompt.md`),
        values: { ...Object.fromEntries(Object.entries(values).map(([n, v]) => [n, String(v)])), GROUP: String(k), GROUP_FILE: file, GROUP_RESULT: entry.result, GROUP_FILES: entry.files.join(', ') },
      });
      if (rendered.errors.length) result.errors.push(...rendered.errors);
      else entry.prompt = rendered.out;
    }
    result.groups.push(entry);
  });
  result.split = result.errors.length === 0;
  return result;
}

function main() {
  let result;
  try {
    result = split(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { split: false, groups: [], lead: [], warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, split, areaOf, workerNames };

if (require.main === module) main();
