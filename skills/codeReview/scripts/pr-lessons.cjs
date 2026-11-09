#!/usr/bin/env node
'use strict';

// What reviewers have already said, turned into the project's own review rules - so the next
// review raises it before a reviewer has to.
//
// On 2026-11-06 the reviewers of five stacked pull requests left 24 threads; four of the points
// were rules the rulebook held, and most of the rest were the project's own conventions, which a
// person had copied into `.claude/doh/local/` by hand after the fact. A fixed comment is a rule
// the project already enforces; this keeps it:
//
//   --action=list     the lessons the fix agents (fixPr, `lessons[]` of each result JSON) or the
//                     history agent (`--learn-from-prs`) proposed, numbered, each with whether
//                     the project's rules already carry it - for the user to pick from.
//   --action=add      writes the picked ones (`--pick=1,3`, or all new ones) as checklist items of
//                     `.claude/doh/local/pr-lessons-<group>.md`, a local instruction codeReview
//                     loads for every file of its group (rulebook.cjs loadLocalInstructions).
//   --action=history  the review threads of the last closed pull requests (`--prs=<n>`), reviewers
//                     only, written to `--out` for the agent that distils them into lessons.
//
// A lesson: { rule, files: spec|ts|html|scss|i18n|any, example?, source? }.
//
// Usage: node pr-lessons.cjs --action=list|add --project=<dir> --from=<json>[,<json>] [--pick=<n,n>] [--dry-run]
//        node pr-lessons.cjs --action=history --project=<dir> --prs=<n> --out=<json>

const fs = require('node:fs');
const path = require('node:path');

const groups = {
  spec: { name: 'Lessons from pull request reviews - specs', globs: ['**/*.spec.ts', '**/*.spec.js'] },
  ts: { name: 'Lessons from pull request reviews - TypeScript', globs: ['**/*.ts'] },
  html: { name: 'Lessons from pull request reviews - templates', globs: ['**/*.html'] },
  scss: { name: 'Lessons from pull request reviews - styles', globs: ['**/*.scss', '**/*.css'] },
  i18n: { name: 'Lessons from pull request reviews - translations', globs: ['**/i18n/**/*.json', '**/assets/i18n/*.json'] },
  any: { name: 'Lessons from pull request reviews', globs: ['**/*'] },
};

function parseArgs(argv) {
  const args = { action: '', project: process.cwd(), from: [], pick: null, dryRun: false, prs: 20, out: '' };
  const unknown = [];
  for (const arg of argv) {
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'action') args.action = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'from') args.from = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    else if (m[1] === 'pick') args.pick = m[2].split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    else if (m[1] === 'prs' && /^\d+$/.test(m[2])) args.prs = Number(m[2]);
    else if (m[1] === 'out') args.out = m[2];
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --action, --project, --from, --pick, --prs, --out, --dry-run).`);
  if (!['list', 'add', 'history'].includes(args.action)) throw new Error('--action is list, add or history.');
  if (args.action !== 'history' && args.from.length === 0) throw new Error(`${args.action} needs --from=<json>.`);
  if (args.action === 'history' && !args.out) throw new Error('history needs --out=<json>.');
  return args;
}

const localDir = (project) => path.join(project, '.claude', 'doh', 'local');
const fileOf = (project, group) => path.join(localDir(project), `pr-lessons-${group}.md`);
const norm = (text) => String(text || '').toLowerCase().replace(/`[^`]*`/g, (m) => m.toLowerCase()).replace(/[^a-z0-9`#._-]+/g, ' ').trim();
const wordSet = (text) => new Set(norm(text).split(' ').filter((w) => w.length > 2));

function similar(a, b) {
  const x = wordSet(a);
  const y = wordSet(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

// The checklist bullets every local rule file of the project already holds.
function existingRules(project) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(localDir(project)).filter((n) => n.endsWith('.md'));
  } catch {
    return out;
  }
  for (const name of names) {
    const text = fs.readFileSync(path.join(localDir(project), name), 'utf8');
    for (const line of text.split(/\r?\n/)) if (/^- /.test(line)) out.push({ file: name, text: line.slice(2) });
  }
  return out;
}

// Every lesson of the given result or candidate files, numbered from 1, with its verdict against
// the rules the project already has.
function candidates(project, files) {
  const have = existingRules(project);
  const out = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const lesson of data.lessons || []) {
      if (!lesson || !String(lesson.rule || '').trim()) continue;
      const group = groups[lesson.files] ? lesson.files : 'any';
      const twin = have.find((r) => similar(r.text, lesson.rule)) || out.find((c) => similar(c.rule, lesson.rule));
      out.push({ n: out.length + 1, group, rule: String(lesson.rule).trim(), example: lesson.example || null, source: lesson.source || data.source || null, known: twin ? (twin.file || `#${twin.n}`) : null });
    }
  }
  return out;
}

function frontMatter(group) {
  const g = groups[group];
  return ['---', `name: ${g.name}`, `id: pr-lessons-${group}`, 'applies-to:', ...g.globs.map((p) => `  - "${p}"`), 'severity: medium', '---',
    'Rules the project\'s reviewers asked for in pull request comments, kept so the review raises them first',
    '(doh pr-lessons.cjs, from fixPr lessons and --learn-from-prs). One bullet, one rule; edit or delete freely.', '', '## Checklist', ''].join('\n');
}

function add(project, files, pick, dryRun) {
  const list = candidates(project, files);
  const chosen = list.filter((c) => (pick ? pick.includes(c.n) : !c.known));
  const result = { added: [], skipped: list.filter((c) => !chosen.includes(c)).map((c) => ({ n: c.n, rule: c.rule, why: c.known ? `already in ${c.known}` : 'not picked' })), files: [] };
  const byGroup = new Map();
  for (const c of chosen) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group).push(c);
  }
  for (const [group, items] of byGroup) {
    const file = fileOf(project, group);
    const bullets = items.map((c) => `- ${c.rule}${c.example ? ` Example: ${c.example}` : ''}${c.source ? ` (${c.source})` : ''}`);
    result.added.push(...items.map((c) => ({ n: c.n, group, rule: c.rule })));
    result.files.push(file);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\s+$/, '') : frontMatter(group).replace(/\s+$/, '');
    fs.writeFileSync(file, `${before}\n${bullets.join('\n')}\n`);
  }
  return result;
}

// The review threads of the last closed pull requests: the reviewers' words where they said them.
function history(project, prs, out, deps = {}) {
  const github = deps.github || require('./github.cjs');
  const api = deps.api || require('../../fixPr/scripts/pr-api.cjs');
  const slug = github.repoSlug(project);
  if (!slug) return { errors: [`No GitHub remote in ${project}.`] };
  const res = github.request(project, { path: `/repos/${slug.owner}/${slug.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${Math.min(prs, 100)}` });
  if (!res.ok || !Array.isArray(res.json)) return { errors: [`Could not list closed pull requests: ${res.error || res.status}`] };
  const threads = [];
  const warnings = [];
  for (const pr of res.json.slice(0, prs)) {
    const got = api.reviewThreads(project, slug, pr.number);
    if (got.error) warnings.push(`#${pr.number}: ${got.error}`);
    for (const t of got.threads || []) {
      const people = (t.comments || []).filter((c) => !c.isBot);
      if (people.length === 0) continue;
      threads.push({
        pr: pr.number, title: pr.title, path: t.path, line: t.line || t.originalLine, resolved: t.isResolved,
        hunk: String(t.diffHunk || '').slice(-1200), comments: people.map((c) => ({ author: c.author, body: String(c.body || '').slice(0, 1500) })),
      });
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ project, prs: res.json.slice(0, prs).map((p) => p.number), threads }, null, 1)}\n`);
  return { out, prs: Math.min(prs, res.json.length), threads: threads.length, warnings, errors: [] };
}

function main() {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    const project = path.resolve(args.project);
    if (args.action === 'list') result = { candidates: candidates(project, args.from) };
    else if (args.action === 'add') result = add(project, args.from, args.pick, args.dryRun);
    else result = history(project, args.prs, args.out);
  } catch (err) {
    result = { errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors && result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, candidates, add, history, groups, similar };

if (require.main === module) main();
