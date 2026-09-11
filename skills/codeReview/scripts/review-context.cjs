#!/usr/bin/env node
'use strict';

// Deterministic mechanics for the doh:codeReview skill: argument parsing,
// glob matching, instruction frontmatter parsing, base-branch detection and
// the review-context JSON consumed by SKILL.md.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const github = require('./github.cjs');

const defaultSkillDir = path.resolve(__dirname, '..');
const baseBranchNames = ['main', 'master', 'develop', 'dev'];
const audiences = ['implement', 'review', 'both'];
const reportsRetain = 30;
const forkCandidateLimit = 60;

// Generated, vendored and binary files: reviewing them wastes context without
// producing findings. Skipped paths are listed per target so the report can
// mention them in one line.
// Prose (`.md`, `.txt`, changelogs, licenses) is skipped for the same reason:
// no instruction checklist has anything to say about it, so every such file
// costs a full walk of the global rulebook to produce nothing. Data files that
// DO carry reviewable content stay in: `.json` (configs, i18n) and `.snap`
// (a stale snapshot is a finding) are never skipped.
const skipGlobs = [
  '**/*.md', '**/*.markdown', '**/*.txt', '**/*.rst', '**/*.adoc',
  '**/CHANGELOG', '**/LICENSE', '**/LICENCE', '**/NOTICE', '**/AUTHORS',
  '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml',
  '**/bun.lockb', '**/composer.lock', '**/Cargo.lock', '**/Gemfile.lock', '**/poetry.lock', '**/uv.lock',
  '**/*.min.js', '**/*.min.css', '**/*.map',
  '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**', '**/node_modules/**', '**/.angular/**', '**/.idea/**',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.avif', '**/*.ico', '**/*.bmp', '**/*.svg',
  '**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.eot', '**/*.otf',
  '**/*.pdf', '**/*.zip', '**/*.gz', '**/*.7z', '**/*.jar',
  '**/*.mp3', '**/*.mp4', '**/*.webm', '**/*.mov',
  '**/*.exe', '**/*.dll', '**/*.wasm',
];
let skipRes = null;
function isSkippedPath(filePath) {
  if (!skipRes) skipRes = skipGlobs.map(globToRegExp);
  const normalized = filePath.replace(/\\/g, '/');
  return skipRes.some((re) => re.test(normalized));
}

function parseArgs(argv) {
  const args = { mode: 'auto', branches: '', path: '', project: process.cwd(), output: 'html', sinceLast: false };
  for (const arg of argv) {
    // Incremental review: only the files whose content moved since the previous
    // review of this target (see the snapshot written next to the report).
    if (arg === '--since-last') { args.sinceLast = true; continue; }
    const m = arg.match(/^--([a-z]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'mode') args.mode = m[2];
    else if (m[1] === 'branches') args.branches = m[2];
    else if (m[1] === 'path') args.path = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'output') args.output = m[2];
  }
  if (!['auto', 'staged', 'branches', 'folder'].includes(args.mode)) {
    throw new Error(`Unknown --mode=${args.mode} (expected auto|staged|branches|folder)`);
  }
  if (!['html', 'md'].includes(args.output)) {
    throw new Error(`Unknown --output=${args.output} (expected md|html)`);
  }
  return args;
}

function globToRegExp(pattern) {
  const segments = pattern.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  const parts = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    if (seg === '**') {
      parts.push(last ? '.*' : '(?:[^/]+/)*');
      continue;
    }
    let segRe = '';
    for (const ch of seg) {
      if (ch === '*') segRe += '[^/]*';
      else if (ch === '?') segRe += '[^/]';
      else segRe += ch.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
    parts.push(segRe + (last ? '' : '/'));
  }
  return new RegExp('^' + parts.join('') + '$');
}

// `scopes:` declares the named subsets an individual checklist item may narrow
// itself to (`- {styles} Contrast ratios …`). One name, one glob list, written
// either inline (`styles: ["**/*.scss", "**/*.css"]`) or as a nested list —
// the same glob language as `applies-to`, `!` excludes included.
function parseScopeList(value) {
  const inline = String(value).trim().replace(/^\[|\]$/g, '');
  return inline
    .split(',')
    .map((p) => p.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  const result = { appliesTo: [], audience: undefined, gate: null, scopes: {} };
  if (!lines.length || lines[0].trim() !== '---') return result;
  let inAppliesTo = false;
  let inScopes = false;
  let scopeName = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    if (/^applies-to:\s*$/.test(line)) {
      inAppliesTo = true;
      inScopes = false;
      continue;
    }
    if (/^scopes:\s*$/.test(line)) {
      inScopes = true;
      inAppliesTo = false;
      scopeName = null;
      continue;
    }
    if (inScopes) {
      const named = line.match(/^\s+([A-Za-z0-9][A-Za-z0-9_-]*):\s*(.*)$/);
      if (named) {
        scopeName = named[1].toLowerCase();
        result.scopes[scopeName] = named[2].trim() ? parseScopeList(named[2]) : [];
        continue;
      }
      const nested = line.match(/^\s+-\s+(.+)$/);
      if (nested && scopeName) {
        result.scopes[scopeName].push(nested[1].trim().replace(/^["']|["']$/g, ''));
        continue;
      }
    }
    const item = line.match(/^\s+-\s+(.+)$/);
    if (inAppliesTo && item) {
      result.appliesTo.push(item[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    const audience = line.match(/^audience:\s*(.+?)\s*$/);
    if (audience) {
      result.audience = audience[1].replace(/^["']|["']$/g, '');
      inAppliesTo = false;
      inScopes = false;
      continue;
    }
    // The precondition that decides whether this instruction has anything to
    // say about a file at all. One sentence, answered by the reviewer from the
    // file's content — a glob cannot see that a `.ts` file holds no markup.
    const gate = line.match(/^gate:\s*(.+?)\s*$/);
    if (gate) {
      result.gate = gate[1].replace(/^["']|["']$/g, '') || null;
      inAppliesTo = false;
      inScopes = false;
      continue;
    }
    if (/^\S/.test(line)) {
      inAppliesTo = false;
      inScopes = false;
    }
  }
  return result;
}

function sanitizeBranchName(branch) {
  return branch.replace(/[^A-Za-z0-9._-]/g, '-');
}

function formatTimestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}-${p(d.getMinutes())}`,
  };
}

function git(project, args) {
  return execFileSync('git', ['-C', project, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(project, args) {
  try {
    return git(project, args);
  } catch {
    return null;
  }
}

// preferRemote is for a base that describes the remote (a PR's target branch):
// `origin/<name>` is what GitHub diffs against, a stale local branch of the
// same name is not.
function resolveRef(project, name, preferRemote = false) {
  const order = preferRemote ? [`origin/${name}`, name] : [name, `origin/${name}`];
  for (const ref of order) {
    const full = ref === name ? `refs/heads/${ref}` : `refs/remotes/${ref}`;
    if (tryGit(project, ['rev-parse', '--verify', '--quiet', full]) !== null) return ref;
  }
  return null;
}

// The target branch of the reviewed branch's open PR - only GitHub knows it.
// `github.findOpenPr` reaches the API directly (no CLI); a repo with no GitHub
// remote is never asked, so it neither pays for the call nor warns about one.
function detectPrBase(project, branchName, findPr = github.findOpenPr) {
  const { pr, error } = findPr(project, branchName);
  if (!pr) return { base: null, number: null, error };
  return { base: pr.base, number: pr.number, error: null };
}

function baseCandidates(project) {
  const names = [];
  const head = tryGit(project, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (head) names.push(head.replace('refs/remotes/origin/', ''));
  for (const n of baseBranchNames) if (!names.includes(n)) names.push(n);
  return names;
}

// Every ref that could be the branch's parent: local heads plus origin's
// branches, minus origin/HEAD (an alias, not a branch) and the reviewed branch
// under either name. Capped at the most recently updated ones so a repo with
// hundreds of stale branches does not pay a git call for each of them.
function branchRefs(project, branchName) {
  const out = tryGit(project, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', `--count=${forkCandidateLimit}`, 'refs/heads/', 'refs/remotes/origin/']);
  if (!out) return [];
  return out.split('\n').map((s) => s.trim())
    .filter((ref) => ref && ref !== 'origin/HEAD' && ref !== branchName && ref !== `origin/${branchName}`);
}

// The branch this one was created from, read off the topology: among all other
// branches, the one the reviewed branch is fewest commits ahead of — the one it
// diverged from last. Ties go to the conventional base names in candidate
// order, then to a local ref over its origin twin.
// A candidate that already contains the whole branch counts only when it is one
// of those conventional names, where it means "not diverged from the trunk yet,
// or already merged into it" and an empty diff is the honest answer. The same
// zero from a feature branch means that branch was created FROM the reviewed
// one, and letting a branch's own child become its base would review nothing.
function detectForkBase(project, branchRef, branchName) {
  const preferred = baseCandidates(project);
  let best = null;
  for (const ref of branchRefs(project, branchName)) {
    // Commits the branch has and the candidate does not: 0 means the candidate
    // contains the branch, anything else is how far the branch ran ahead of it.
    const count = Number(tryGit(project, ['rev-list', '--count', branchRef, `^${ref}`]));
    if (!Number.isFinite(count)) continue;
    const rank = preferred.indexOf(ref.replace(/^origin\//, ''));
    if (count === 0 && rank === -1) continue;
    const cand = { ref, count, rank: rank === -1 ? preferred.length : rank, local: !ref.startsWith('origin/') };
    const better = !best || cand.count < best.count
      || (cand.count === best.count && cand.rank < best.rank)
      || (cand.count === best.count && cand.rank === best.rank && cand.local && !best.local);
    if (better) best = cand;
  }
  return best ? best.ref : null;
}

// Conventional bases only (origin/HEAD's branch, main, master, develop, dev),
// nearest merge-base wins. The last resort of detectBaseBranch, and the one
// answer for a branch already merged everywhere: its diff is empty, which is
// the truth about it.
function detectCandidateBase(project, branchRef, branchName) {
  let best = null;
  for (const name of baseCandidates(project)) {
    if (name === branchName) continue;
    const ref = resolveRef(project, name);
    if (!ref || ref === branchRef) continue;
    const mergeBase = tryGit(project, ['merge-base', ref, branchRef]);
    if (!mergeBase) continue;
    const count = Number(tryGit(project, ['rev-list', '--count', `${mergeBase}..${branchRef}`]));
    if (!Number.isFinite(count)) continue;
    if (!best || count < best.count) best = { ref, count };
  }
  return best ? best.ref : null;
}

// The base to diff against, in the order the change will actually be merged:
// 1. the target branch of the branch's open PR — exactly the diff GitHub shows;
// 2. the branch it was forked from — the nearest branch it still diverges from;
// 3. the conventional candidates.
// `source` says which step answered, so the run can report the base it picked.
// Step 2 is skipped for a conventional base branch itself: `master` was not
// forked from anything, and every feature branch merged into it looks like a
// very near fork point, which would make its own children its base.
function detectBaseBranch(project, branchRef, branchName, findPr = github.findOpenPr) {
  const pr = detectPrBase(project, branchName, findPr);
  let unresolvedPrBase = null;
  if (pr.base) {
    const ref = resolveRef(project, pr.base, true);
    if (ref && ref !== branchRef) return { ref, source: 'pr', prNumber: pr.number, apiError: null, unresolvedPrBase };
    unresolvedPrBase = pr.base;
  }
  const rest = { prNumber: pr.number, apiError: pr.error, unresolvedPrBase };
  const fork = baseCandidates(project).includes(branchName) ? null : detectForkBase(project, branchRef, branchName);
  if (fork) return { ref: fork, source: 'fork', ...rest };
  const candidate = detectCandidateBase(project, branchRef, branchName);
  return { ref: candidate, source: candidate ? 'candidate' : null, ...rest };
}

function q(s) {
  return `"${s}"`;
}

// All files under dir, recursive, as project-relative forward-slash paths
// (sorted). `.git` is never entered; everything else is left to skipGlobs.
function listFolderFiles(project, dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(project, full).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return files.sort();
}

// New-file line ranges touched by a diff, read from `git diff -U0` hunk
// headers (@@ -a,b +c,d @@): the authoritative "which lines changed" for
// finding line numbers. Deletion-only hunks (d=0) leave no new-file line
// and are omitted, so a deletion-only diff yields ''.
function parseHunkRanges(diffOutput) {
  const ranges = [];
  for (const line of diffOutput.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    ranges.push(count === 1 ? String(start) : `${start}-${start + count - 1}`);
  }
  return ranges.join(', ');
}

// One `git diff -U0` per target is split into per-file line ranges here, so a
// 150-file diff spawns one git process instead of 150 (each costs ~50-100 ms
// on Windows). Sections come from the `diff --git` headers; the new path is
// read off `+++ b/<path>` (`/dev/null` marks a deletion, which has no new
// lines). Run git with `core.quotepath=false` so this path matches the one
// `--name-status` reported.
function parseDiffRangesByPath(diffOutput) {
  const byPath = new Map();
  for (const section of String(diffOutput || '').split(/^diff --git /m).slice(1)) {
    const m = section.match(/^\+\+\+ (.*)$/m);
    if (!m) continue;
    let target = m[1].trim();
    if (target === '/dev/null') continue;
    if (target.startsWith('"') && target.endsWith('"')) {
      target = target.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    byPath.set(target.replace(/^b\//, ''), parseHunkRanges(section));
  }
  return byPath;
}

// `git diff --raw` carries status, path AND the post-image blob id in one line,
// so a single call replaces `--name-status` and hands `--since-last` its content
// fingerprint: `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>`.
// Renames carry old and new path; the new one is last, like in --name-status.
function parseRawDiff(output) {
  const files = [];
  for (const line of String(output || '').split('\n')) {
    if (!line.startsWith(':')) continue;
    const [meta, ...names] = line.split('\t');
    const parts = meta.slice(1).trim().split(/\s+/);
    const target = names[names.length - 1];
    if (!target) continue;
    // A rename/copy carries the source path first. A path-limited diff shows a
    // renamed file as brand-new, so this pair is the only place the reviewer
    // can see what the file used to be called.
    files.push({
      path: target,
      status: parts[4] ? parts[4][0] : 'M',
      oldPath: names.length > 1 ? names[0] : '',
      blob: parts[3] || '',
    });
  }
  return files;
}

// A checklist item may narrow itself to part of its instruction's scope with a
// leading tag naming one or more entries of the frontmatter `scopes:` map:
// `- {styles} Contrast ratios …` is walked for stylesheets only. Numbering is
// unaffected — `<id>#<n>` still counts every top-level bullet in file order —
// so a rule that does not apply to a file drops out of that file's plan
// instead of costing it a verdict it cannot reach.
const reItemScopeTag = /^\{\s*([A-Za-z0-9][A-Za-z0-9 ,_-]*)\}\s+\S/;

// The checklist of an instruction, item by item: `n` is its `<id>#<n>` address,
// `scopes` the names of its scope tag (empty = wherever the instruction applies).
function parseChecklistItems(file) {
  let body;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  body = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const items = [];
  for (const line of body.split('\n')) {
    if (!/^- \S/.test(line)) continue;
    const tag = line.slice(2).match(reItemScopeTag);
    items.push({
      n: items.length + 1,
      scopes: tag ? tag[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [],
    });
  }
  return items;
}

// How many checklist items an instruction carries: the top-level `- ` bullets
// of its body. The reviewer reports its per-file coverage against this number,
// which turns "I walked every item" from a promise into a checkable figure.
function countChecklistItems(file) {
  return parseChecklistItems(file).length;
}

// Which items of an instruction this file is actually walked against: every
// untagged item, plus the tagged ones whose scope the file falls into. A tag
// naming a scope the instruction never declared keeps the item (a typo must not
// silently delete a rule); `loadInstructions` reports it as a warning.
function matchChecklistItems(items, namedScopes, filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const named = namedScopes || {};
  const selected = [];
  for (const item of items) {
    if (item.scopes.length === 0) {
      selected.push(item.n);
      continue;
    }
    const hit = item.scopes.some((name) => (
      !Object.prototype.hasOwnProperty.call(named, name) || matchesScope(named[name], normalized, false)
    ));
    if (hit) selected.push(item.n);
  }
  return selected;
}

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

// How the reviewer cites one checklist item while ticking it off: `<id>#<n>`,
// n being the n-th top-level `- ` bullet of that instruction. The id is the
// instruction's file name, so a tick line stays readable next to the report.
// `taken` holds the ids already handed out: a collision (a project rulebook
// adding its own `security.md` under `local/`) falls back to the parent folder
// as a prefix and then to a numeric suffix, so ids stay unique and deterministic.
function checklistIdOf(file, taken = new Set()) {
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = slug(path.basename(file, '.md')) || 'instruction';
  const parent = slug(path.basename(path.dirname(file)));
  for (const candidate of [base, parent ? `${parent}-${base}` : '']) {
    if (candidate && !taken.has(candidate)) return candidate;
  }
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// audience: 'review' | 'implement' | undefined (no filtering). An instruction
// declares `audience: implement|review|both` in its frontmatter (default both)
// to control which consumer loads it — e.g. a coding persona is implement-only.
// `instructionsDirs` is one directory or a layered list, lowest priority first:
// the skill's own tree plus, when the reviewed project has one, its
// `.claude/doh/instructions/`. A project file at the same relative path
// (`global/security.md`) REPLACES the skill's file — a project may restate a
// rule its own way — and every other project file is one more instruction.
function loadInstructions(instructionsDirs, audience) {
  const dirs = (Array.isArray(instructionsDirs) ? instructionsDirs : [instructionsDirs])
    .filter(Boolean);
  const warnings = [];
  const list = (dir) => {
    if (!fs.existsSync(dir)) return [];
    const files = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
      }
    };
    walk(dir);
    return files.sort();
  };
  const keep = (file, fm) => {
    const declared = fm.audience === undefined ? 'both' : fm.audience;
    if (!audiences.includes(declared)) {
      warnings.push(`Unknown audience "${fm.audience}" (expected implement|review|both), treating as both: ${file}`);
      return true;
    }
    return !audience || declared === 'both' || declared === audience;
  };
  // Layered by path relative to the bucket, so the order stays alphabetical by
  // instruction name instead of following whichever layer supplied the file.
  const collect = (bucket) => {
    const byRelative = new Map();
    for (const dir of dirs) {
      const root = path.join(dir, bucket);
      for (const file of list(root)) {
        byRelative.set(path.relative(root, file).split(path.sep).join('/'), file);
      }
    }
    return [...byRelative.keys()].sort().map((rel) => byRelative.get(rel));
  };
  // `scopes` carries what narrows an instruction to a subset of the diff:
  // `applies-to` globs and the natural-language `gate`. Locals must declare
  // globs (no globs = never matches); a global without them keeps applying to
  // every file, so narrowing a global is opt-in and silence means "everywhere".
  const scopes = {};
  // A scope tag pointing at a name the frontmatter never declared would silently
  // widen (fail-open) instead of narrowing, and a declared scope no item uses is
  // dead config — both are reported once per instruction, at load time.
  const checkItemScopes = (file, declared) => {
    const items = parseChecklistItems(file);
    const used = new Set();
    for (const item of items) for (const name of item.scopes) used.add(name);
    const unknown = [...used].filter((name) => !Object.prototype.hasOwnProperty.call(declared, name));
    if (unknown.length > 0) {
      warnings.push(`Checklist item scope(s) not declared in the "scopes:" frontmatter (items kept unnarrowed): ${unknown.join(', ')} in ${file}`);
    }
    const unused = Object.keys(declared).filter((name) => !used.has(name));
    if (unused.length > 0) {
      warnings.push(`Declared scope(s) no checklist item uses: ${unused.join(', ')} in ${file}`);
    }
  };
  const globals = [];
  for (const file of collect('global')) {
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!keep(file, fm)) continue;
    checkItemScopes(file, fm.scopes);
    scopes[file] = { appliesTo: fm.appliesTo, gate: fm.gate, itemScopes: fm.scopes };
    globals.push(file);
  }
  const locals = [];
  for (const file of collect('local')) {
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!keep(file, fm)) continue;
    if (splitPatterns(fm.appliesTo).include.length === 0) {
      warnings.push(`Local instruction has no including applies-to pattern and will never match: ${file}`);
    }
    checkItemScopes(file, fm.scopes);
    scopes[file] = { appliesTo: fm.appliesTo, gate: fm.gate, itemScopes: fm.scopes };
    locals.push({ file, appliesTo: fm.appliesTo });
  }
  return { globals, locals, scopes, warnings };
}

// An `applies-to` entry starting with `!` EXCLUDES what it matches. Splitting
// them apart is what lets a broad instruction carve out a folder it has nothing
// to say about (`test-coverage` over every `.ts` except `**/models/**`) without
// enumerating every folder it does cover.
function splitPatterns(patterns) {
  const include = [];
  const exclude = [];
  for (const raw of patterns || []) {
    const p = String(raw).trim();
    if (p.startsWith('!')) exclude.push(p.slice(1).trim());
    else include.push(p);
  }
  return { include, exclude };
}

// Does this file fall inside the instruction's declared scope? `emptyIncludes`
// decides what "no include pattern" means: for a global it is "everywhere"
// (narrowing is opt-in), for a local it is "nowhere" (a local must say what it
// covers). Excludes always win over includes.
function matchesScope(patterns, normalized, emptyIncludes) {
  const { include, exclude } = splitPatterns(patterns);
  if (exclude.some((p) => globToRegExp(p).test(normalized))) return false;
  if (include.length === 0) return emptyIncludes;
  return include.some((p) => globToRegExp(p).test(normalized));
}

function matchLocalInstructions(locals, filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return locals
    .filter((l) => matchesScope(l.appliesTo, normalized, false))
    .map((l) => l.file);
}

// Which global instructions this file is walked against. A global that declares
// no `applies-to` applies to everything (the default, and what every global did
// before scoping existed); one that declares patterns is narrowed exactly like a
// local. This is what stops a one-line polyfill from walking 30 WCAG criteria.
function matchGlobalInstructions(globals, scopes, filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return globals.filter((file) => {
    const patterns = (scopes && scopes[file] && scopes[file].appliesTo) || [];
    return matchesScope(patterns, normalized, true);
  });
}

// Keep only the reportsRetain newest reports so the reports folder does not
// grow without bound across runs. Both output formats count toward the cap, so
// a folder of HTML reports is capped exactly like a folder of Markdown ones.
// Reports live one level deep (one folder per branch); loose reports directly
// in reportsDir are still counted, so folders written before the per-branch
// grouping stay capped too. Best-effort: failures never break a review.
function pruneReports(reportsDir, retain = reportsRetain) {
  // A report always ends with the run stamp (`-YYYY-MM-DD-HH-mm.md|html`), so
  // pruning can share a folder with other artifacts — implementNewFeature's
  // session dirs (`plan.md`, `spec.md`, …) and the project's own
  // `instructions/` — without ever counting or deleting one of them.
  const isReport = (name) => /-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.(?:md|html)$/.test(name);
  let entries;
  try {
    entries = fs.readdirSync(reportsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const branchDirs = [];
  const files = [];
  for (const entry of entries) {
    // `instructions/` is the project's own rulebook living next to the reports:
    // its .md files are not reports and the folder is not a branch folder.
    if (entry.name === 'instructions') continue;
    if (entry.isDirectory()) branchDirs.push(path.join(reportsDir, entry.name));
    else if (isReport(entry.name)) files.push(path.join(reportsDir, entry.name));
  }
  for (const dir of branchDirs) {
    try {
      for (const name of fs.readdirSync(dir)) if (isReport(name)) files.push(path.join(dir, name));
    } catch {}
  }
  if (files.length > retain) {
    const stamped = files.map((full) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {}
      return { full, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const { full } of stamped.slice(retain)) {
      try {
        fs.unlinkSync(full);
      } catch {}
    }
  }
  // A branch folder the pruning above emptied goes with its reports; rmdir on a
  // folder that still holds something throws and is ignored.
  for (const dir of branchDirs) {
    try {
      fs.rmdirSync(dir);
    } catch {}
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// In project mode reports live inside the reviewed repo's `.claude/doh/`, a
// folder also shared with the implementNewFeature skill (plans, screenshots,
// auth.json, pipeline-state.json). Keep those run artifacts out of git with a
// catch-all .gitignore — but not `instructions/`: the project's own rulebook is
// meant to be versioned and shared like any other source file, and the
// .gitignore itself is committed so every clone behaves the same.
// Best-effort; a pre-existing .gitignore is left untouched.
const DOH_GITIGNORE = '*\n!.gitignore\n!instructions/\n!instructions/**\n';

function ensureDohGitignore(dohDir) {
  const gi = path.join(dohDir, '.gitignore');
  try {
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, DOH_GITIGNORE);
  } catch {}
}

function buildContext(options) {
  const project = path.resolve(options.project || process.cwd());
  const skillDir = options.skillDir || defaultSkillDir;
  const now = options.now || new Date();
  const findPr = options.findOpenPr || github.findOpenPr;
  let apiWarned = false;
  // Decided before the early error returns below, so the reported format is
  // never a default the caller did not ask for.
  const wantsHtml = options.output !== 'md';
  const result = {
    outputFormat: wantsHtml ? 'html' : 'md',
    globalInstructions: [],
    localInstructionsCatalog: [],
    checklistIds: {},
    checklistGates: {},
    projectInstructionsDir: null,
    claudeMd: null,
    warnings: [],
    targets: [],
    errors: [],
  };

  if (tryGit(project, ['rev-parse', '--git-dir']) === null) {
    result.errors.push(`Not a git repository: ${project}`);
    return result;
  }
  if (tryGit(project, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) {
    result.errors.push('Repository has no commits yet.');
    return result;
  }

  // The project may extend or override the skill's rulebook from its own
  // `.claude/doh/instructions/` (same `global/` + `local/` layout), so a repo
  // carries its conventions next to its code instead of in the shared skill.
  const projectInstructionsDir = path.join(project, '.claude', 'doh', 'instructions');
  const hasProjectInstructions = isDirectory(projectInstructionsDir);
  const instructions = loadInstructions(
    [path.join(skillDir, 'instructions'), hasProjectInstructions ? projectInstructionsDir : null],
    'review',
  );
  const ts = formatTimestamp(now);
  // When the reviewed project already has a `.claude/` folder, write reports
  // into `<project>/.claude/doh/` (created on demand) instead of the skill's
  // own `reports/` dir, so real projects collect their artifacts under doh.
  const projectClaudeDir = path.join(project, '.claude');
  const useProjectDoh = isDirectory(projectClaudeDir);
  const reportsDir = useProjectDoh
    ? path.join(projectClaudeDir, 'doh')
    : path.join(skillDir, 'reports');
  // Every report of a branch lands in that branch's own folder, so a reports
  // dir shared by many branches stays browsable. The file name keeps the branch
  // prefix on purpose: the HTML page namespaces its localStorage by file name,
  // and two branches reviewed in the same minute would otherwise collide.
  // The Markdown report is always the working file the reviewer writes to. In
  // html mode `render-report.cjs` turns it into `htmlReportPath` at the end of
  // the run and removes it, so the analysis steps never see the format choice.
  const reportPaths = (branchName, suffix = '') => {
    const branchDir = sanitizeBranchName(branchName);
    const name = suffix ? `${branchDir}-${suffix}` : branchDir;
    const reportPath = path.join(reportsDir, branchDir, `${name}-${ts.date}-${ts.time}.md`);
    return { reportPath, htmlReportPath: wantsHtml ? reportPath.replace(/\.md$/, '.html') : null };
  };
  const claudeMdPath = path.join(project, 'CLAUDE.md');
  result.globalInstructions = instructions.globals;
  result.projectInstructionsDir = hasProjectInstructions ? projectInstructionsDir : null;
  result.claudeMd = fs.existsSync(claudeMdPath) ? claudeMdPath : null;
  result.warnings = [...instructions.warnings];
  if (instructions.globals.length === 0 && instructions.locals.length === 0) {
    result.warnings.push('instructions/global and instructions/local are empty - review uses only the project CLAUDE.md and the universal points (cross-file consistency, regressions, readability).');
  }

  // Checklist sizes are read once per run and turned into a per-file total, so
  // the reviewer can state coverage as `<checked>/<total>` per file.
  const itemCache = new Map();
  const parsedItemsOf = (file) => {
    if (!itemCache.has(file)) itemCache.set(file, parseChecklistItems(file));
    return itemCache.get(file);
  };
  const itemsOf = (file) => parsedItemsOf(file).length;
  const scopes = instructions.scopes || {};
  // Which items of an instruction a given file walks: the tagged ones whose
  // scope it falls outside are not its rules and never reach its plan.
  const itemsFor = (file, filePath) =>
    matchChecklistItems(parsedItemsOf(file), scopes[file] && scopes[file].itemScopes, filePath);

  // Ids are handed out over EVERY loaded instruction, matched or not, so the
  // same instruction keeps the same id no matter what a given diff touches.
  const idOf = new Map();
  const takenIds = new Set();
  for (const file of [...instructions.globals, ...instructions.locals.map((l) => l.file)]) {
    if (idOf.has(file)) continue;
    const id = checklistIdOf(file, takenIds);
    takenIds.add(id);
    idOf.set(file, id);
  }
  // The ticking plan of one file: `general:1-13` names the items of that
  // instruction this file is walked against, `accessibility:6-9,12` a checklist
  // its scope tags narrowed. An instruction the file takes no item from is left
  // out — there is nothing to tick in it.
  const planOf = (files, filePath) => files
    .map((f) => ({ id: idOf.get(f), numbers: itemsFor(f, filePath) }))
    .filter((entry) => entry.numbers.length > 0)
    .map((entry) => `${entry.id}:${formatItemSpec(entry.numbers)}`);

  // Every run records the post-image blob of each reviewed file next to the
  // report, so the next `--since-last` run can drop files whose content never
  // moved. Written even when the flag is off — the first incremental run needs
  // something to compare against — and trusted only as far as the previous run
  // got: a review that died half-way still recorded the whole file list.
  const pendingSnapshots = new Map();
  const snapshotPathOf = (target) =>
    path.join(path.dirname(target.reportPath), `.last-review-${target.kind}.json`);
  const registerTarget = (target, currentBlobs) => {
    if (currentBlobs) pendingSnapshots.set(target, currentBlobs);
    if (options.sinceLast && !currentBlobs) {
      result.warnings.push(`[${target.branch}] --since-last has no effect in folder mode - every file is reviewed.`);
    } else if (options.sinceLast) {
      let previous = null;
      try {
        previous = JSON.parse(fs.readFileSync(snapshotPathOf(target), 'utf8'));
      } catch {}
      if (!previous || !previous.files) {
        result.warnings.push(`[${target.branch}] --since-last: no previous review recorded for this target - reviewing every file.`);
      } else {
        const unchanged = target.files
          .filter((f) => previous.files[f.path] && previous.files[f.path] === currentBlobs.get(f.path))
          .map((f) => f.path);
        if (unchanged.length > 0) {
          const shown = unchanged.slice(0, 10).join(', ');
          result.warnings.push(`[${target.branch}] --since-last: ${unchanged.length} file(s) unchanged since the previous review and skipped: ${shown}${unchanged.length > 10 ? `, (+${unchanged.length - 10} more)` : ''}`);
          target.unchangedSinceLastReview = unchanged;
          target.previousReportPath = previous.reportPath || null;
          target.files = target.files.filter((f) => !unchanged.includes(f.path));
        }
      }
    }
    result.targets.push(target);
  };

  const quiet = ['-c', 'core.quotepath=false'];
  const gitc = (args) => `git -C ${q(project)} ${args}`;
  // Commands are emitted ONCE per target as templates with a `<path>`
  // placeholder (`target.commands.diff` / `.show`) instead of two full command
  // strings per file — the reviewer substitutes each file's `path` into them.
  // Status decides applicability: added files have no diff (every line is
  // new), deleted files have no content to show. `show` pipes through
  // `cat -n` so finding line numbers can be read off the output.
  // changedLines: new-file line ranges precomputed from `git diff -U0`
  // (rangesArgsFor), so the reviewer never derives them from hunks itself;
  // null for added (every line is new) and deleted (no new file) files.
  const makeFiles = (rawFiles, rangesByPath) => rawFiles.map((f) => {
    // An instruction whose every item the file's scope tags took away has
    // nothing to say about it, so it is not one of the file's instructions —
    // neither to read nor to tick.
    const applicable = (file) => itemsFor(file, f.path).length > 0;
    const locals = matchLocalInstructions(instructions.locals, f.path).filter(applicable);
    // Globals are matched per file too: one that declares `applies-to` is
    // narrowed like a local, one that declares none still applies everywhere.
    const globals = matchGlobalInstructions(instructions.globals, scopes, f.path).filter(applicable);
    const plan = [...planOf(globals, f.path), ...planOf(locals, f.path)];
    return {
      path: f.path,
      status: f.status,
      // Only a rename/copy has one; the mechanical-change gate compares the two
      // names (and their folders) against the naming instructions.
      oldPath: f.oldPath || null,
      localInstructions: locals,
      // The instructions of this file turned into a ticking plan: one
      // `<id>:<items>` entry per instruction, globals first, then the matched
      // locals — the reviewer walks it item by item and ticks each one off.
      checklist: plan,
      // The globals this file's path took it out of, so the plan being shorter
      // than the rulebook reads as a decision instead of an omission.
      globalInstructionsSkipped: instructions.globals.filter((g) => !globals.includes(g)),
      // Matched global + matched local checklist items this file must be walked
      // against; the reviewer reports `<checked>/<checklistTotal>` per file.
      checklistTotal: globals.reduce((n, p) => n + itemsFor(p, f.path).length, 0)
        + locals.reduce((n, p) => n + itemsFor(p, f.path).length, 0),
      changedLines: f.status === 'A' || f.status === 'D'
        ? null
        : (rangesByPath.get(f.path) || ''),
    };
  });
  const partition = (rawFiles) => {
    const kept = [];
    const skipped = [];
    for (const f of rawFiles) (isSkippedPath(f.path) ? skipped : kept).push(f);
    return { kept, skipped: skipped.map((f) => f.path) };
  };

  const addBranchTarget = (branchName) => {
    const branchRef = resolveRef(project, branchName);
    if (!branchRef) {
      result.errors.push(`Branch not found (local or origin): ${branchName}`);
      return;
    }
    const base = detectBaseBranch(project, branchRef, branchName, findPr);
    // One warning per run, not per branch: the API fails the same way for all.
    if (base.apiError && !apiWarned) {
      apiWarned = true;
      result.warnings.push(`Could not ask GitHub which branch the pull request targets (${base.apiError}) - the base branch comes from git history instead. A private repository needs a token: set GH_TOKEN, or store a github.com credential (any HTTPS push does).`);
    }
    if (base.unresolvedPrBase) {
      result.warnings.push(`[${branchName}] The open PR targets "${base.unresolvedPrBase}", which exists neither locally nor as origin/${base.unresolvedPrBase} (fetch it) - falling back to the base detected from git history.`);
    }
    const baseRef = base.ref;
    if (!baseRef) {
      result.errors.push(`Cannot detect base branch for: ${branchName} (no open PR, no branch it forked from, and no origin/HEAD, main, master, develop or dev candidate found)`);
      return;
    }
    const range = `${baseRef}...${branchRef}`;
    const raw = parseRawDiff(tryGit(project, [...quiet, 'diff', '--raw', range]) || '');
    const { kept, skipped } = partition(raw);
    registerTarget({
      kind: 'branch',
      branch: branchName,
      baseBranch: baseRef,
      baseSource: base.source,
      prNumber: base.source === 'pr' ? base.prNumber : null,
      ...reportPaths(branchName),
      commands: {
        diff: gitc(`diff ${range} -- ${q('<path>')}`),
        show: `${gitc(`show ${q(`${branchRef}:<path>`)}`)} | cat -n`,
      },
      files: makeFiles(kept, parseDiffRangesByPath(tryGit(project, [...quiet, 'diff', '-U0', range]) || '')),
      skipped,
    }, new Map(raw.map((f) => [f.path, f.blob])));
  };

  if (options.mode === 'staged') {
    const branchName = tryGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
    // Stage every pending change first so `staged` reviews the whole working
    // tree (tracked edits + untracked files), not just what was already in the
    // index. This is the skill's only intended mutation of the repo, and it
    // touches the index alone (never a commit or a file edit). Best-effort: a
    // failure degrades to reviewing whatever is already staged.
    if (tryGit(project, ['add', '.']) === null) {
      result.warnings.push('Could not run `git add .`; the staged review covers only changes already in the index.');
    }
    const raw = parseRawDiff(tryGit(project, [...quiet, 'diff', '--cached', '--raw']) || '');
    const { kept, skipped } = partition(raw);
    registerTarget({
      kind: 'staged',
      branch: branchName,
      // No base: staged reviews the uncommitted changes themselves (the index
      // against HEAD), so no branch comparison is involved.
      baseBranch: null,
      baseSource: null,
      prNumber: null,
      ...reportPaths(branchName, 'staged'),
      commands: {
        diff: gitc(`diff --cached -- ${q('<path>')}`),
        show: `${gitc(`show ${q(':<path>')}`)} | cat -n`,
      },
      files: makeFiles(kept, parseDiffRangesByPath(tryGit(project, [...quiet, 'diff', '-U0', '--cached']) || '')),
      skipped,
    }, new Map(raw.map((f) => [f.path, f.blob])));
  } else if (options.mode === 'branches') {
    const names = [...new Set(String(options.branches || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
    if (names.length === 0) result.errors.push('No branches given (expected --branches="a,b;c").');
    for (const name of names) addBranchTarget(name);
  } else if (options.mode === 'folder') {
    // Folder mode reviews the working tree instead of a diff: every file under
    // --path (recursive, minus skipGlobs) is emitted as an added file, so the
    // whole folder gets the added-file treatment (show template only).
    const rel = String(options.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const abs = path.resolve(project, rel);
    if (!rel) {
      result.errors.push('No folder given (expected --path="src/app").');
    } else if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      result.errors.push(`Folder not found: ${rel}`);
    } else {
      const branchName = tryGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
      const { kept, skipped } = partition(listFolderFiles(project, abs).map((p) => ({ path: p, status: 'A' })));
      registerTarget({
        kind: 'folder',
        branch: branchName,
        baseBranch: null,
        baseSource: null,
        prNumber: null,
        folder: rel,
        ...reportPaths(branchName, `folder-${sanitizeBranchName(rel)}`),
        commands: {
          diff: null,
          show: `cat ${q(`${project.replace(/\\/g, '/')}/<path>`)} | cat -n`,
        },
        files: makeFiles(kept, new Map()),
        skipped,
      }, null);
    }
  } else {
    const branchName = tryGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branchName || branchName === 'HEAD') {
      result.errors.push('Detached HEAD - check out a branch or pass an explicit branch list.');
    } else {
      addBranchTarget(branchName);
    }
  }

  // Surface files that matched no local instruction — the files a reviewer is
  // most tempted to skim; global checklists still fully apply to them.
  for (const target of result.targets) {
    const noLocal = target.files.filter((f) => f.localInstructions.length === 0).map((f) => f.path);
    if (noLocal.length > 0) {
      // Capped: a 200-file diff would otherwise spend thousands of tokens on one
      // warning line the reviewer has to read and translate.
      const shown = noLocal.slice(0, 10).join(', ');
      const rest = noLocal.length > 10 ? `, (+${noLocal.length - 10} more)` : '';
      result.warnings.push(`[${target.branch}] ${noLocal.length} file(s) match no local instruction (global checklists still apply): ${shown}${rest}`);
    }
  }

  // Deduplicate matched local instruction paths into one catalog; per-file
  // localInstructions become indexes into it (read each catalog file once).
  const catalog = new Set();
  for (const target of result.targets) {
    for (const file of target.files) for (const p of file.localInstructions) catalog.add(p);
  }
  result.localInstructionsCatalog = [...catalog].sort();
  // Globals are narrowed to the ones at least one reviewed file actually walks:
  // a diff of stylesheets never reads the TypeScript rulebook. Every file still
  // names what it was taken out of in its own `globalInstructionsSkipped`.
  if (result.targets.length > 0) {
    const usedGlobals = new Set();
    for (const target of result.targets) {
      for (const file of target.files) {
        for (const g of matchGlobalInstructions(instructions.globals, scopes, file.path)) {
          if (itemsFor(g, file.path).length > 0) usedGlobals.add(g);
        }
      }
    }
    result.globalInstructions = instructions.globals.filter((g) => usedGlobals.has(g));
  }
  // Which instruction each checklist id stands for — only the instructions this
  // run actually loads, so the dictionary matches the rulebook of Step 2.
  result.checklistIds = Object.fromEntries(
    [...result.globalInstructions, ...result.localInstructionsCatalog]
      .filter((f) => itemsOf(f) > 0)
      .map((f) => [idOf.get(f), f]),
  );
  // The `gate:` sentence of every instruction that declares one. The reviewer
  // answers it once per file before walking that instruction's items: a failed
  // gate collapses the whole instruction into one ticked range line.
  result.checklistGates = Object.fromEntries(
    [...result.globalInstructions, ...result.localInstructionsCatalog]
      .filter((f) => itemsOf(f) > 0 && scopes[f] && scopes[f].gate)
      .map((f) => [idOf.get(f), scopes[f].gate]),
  );
  const indexOf = new Map(result.localInstructionsCatalog.map((p, i) => [p, i]));
  for (const target of result.targets) {
    for (const file of target.files) {
      file.localInstructions = file.localInstructions.map((p) => indexOf.get(p));
    }
  }

  if (result.targets.length > 0) {
    fs.mkdirSync(reportsDir, { recursive: true });
    if (useProjectDoh) ensureDohGitignore(reportsDir);
    // Pruning runs in both locations: the project's `.claude/doh/` is shared
    // with other artifacts, but only run-stamped report names are ever counted
    // or deleted (see pruneReports), so nothing else there is at risk.
    pruneReports(reportsDir);
    // After the pruning, so an emptied branch folder is not removed right after
    // being created for this run.
    for (const target of result.targets) {
      fs.mkdirSync(path.dirname(target.reportPath), { recursive: true });
      const blobs = pendingSnapshots.get(target);
      if (!blobs) continue;
      try {
        fs.writeFileSync(snapshotPathOf(target), JSON.stringify({
          at: now.toISOString(),
          reportPath: target.reportPath,
          files: Object.fromEntries(blobs),
        }));
      } catch {}
    }
  }
  return result;
}

function main() {
  let context;
  try {
    context = buildContext(parseArgs(process.argv.slice(2)));
  } catch (err) {
    context = { targets: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(JSON.stringify(context) + '\n');
  process.exit(context.targets.length > 0 ? 0 : 1);
}

module.exports = { parseArgs, globToRegExp, parseFrontmatter, sanitizeBranchName, formatTimestamp, git, tryGit, resolveRef, detectPrBase, detectForkBase, detectCandidateBase, detectBaseBranch, parseRawDiff, parseDiffRangesByPath, countChecklistItems, parseChecklistItems, matchChecklistItems, formatItemSpec, checklistIdOf, parseHunkRanges, loadInstructions, splitPatterns, matchesScope, matchLocalInstructions, matchGlobalInstructions, isSkippedPath, listFolderFiles, pruneReports, buildContext };

if (require.main === module) main();
