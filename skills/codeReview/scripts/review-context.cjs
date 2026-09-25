#!/usr/bin/env node
'use strict';

// Deterministic mechanics for the doh:codeReview skill: argument parsing,
// glob matching, instruction frontmatter parsing, base-branch detection and
// the review-context JSON consumed by SKILL.md.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const github = require('./github.cjs');
const duplication = require('./duplication-scan.cjs');

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
  // Code generated INTO the source tree, by the conventions that say so without
  // ambiguity. A generated client is machine-written, so a finding there is not
  // actionable - the fix belongs to the schema or the generator - and at ~100
  // checklist items plus one part file per file it is the largest avoidable cost a
  // review can carry. A bare `generated/` folder is deliberately NOT here: the name
  // alone does not prove nobody maintains it by hand.
  '**/__generated__/**', '**/*.generated.*', '**/*.gen.ts', '**/*.g.ts',
  '**/*.pb.ts', '**/*_pb.ts', '**/*_pb.js',
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
  const unknown = [];
  for (const arg of argv) {
    // Incremental review: only the files whose content moved since the previous
    // review of this target (see the snapshot written next to the report).
    if (arg === '--since-last') { args.sinceLast = true; continue; }
    const m = arg.match(/^--([a-z]+)=(.*)$/);
    // Anything unrecognised is refused rather than skipped: the user-facing flag
    // is `--only-md` while the script takes `--output=md`, so a silently dropped
    // argument would hand back an html context for a run the user asked to keep
    // in Markdown - a wrong result that looks like a correct one.
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'mode') args.mode = m[2];
    else if (m[1] === 'branches') args.branches = m[2];
    else if (m[1] === 'path') args.path = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'output') args.output = m[2];
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --mode, --branches, --path, --project, --output, --since-last; the skill's own --only-md maps to --output=md)`);
  }
  if (!['auto', 'staged', 'branches', 'folder'].includes(args.mode)) {
    throw new Error(`Unknown --mode=${args.mode} (expected auto|staged|branches|folder)`);
  }
  if (!['html', 'md'].includes(args.output)) {
    throw new Error(`Unknown --output=${args.output} (expected md|html)`);
  }
  return args;
}

// The compiled globs of one run, keyed by the pattern text. The rulebook holds a
// few dozen patterns and a review asks about every one of them for every changed
// file, three times over (does this instruction apply, which of its items does
// this file walk, how many is that) - so an uncached compile here is tens of
// thousands of `new RegExp` calls for one context build, and half a second of a
// 300-file diff went nowhere else. The returned regexes carry no `g`/`y` flag, so
// they hold no lastIndex and sharing one between callers is safe.
const globCache = new Map();

function globToRegExp(pattern) {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const compiled = compileGlob(pattern);
  globCache.set(pattern, compiled);
  return compiled;
}

function compileGlob(pattern) {
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
  const result = { appliesTo: [], appliesToDeclared: false, audience: undefined, gate: null, findings: null, scopes: {} };
  if (!lines.length || lines[0].trim() !== '---') return result;
  let inAppliesTo = false;
  let inScopes = false;
  let scopeName = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    // Declared is not the same as readable: an inline `applies-to: **/*.ts` or a
    // mis-indented list leaves the key present and the pattern list empty, which
    // means something very different for a global than for a local.
    if (/^applies-to:/.test(line)) result.appliesToDeclared = true;
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
    // How the instruction's breaches in one file are counted: `per-file` makes them one
    // finding. Absent, every item is its own requirement and its own finding.
    const findings = line.match(/^findings:\s*(.+?)\s*$/);
    if (findings) {
      result.findings = findings[1].replace(/^["']|["']$/g, '');
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

// The buffer is sized for a whole target's patch: at the 1 MB default a large diff
// (a regenerated lockfile is enough) made git fail, and every caller here reads a
// failure as "no output" - no changed lines, no per-file patches, silently.
function git(project, args) {
  return execFileSync('git', ['-C', project, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
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
// How far the branch runs ahead of every candidate, in ONE git call.
// `%(ahead-behind:<commit>)` prints "<ahead> <behind>" per ref, and `behind` -
// the commits <commit> has that the ref does not - is exactly what the per-ref
// `rev-list --count <branch> ^<ref>` below computes. Sixty candidates used to be
// sixty process spawns, which on Windows is most of a second per reviewed
// branch, paid again for every branch in a `--branches=a,b,c` run.
// The atom needs git 2.41; an older one fails the whole call, and a line that
// does not parse means the answer is not trustworthy as a whole - either way
// the caller falls back to asking ref by ref.
function aheadCounts(project, branchRef) {
  const out = tryGit(project, ['for-each-ref',
    `--format=%(refname:short) %(ahead-behind:${branchRef})`,
    '--sort=-committerdate', `--count=${forkCandidateLimit}`,
    'refs/heads/', 'refs/remotes/origin/']);
  if (out === null) return null;
  const counts = new Map();
  for (const line of out.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const m = text.match(/^(\S+) (\d+) (\d+)$/);
    if (!m) return null;
    counts.set(m[1], Number(m[3]));
  }
  return counts.size ? counts : null;
}

function detectForkBase(project, branchRef, branchName) {
  const preferred = baseCandidates(project);
  const counts = aheadCounts(project, branchRef);
  let best = null;
  for (const ref of branchRefs(project, branchName)) {
    // Commits the branch has and the candidate does not: 0 means the candidate
    // contains the branch, anything else is how far the branch ran ahead of it.
    const count = counts && counts.has(ref)
      ? counts.get(ref)
      : countOf(tryGit(project, ['rev-list', '--count', branchRef, `^${ref}`]));
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
    const count = countOf(tryGit(project, ['rev-list', '--count', `${mergeBase}..${branchRef}`]));
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

// `tryGit` answers null when the command failed, and `Number(null)` is 0: a
// perfectly finite count that every `Number.isFinite` guard below waves through.
// A shallow clone whose history does not reach the merge base is the ordinary way
// to get there, and the answer it produces - zero commits apart - is exactly the
// one that makes a wrong branch look like the right base. Counts are parsed here
// instead, where a failed call stays NaN and the caller skips that candidate.
function countOf(out) {
  const text = out === null || out === undefined ? '' : String(out).trim();
  return text === '' ? NaN : Number(text);
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

// A C-quoted path of a diff header (`"src/a\tb.ts"`, `"\303\251.ts"` without
// core.quotepath=false) back to the name it spells.
function unquoteGitPath(p) {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\' || i === body.length - 1) {
      bytes.push(...Buffer.from(body[i], 'utf8'));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(escapes[next] !== undefined ? escapes[next] : next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Which file one `diff --git` section of a patch is about: the post-image path
// (`+++ b/<path>`), the pre-image one for a deletion (`+++ /dev/null`), and for a
// section with no content lines (a pure rename, a mode change, a binary file) the
// `rename to`/`copy to` line or the header itself, whose two halves are the same
// path when nothing was renamed.
function patchPathOf(section) {
  // Only the lines before the first hunk: an added line reading `++ x` is `+++ x`.
  const lines = section.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  const header = firstHunk < 0 ? lines : lines.slice(0, firstHunk);
  const field = (prefix) => {
    const line = header.find((l) => l.startsWith(prefix));
    return line === undefined ? null : unquoteGitPath(line.slice(prefix.length).replace(/\t.*$/, '').replace(/\r$/, ''));
  };
  const plus = field('+++ ');
  if (plus !== null && plus !== '/dev/null') return plus.replace(/^b\//, '');
  const minus = field('--- ');
  if (minus !== null && minus !== '/dev/null') return minus.replace(/^a\//, '');
  const moved = field('rename to ') ?? field('copy to ');
  if (moved !== null) return moved;
  const both = header[0].slice('diff --git '.length).replace(/\r$/, '');
  const quoted = both.match(/^"(?:[^"\\]|\\.)*" ("(?:[^"\\]|\\.)*")$/);
  if (quoted) return unquoteGitPath(quoted[1]).replace(/^b\//, '');
  const half = (both.length - 1) / 2;
  if (Number.isInteger(half) && both[half] === ' ' && both.slice(2, half) === both.slice(half + 3)) {
    return both.slice(half + 3);
  }
  return null;
}

// One `git diff` of a whole target cut into the patch of each file: a process per
// file costs ~50-100 ms on Windows, and a pathspec-limited diff shows a renamed file
// as brand-new, while the whole patch pairs it with the name it had. A path met twice
// (a type change is a deletion plus an addition) keeps both sections.
function splitPatchByPath(patch) {
  const byPath = new Map();
  for (const section of String(patch || '').split(/^(?=diff --git )/m)) {
    if (!section.startsWith('diff --git ')) continue;
    const p = patchPathOf(section);
    if (p === null) continue;
    const text = section.endsWith('\n') ? section : `${section}\n`;
    byPath.set(p, (byPath.get(p) || '') + text);
  }
  return byPath;
}

// An instruction as the reviewer reads it: every top-level `- ` bullet prefixed with
// the `<id>#<n>` it is ticked and cited by, counted exactly as parseChecklistItems
// counts. Numbering twenty-odd bullets by eye, or through a shell whose output may
// arrive compressed, is where a tick and a finding came to name the wrong item.
function numberChecklist(text, id) {
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const head = fm ? fm[0] : '';
  let n = 0;
  const body = text.slice(head.length).split('\n')
    .map((line) => (/^- \S/.test(line) ? `- ${id}#${++n}: ${line.slice(2)}` : line))
    .join('\n');
  return head + body;
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
// A name written `+name` REACHES instead of narrowing: the item is also walked
// for every file of that scope, even one outside the instruction's `applies-to`.
// A rule is often broken in a file its own instruction never covers - a guard
// factory is invoked (or not) in the routes file, a pipe goes missing from a
// component's `imports`, a translation key is concatenated in a component - and
// without the reach that finding had no plan item to be reported under.
const reItemScopeTag = /^\{\s*(\+?\s*[A-Za-z0-9][A-Za-z0-9 ,_+-]*)\}\s+\S/;

// The checklist of an instruction, item by item: `n` is its `<id>#<n>` address,
// `scopes` the narrowing names of its scope tag (empty = wherever the instruction
// applies), `reach` its `+name` names (the scopes it is carried to beyond that),
// `text` the item without that tag - what a report's `<id>#<n>` rule expands to.
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
    const names = tag ? tag[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
    items.push({
      n: items.length + 1,
      scopes: names.filter((s) => !s.startsWith('+')),
      reach: names.filter((s) => s.startsWith('+')).map((s) => s.slice(1).trim()).filter(Boolean),
      text: (tag ? line.slice(2).replace(/^\{[^}]*\}\s+/, '') : line.slice(2)).trim(),
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

// Which items of an instruction this file is actually walked against. Inside the
// instruction's own scope (`inScope`): every untagged item, plus the tagged ones
// whose narrowing scope the file falls into. Anywhere: the items one of whose
// `+name` scopes the file falls into. A narrowing name the instruction never
// declared keeps the item (a typo must not silently delete a rule); an undeclared
// reaching name reaches nothing (a typo must not spread a rule over the whole
// diff). `loadInstructions` reports both as warnings.
function matchChecklistItems(items, namedScopes, filePath, inScope = true) {
  const normalized = filePath.replace(/\\/g, '/');
  const named = namedScopes || {};
  const declared = (name) => Object.prototype.hasOwnProperty.call(named, name);
  const selected = [];
  for (const item of items) {
    const reach = item.reach || [];
    if (reach.some((name) => declared(name) && matchesScope(named[name], normalized, false))) {
      selected.push(item.n);
      continue;
    }
    if (!inScope) continue;
    if (item.scopes.length === 0) {
      selected.push(item.n);
      continue;
    }
    const hit = item.scopes.some((name) => !declared(name) || matchesScope(named[name], normalized, false));
    if (hit) selected.push(item.n);
  }
  return selected;
}

// The items of one loaded instruction a file walks, own scope and reach together:
// `scope` is the instruction's `loadInstructions` entry, `isGlobal` decides what an
// `applies-to` without an including pattern means (see matchesScope). The review
// and implementNewFeature both ask this, so code is written against exactly the
// rules it is later reviewed against.
function itemsWalkedBy(items, scope, isGlobal, filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const inScope = matchesScope((scope && scope.appliesTo) || [], normalized, isGlobal);
  return matchChecklistItems(items, scope && scope.itemScopes, normalized, inScope);
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
    const reaching = new Set();
    for (const item of items) {
      for (const name of item.scopes) used.add(name);
      for (const name of item.reach) reaching.add(name);
    }
    const isDeclared = (name) => Object.prototype.hasOwnProperty.call(declared, name);
    const unknown = [...used].filter((name) => !isDeclared(name));
    if (unknown.length > 0) {
      warnings.push(`Checklist item scope(s) not declared in the "scopes:" frontmatter (items kept unnarrowed): ${unknown.join(', ')} in ${file}`);
    }
    const unknownReach = [...reaching].filter((name) => !isDeclared(name));
    if (unknownReach.length > 0) {
      warnings.push(`Checklist item reach scope(s) not declared in the "scopes:" frontmatter (the items reach no file outside applies-to): ${unknownReach.map((name) => `+${name}`).join(', ')} in ${file}`);
    }
    const unused = Object.keys(declared).filter((name) => !used.has(name) && !reaching.has(name));
    if (unused.length > 0) {
      warnings.push(`Declared scope(s) no checklist item uses: ${unused.join(', ')} in ${file}`);
    }
  };
  // A declared but unreadable `applies-to` fails in opposite directions, and
  // silently in both: a global falls back to matching everything, a local to
  // matching nothing.
  // Brace alternation is the mistake this glob engine cannot warn about by itself:
  // `**/*.{ts,html}` is a perfectly good-looking pattern that matches NOTHING here,
  // because braces are literal (see the syntax the README documents). Nothing else
  // would notice - the pattern is textually an including one, so the check below
  // stays quiet and the instruction simply never applies to a file again.
  const checkBraces = (file, fm) => {
    const patterns = [...fm.appliesTo, ...Object.values(fm.scopes || {}).flat()];
    const braced = [...new Set(patterns.filter((g) => /[{}]/.test(String(g))))];
    if (braced.length === 0) return;
    warnings.push(`Brace alternation is not supported and matches nothing - write one pattern per alternative (${braced.join(', ')}): ${file}`);
  };
  const checkAppliesTo = (file, fm, bucket) => {
    if (!fm.appliesToDeclared || fm.appliesTo.length > 0) return;
    const effect = bucket === 'global'
      ? 'so this global now applies to EVERY reviewed file instead of the subset you meant'
      : 'so this local now matches nothing';
    warnings.push(`\"applies-to\" is declared but no pattern could be read from it (entries must be a block list of \"  - <glob>\" lines), ${effect}: ${file}`);
  };
  // An instruction whose checklist has no top-level "- " bullet is never walked:
  // the reviewer has nothing to tick, so the file is loaded and then ignored.
  const checkItems = (file) => {
    if (parseChecklistItems(file).length === 0) {
      warnings.push(`No checklist items found (items must be top-level \"- \" bullets; \"*\" and \"+\" are not counted), so this instruction is never walked: ${file}`);
    }
  };
  // `per-file` is the one value that changes anything, so a misspelt one would silently leave
  // a file's single defect to be split into a finding per item.
  const checkFindings = (file, fm) => {
    if (fm.findings !== null && fm.findings !== 'per-file') {
      warnings.push(`Unknown findings "${fm.findings}" (expected per-file), treating every item as its own finding: ${file}`);
    }
  };
  const globals = [];
  for (const file of collect('global')) {
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!keep(file, fm)) continue;
    checkItemScopes(file, fm.scopes);
    checkAppliesTo(file, fm, 'global');
    checkBraces(file, fm);
    checkItems(file);
    checkFindings(file, fm);
    scopes[file] = { appliesTo: fm.appliesTo, gate: fm.gate, findings: fm.findings, itemScopes: fm.scopes };
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
    checkAppliesTo(file, fm, 'local');
    checkBraces(file, fm);
    checkItems(file);
    checkFindings(file, fm);
    scopes[file] = { appliesTo: fm.appliesTo, gate: fm.gate, findings: fm.findings, itemScopes: fm.scopes };
    locals.push({ file, appliesTo: fm.appliesTo });
  }
  return { globals, locals, scopes, warnings };
}

// An `applies-to` entry starting with `!` EXCLUDES what it matches. Splitting
// them apart is what lets a broad instruction carve out a folder it has nothing
// to say about (`test-coverage` over every `.ts` except `**/models/**`) without
// enumerating every folder it does cover.
// Keyed by the array itself: a scope list belongs to one loaded instruction and
// is asked about once per changed file, so splitting it again per file is work
// whose answer cannot have changed. A WeakMap keeps a rulebook that is reloaded
// (the tests build several) from pinning the old one in memory.
const splitCache = new WeakMap();

function splitPatterns(patterns) {
  if (!patterns) return { include: [], exclude: [] };
  // Only an object can key a WeakMap, and every caller passes the array a
  // frontmatter scope list parsed to. Anything else still works, uncached.
  const cacheable = typeof patterns === 'object';
  const cached = cacheable ? splitCache.get(patterns) : null;
  if (cached) return cached;
  const include = [];
  const exclude = [];
  for (const raw of patterns) {
    const p = String(raw).trim();
    if (p.startsWith('!')) exclude.push(p.slice(1).trim());
    else include.push(p);
  }
  const split = { include, exclude };
  if (cacheable) splitCache.set(patterns, split);
  return split;
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
      const names = fs.readdirSync(dir);
      for (const name of names) if (isReport(name)) files.push(path.join(dir, name));
      // An import ledger and a work folder outlive their run only when the run never
      // assembled; while its parts are still there they wait for the resume, which
      // rewrites them.
      for (const name of names) {
        const leftover = name.match(/^(.*-\d{4}-\d{2}-\d{2}-\d{2}-\d{2})\.(?:imports\.txt|work)$/);
        if (leftover && !names.some((other) => other.startsWith(`${leftover[1]}.part`))) {
          try {
            fs.rmSync(path.join(dir, name), { recursive: true, force: true });
          } catch {}
        }
      }
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

// The import edges of one source file, for the cross-file layering question. Read by
// pattern, not by a parser: a missed exotic form costs one edge the reviewer still sees
// in the file, while a parser dependency would cost every run a package install.
// Block comments and whole-line `//` comments go first, so a commented-out import is
// not an edge; a `//` inside a string (a URL) is left alone.
const importExtensions = /\.(?:[cm]?[jt]sx?|vue|svelte|s[ac]ss|less|css)$/i;
const reImportPatterns = [
  /\bimport\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"\n]+)['"]/g,
  /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /@(?:use|import|forward)\s+['"]([^'"\n]+)['"]/g,
];

function extractImports(content, filePath) {
  if (!importExtensions.test(filePath)) return null;
  // A removed comment keeps its line breaks, so every edge keeps the line the reviewer's Read shows.
  const text = String(content)
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const found = [];
  for (const re of reImportPatterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) found.push({ at: m.index, spec: m[1] });
  }
  const dir = path.posix.dirname(filePath.replace(/\\/g, '/'));
  const seen = new Set();
  return found.sort((a, b) => a.at - b.at).filter((f) => {
    if (seen.has(f.spec)) return false;
    seen.add(f.spec);
    return true;
  }).map(({ at, spec }) => ({
    line: text.slice(0, at).split('\n').length,
    spec,
    ...(spec.startsWith('.') ? { resolved: path.posix.normalize(path.posix.join(dir, spec)) } : {}),
  }));
}

// FIXED IDENTIFIER: `<importing file>:<line> → <specifier>[ (<resolved path>)]`, one edge
// per line - SKILL.md's layering question walks these lines. `# ` lines are notes: the
// files whose language has no extractor here, whose edges the reviewer collects itself.
function formatImportLedger(files, readContent) {
  const edges = [];
  const unparsed = [];
  for (const file of files) {
    if (file.status === 'D') continue;
    const content = readContent(file.path);
    const imports = content === null ? null : extractImports(content, file.path);
    if (imports === null) {
      unparsed.push(file.path);
      continue;
    }
    for (const edge of imports) edges.push(`${file.path}:${edge.line} → ${edge.spec}${edge.resolved ? ` (${edge.resolved})` : ''}`);
  }
  const notes = unparsed.length ? [`# not parsed - collect their imports while reading them: ${unparsed.join(', ')}`] : [];
  return { text: [...notes, ...edges].join('\n') + '\n', edges: edges.length };
}

// Blob contents through one `git cat-file --batch` instead of a process per file.
function readBlobs(project, blobs) {
  const wanted = [...new Set(blobs.filter((b) => /^[0-9a-f]{7,64}$/.test(b) && !/^0+$/.test(b)))];
  const out = new Map();
  if (wanted.length === 0) return out;
  let buf;
  try {
    buf = execFileSync('git', ['-C', project, 'cat-file', '--batch'], {
      input: wanted.join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return out;
  }
  let at = 0;
  for (const blob of wanted) {
    const eol = buf.indexOf(10, at);
    if (eol < 0) break;
    const header = buf.toString('utf8', at, eol).split(' ');
    if (header[1] === 'missing' || header.length < 3) {
      at = eol + 1;
      continue;
    }
    const size = Number(header[2]);
    out.set(blob, buf.toString('utf8', eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return out;
}

// The context goes to a file the reviewer Reads instead of to stdout: tool output
// may be compressed on its way into the conversation, a Read file is not. One line
// per element down to the file entries, because Read cuts lines past 2000 chars.
function layoutJson(value, depth = 4, indent = '') {
  if (depth === 0 || value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Array.isArray(value)
    ? value.map((v) => layoutJson(v, depth - 1, `${indent} `))
    : Object.entries(value).filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}:${layoutJson(v, depth - 1, `${indent} `)}`);
  if (entries.length === 0) return Array.isArray(value) ? '[]' : '{}';
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${indent} ${entries.join(`,\n${indent} `)}\n${indent}${close}`;
}

// A review that died before its assembly leaves `<stem>.partNN.md` files behind, and
// every finished file among them carries its coverage marker. The latest such stem of
// this target is resumed - but only while the snapshot proves the target still holds
// what that run was reviewing; parts written against other content would be spliced
// into a report about code they never saw.
const reStampedPart = /^(.*)-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})\.part(\d+)\.md$/;
const reCoverageMarker = /<!--\s*coverage:\s*(.+?)\s+(?:mechanical|\d+\s*\/\s*\d+)\s*-->/g;

function findInterruptedRun(reportPath) {
  const dir = path.dirname(reportPath);
  const name = path.basename(reportPath).replace(/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/, '');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const byStamp = new Map();
  for (const entry of entries) {
    const m = entry.match(reStampedPart);
    if (!m || m[1] !== name) continue;
    if (!byStamp.has(m[2])) byStamp.set(m[2], []);
    byStamp.get(m[2]).push(path.join(dir, entry));
  }
  if (byStamp.size === 0) return null;
  const stamp = [...byStamp.keys()].sort().pop();
  const doneFiles = new Set();
  for (const part of byStamp.get(stamp)) {
    let text = '';
    try {
      text = fs.readFileSync(part, 'utf8');
    } catch {}
    for (const m of text.matchAll(reCoverageMarker)) doneFiles.add(m[1]);
  }
  return {
    stamp,
    stem: path.join(dir, `${name}-${stamp}`),
    doneFiles,
    otherStamps: [...byStamp.keys()].filter((s) => s !== stamp),
  };
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
    checklistPlans: [],
    checklistGates: {},
    checklistPerFile: [],
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
  // scope it falls outside are not its rules and never reach its plan, and the
  // reaching ones carry their instruction to files its `applies-to` never names.
  // Memoised per pair, because `makeFiles` asks the same question three times
  // for every one of them - is this instruction applicable, which items go in
  // the plan, how many items is that - and the answer cannot differ between
  // those three. The key separator is a newline: no path or file name holds one.
  const globalSet = new Set(instructions.globals);
  const itemsCache = new Map();
  const itemsFor = (file, filePath) => {
    const key = `${file}\n${filePath}`;
    let items = itemsCache.get(key);
    if (items === undefined) {
      items = itemsWalkedBy(parsedItemsOf(file), scopes[file], globalSet.has(file), filePath);
      itemsCache.set(key, items);
    }
    return items;
  };

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
  // The revision each target reviews, in the form the duplication scan reads it
  // (duplication-scan.cjs) - kept out of the target, which is the reviewer's JSON.
  const scanSources = new Map();
  const snapshotPathOf = (target) =>
    path.join(path.dirname(target.reportPath), `.last-review-${target.kind}.json`);
  const resumeFrom = (target, currentBlobs) => {
    const run = findInterruptedRun(target.reportPath);
    if (!run) return false;
    const leftovers = (stamps) => stamps.map((s) => `"${run.stem.slice(0, -s.length)}${s}".part*.md`).join(' ');
    if (run.otherStamps.length > 0) {
      result.warnings.push(`[${target.branch}] Parts of older interrupted reviews stay behind and are not used: ${run.otherStamps.join(', ')} - remove them with rm -f ${leftovers(run.otherStamps)}.`);
    }
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(snapshotPathOf(target), 'utf8'));
    } catch {}
    if (currentBlobs) {
      const same = previous && previous.files && path.resolve(String(previous.reportPath)) === path.resolve(`${run.stem}.md`)
        && Object.keys(previous.files).length === currentBlobs.size
        && [...currentBlobs].every(([p, blob]) => previous.files[p] === blob);
      if (!same) {
        result.warnings.push(`[${target.branch}] The interrupted review from ${run.stamp} was of different content than this target holds now, so it is not resumed - this run starts from scratch. Its parts: rm -f ${leftovers([run.stamp])}.`);
        return false;
      }
    } else {
      result.warnings.push(`[${target.branch}] Resuming the interrupted review from ${run.stamp} without a content check (folder mode keeps no snapshot) - if files of this folder changed since, delete its parts (rm -f ${leftovers([run.stamp])}) and run again.`);
    }
    if (previous && Array.isArray(previous.reviewed)) {
      const reviewed = new Set(previous.reviewed);
      target.files = target.files.filter((f) => reviewed.has(f.path));
    }
    if (previous && previous.sinceLast) {
      target.unchangedSinceLastReview = previous.sinceLast.unchanged;
      target.previousReportPath = previous.sinceLast.previousReportPath;
    }
    target.reportPath = `${run.stem}.md`;
    target.htmlReportPath = wantsHtml ? `${run.stem}.html` : null;
    const doneFiles = target.files.map((f) => f.path).filter((p) => run.doneFiles.has(p));
    target.resume = { from: run.stamp, doneFiles, headerWritten: fs.existsSync(target.reportPath) };
    result.warnings.push(`[${target.branch}] Resuming the review interrupted at ${run.stamp}: ${doneFiles.length} of ${target.files.length} file(s) already have their part and are not analyzed again.`);
    return true;
  };
  // What `git diff` compares for a target (`<base>...<branch>`, `--cached`); folder
  // mode compares nothing and has none.
  const pendingDiffArgs = new Map();
  const registerTarget = (target, currentBlobs, scanSource, diffArgs) => {
    if (currentBlobs) pendingSnapshots.set(target, currentBlobs);
    if (diffArgs) pendingDiffArgs.set(target, diffArgs);
    scanSources.set(target, scanSource);
    if (resumeFrom(target, currentBlobs)) {
      if (options.sinceLast) result.warnings.push(`[${target.branch}] --since-last is ignored while resuming: the resumed run keeps the file list it started with.`);
    } else if (options.sinceLast && !currentBlobs) {
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
          result.warnings.push(`[${target.branch}] --since-last: ${unchanged.length} file(s) unchanged since the previous review and skipped: ${shown}${unchanged.length > 10 ? `, (+${unchanged.length - 10} more)` : ''}. The snapshot is written when the context is built, so a previous review that did not finish still marked these as reviewed - re-run without --since-last if that run was interrupted.`);
          target.unchangedSinceLastReview = unchanged;
          target.previousReportPath = previous.reportPath || null;
          // Skipping a file is only honest while the report that DID review it is still
          // there to be read: the run says "see the previous report" and the reader has to
          // be able to. Pruning removes the oldest ones, so after enough reviews of one
          // branch the snapshot outlives the evidence it points at.
          if (target.previousReportPath && !fs.existsSync(target.previousReportPath)
            && !fs.existsSync(target.previousReportPath.replace(/\.md$/i, '.html'))) {
            result.warnings.push(`[${target.branch}] --since-last: the previous report is gone (${target.previousReportPath}), so nothing on disk covers the skipped file(s) any more - re-run this target in full.`);
          }
          target.files = target.files.filter((f) => !unchanged.includes(f.path));
        }
      }
    }
    // Two branches can sanitise to one name (`feature/x` and `feature-x` both become
    // `feature-x`), and then both targets carry the same reportPath: the second review
    // overwrites the first, and they share one `--since-last` snapshot. The run asked
    // for two reviews and would end with one file and no sign of the other.
    const clash = result.targets.find((t) => t.reportPath === target.reportPath);
    if (clash) {
      result.warnings.push(`Branches "${clash.branch}" and "${target.branch}" produce the same report name (${path.basename(target.reportPath)}), so the second review would overwrite the first and both would share one --since-last snapshot. Review them in separate runs.`);
    }
    result.targets.push(target);
  };

  const quiet = ['-c', 'core.quotepath=false'];
  const gitc = (args) => `git -C ${q(project)} ${args}`;
  // What a file looks like and what changed in it are not commands any more but
  // files (`contentPath`, `diffPath`, written into the target's `workDir` below):
  // the reviewer Reads them, and a Read file reaches it whole, where a command's
  // output may be compressed on its way. `commands.grep` stays a command - it
  // searches the whole reviewed revision (the branch's commit, the index, the
  // working tree) for a `<pattern>` placeholder (an extended regex), so "does
  // this helper already exist?" is asked of the code the review reads - but its
  // matches land in a file of the work folder too, and the command prints only
  // how many there are and where.
  // changedLines: new-file line ranges precomputed from `git diff -U0`
  // (rangesArgsFor), so the reviewer never derives them from hunks itself;
  // null for added (every line is new) and deleted (no new file) files.
  // Files of one KIND get byte-identical plans - the plan is decided by the path
  // patterns and the scope tags, nothing else - so a 200-file diff repeats about eight
  // distinct plans twenty-five times each. Measured there: 36 850 B of `checklist` plus
  // 10 775 B of `globalInstructionsSkipped`, against 2 274 B as a catalog and an index -
  // roughly 13 000 tokens of the orchestrator's own context, which is the thing this
  // whole architecture exists to protect. Same move as `localInstructionsCatalog` right
  // below, and the reviewer resolves it the same way.
  const planCatalog = [];
  const planIndex = new Map();
  const planFor = (checklist, skipped) => {
    const key = `${checklist.join('|')}` + String.fromCharCode(10) + skipped.join('|');
    let at = planIndex.get(key);
    if (at === undefined) {
      at = planCatalog.length;
      planCatalog.push({ checklist, globalInstructionsSkipped: skipped });
      planIndex.set(key, at);
    }
    return at;
  };

  const makeFiles = (rawFiles, rangesByPath) => rawFiles.map((f) => {
    // An instruction whose every item the file's scope tags took away has
    // nothing to say about it, so it is not one of the file's instructions —
    // neither to read nor to tick. One outside the file's scope still is when
    // an item reaches the file.
    const applicable = (file) => itemsFor(file, f.path).length > 0;
    const locals = instructions.locals.map((l) => l.file).filter(applicable);
    // Globals are matched per file too: one that declares `applies-to` is
    // narrowed like a local, one that declares none still applies everywhere.
    const globals = instructions.globals.filter(applicable);
    const plan = [...planOf(globals, f.path), ...planOf(locals, f.path)];
    return {
      path: f.path,
      status: f.status,
      // Only a rename/copy has one; the mechanical-change gate compares the two
      // names (and their folders) against the naming instructions.
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      localInstructions: locals,
      // An INDEX into `checklistPlans`, which holds this file's ticking plan (one
      // `<id>:<items>` entry per instruction, globals first, then the matched locals)
      // and the globals its path took it out of, named by checklist id so a shorter
      // plan reads as a decision instead of an omission.
      plan: planFor(plan, instructions.globals.filter((g) => !globals.includes(g)).map((g) => idOf.get(g))),
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
        grep: gitc(`grep -n -I -E ${q('<pattern>')} ${branchRef} --`),
      },
      files: makeFiles(kept, parseDiffRangesByPath(tryGit(project, [...quiet, 'diff', '-U0', range]) || '')),
      skipped,
    }, new Map(raw.map((f) => [f.path, f.blob])), { ref: branchRef }, [range]);
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
        grep: gitc(`grep -n -I --cached -E ${q('<pattern>')} --`),
      },
      files: makeFiles(kept, parseDiffRangesByPath(tryGit(project, [...quiet, 'diff', '-U0', '--cached']) || '')),
      skipped,
    }, new Map(raw.map((f) => [f.path, f.blob])), { index: true }, ['--cached']);
  } else if (options.mode === 'branches') {
    const names = [...new Set(String(options.branches || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
    if (names.length === 0) result.errors.push('No branches given (expected --branches="a,b;c").');
    for (const name of names) addBranchTarget(name);
  } else if (options.mode === 'folder') {
    // Folder mode reviews the working tree instead of a diff: every file under
    // --path (recursive, minus skipGlobs) is emitted as an added file, so the
    // whole folder gets the added-file treatment (content only, no diff).
    const rel = String(options.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const abs = path.resolve(project, rel);
    // `path.resolve` happily walks out of the project (`--path=../other`), and every
    // report path and command below is built as if the file were inside it.
    const outside = (() => {
      const inside = path.relative(path.resolve(project), abs);
      return inside !== '' && (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside));
    })();
    if (!rel) {
      result.errors.push('No folder given (expected --path="src/app").');
    } else if (outside) {
      result.errors.push(`Folder is outside the reviewed project: ${rel} (use --project=<path> to review another repository)`);
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
          grep: gitc(`grep -n -I --untracked -E ${q('<pattern>')} --`),
        },
        files: makeFiles(kept, new Map()),
        skipped,
      }, null, { workTree: true });
    }
  } else {
    const branchName = tryGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branchName || branchName === 'HEAD') {
      result.errors.push('Detached HEAD - check out a branch or pass an explicit branch list.');
    } else {
      addBranchTarget(branchName);
    }
  }

  // Copy/paste detection over each reviewed revision (duplication-scan.cjs). Runs
  // only when the caller hands the scanner in - main() does - because it spawns
  // jscpd through npx, which tests and library callers must not pay for.
  if (options.scanDuplicates) {
    for (const target of result.targets) {
      const scan = options.scanDuplicates({ project, source: scanSources.get(target), files: target.files, isSkipped: isSkippedPath });
      if (scan.error) {
        result.warnings.push(`[${target.branch}] Duplication scan (jscpd) did not run: ${scan.error}. Duplicated code is searched for by the review alone.`);
        continue;
      }
      target.duplicationCandidates = scan.candidates;
      if (scan.omitted > 0) {
        result.warnings.push(`[${target.branch}] Duplication scan: ${scan.omitted} more duplication candidate(s) found than the ${scan.candidates.length} listed - they are not in this review.`);
      }
    }
  }

  // The import ledger the cross-file layering question walks, collected here from the
  // reviewed revision instead of by the reviewer while each file is open - a step that
  // costs output on every file and was, in practice, skipped. Written with the reports.
  const pendingLedgers = new Map();
  // The files of each target's work folder, written with the reports: the reviewed
  // revision of every file (`contentPath`) and its own section of the target's patch
  // (`diffPath`), named after the part the file's review goes to - `07-a.ts` and
  // `07-a.ts.diff` feed `<stem>.part07.md`. Folder mode reads the working tree
  // itself, so its `contentPath` is the file and it has no patch.
  const pendingWork = new Map();
  for (const target of result.targets) {
    const blobs = pendingSnapshots.get(target);
    const contents = blobs ? readBlobs(project, target.files.map((f) => blobs.get(f.path) || '')) : null;
    const readContent = (p) => {
      if (contents) return contents.has(blobs.get(p)) ? contents.get(blobs.get(p)) : null;
      try {
        return fs.readFileSync(path.join(project, p), 'utf8');
      } catch {
        return null;
      }
    };
    pendingLedgers.set(target, formatImportLedger(target.files, readContent).text);
    target.importLedger = target.reportPath.replace(/\.md$/, '.imports.txt');
    // Forward slashes: the same path works in a Read, in fs, and in a POSIX shell,
    // and a JSON string of it is not doubled by escaping.
    target.workDir = target.reportPath.replace(/\.md$/, '.work').replace(/\\/g, '/');
    // Matches land in a file, so they reach the reviewer through a Read; `$$` (the
    // shell's pid) keeps two searches of one run from overwriting each other.
    target.commands.grep = `f=${q(`${target.workDir}/grep-`)}$$.txt; ${target.commands.grep} > "$f"; echo "$(wc -l < "$f") match(es) -> $f"`;
    const diffArgs = pendingDiffArgs.get(target);
    const patchFlags = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
    const patches = diffArgs ? splitPatchByPath(tryGit(project, [...quiet, 'diff', ...patchFlags, ...diffArgs]) || '') : new Map();
    // The part files' own width (check-part.cjs), so `03-a.ts` pairs with `part03.md`.
    const width = Math.max(2, String(target.files.length + 2).length);
    const writes = [];
    target.files.forEach((f, i) => {
      const stem = `${target.workDir}/${String(i + 1).padStart(width, '0')}-${path.basename(f.path).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`;
      f.contentPath = null;
      f.diffPath = null;
      if (f.status !== 'D') {
        if (!blobs) {
          f.contentPath = `${project.replace(/\\/g, '/')}/${f.path}`;
        } else {
          // A blob that is no text (an image, a font) is reviewed from its diff line alone.
          const text = readContent(f.path);
          if (text !== null && !text.includes('\u0000')) {
            f.contentPath = stem;
            writes.push([stem, text]);
          }
        }
      }
      if (diffArgs && f.status !== 'A') {
        // The whole-target patch missed this path only if its header spelled it in a
        // way the split could not read back; the file's own diff is the fallback.
        const patch = patches.get(f.path)
          || tryGit(project, [...quiet, 'diff', ...patchFlags, ...diffArgs, '--', f.path]);
        if (patch) {
          f.diffPath = `${stem}.diff`;
          writes.push([f.diffPath, patch.endsWith('\n') ? patch : `${patch}\n`]);
        }
      }
    });
    pendingWork.set(target, writes);
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
  result.checklistPlans = planCatalog;
  // Globals are narrowed to the ones at least one reviewed file actually walks:
  // a diff of stylesheets never reads the TypeScript rulebook. Every file still
  // names what it was taken out of in its own `globalInstructionsSkipped`.
  if (result.targets.length > 0) {
    const usedGlobals = new Set();
    for (const target of result.targets) {
      for (const file of target.files) {
        for (const g of instructions.globals) {
          if (itemsFor(g, file.path).length > 0) usedGlobals.add(g);
        }
      }
    }
    result.globalInstructions = instructions.globals.filter((g) => usedGlobals.has(g));
  }
  // An id and the file it stands for are one fact, so they travel as one entry of the
  // catalog that already lists the file. Kept apart they were the same thirty-five paths
  // written twice - a fifth of a real context - and two places to look one thing up in.
  // The `gate:` sentence of every instruction that declares one. The reviewer
  // answers it once per file before walking that instruction's items: a failed
  // gate collapses the whole instruction into one ticked range line.
  result.checklistGates = Object.fromEntries(
    [...result.globalInstructions, ...result.localInstructionsCatalog]
      .filter((f) => itemsOf(f) > 0 && scopes[f] && scopes[f].gate)
      .map((f) => [idOf.get(f), scopes[f].gate]),
  );
  // Instructions declaring `findings: per-file`: their items are facets of one requirement, so
  // a file's breaches of one are a single finding naming every item broken (SKILL.md Step 3
  // point 3) - the part check lets that finding name several of its items, and refuses a second.
  result.checklistPerFile = [...result.globalInstructions, ...result.localInstructionsCatalog]
    .filter((f) => itemsOf(f) > 0 && scopes[f] && scopes[f].findings === 'per-file')
    .map((f) => idOf.get(f));
  const indexOf = new Map(result.localInstructionsCatalog.map((p, i) => [p, i]));
  for (const target of result.targets) {
    for (const file of target.files) {
      file.localInstructions = file.localInstructions.map((p) => indexOf.get(p));
    }
  }

  // Done last: everything above addresses these two lists by path.
  // `numberedPath` is the copy of the instruction the reviewer reads, its bullets
  // already carrying their `<id>#<n>` (numberChecklist), written with the reports.
  const rulesDir = result.targets.length > 0
    ? path.join(path.dirname(result.targets[0].reportPath), `.review-rules-${result.targets[0].kind}`).replace(/\\/g, '/')
    : null;
  const withId = (p) => ({
    id: idOf.get(p),
    path: p,
    ...(rulesDir ? { numberedPath: `${rulesDir}/${idOf.get(p)}.md` } : {}),
  });
  result.globalInstructions = result.globalInstructions.map(withId);
  result.localInstructionsCatalog = result.localInstructionsCatalog.map(withId);

  if (result.targets.length > 0) {
    fs.mkdirSync(reportsDir, { recursive: true });
    if (useProjectDoh) ensureDohGitignore(reportsDir);
    // Pruning runs in both locations: the project's `.claude/doh/` is shared
    // with other artifacts, but only run-stamped report names are ever counted
    // or deleted (see pruneReports), so nothing else there is at risk.
    pruneReports(reportsDir);
    // Rewritten whole every run, so a copy never outlives a change to its instruction.
    try {
      fs.rmSync(rulesDir, { recursive: true, force: true });
      fs.mkdirSync(rulesDir, { recursive: true });
      for (const entry of [...result.globalInstructions, ...result.localInstructionsCatalog]) {
        fs.writeFileSync(entry.numberedPath, numberChecklist(fs.readFileSync(entry.path, 'utf8'), entry.id));
      }
    } catch (err) {
      result.errors.push(`Could not write the numbered instructions to ${rulesDir} (${(err && err.message) || err}) - the review reads its checklists from there, so it cannot run.`);
      // Dropped, not just reported: no target left is what stops Step 1 (exit 1),
      // whoever reads the error text.
      result.targets = [];
    }
    // A target whose work folder could not be written has nothing to be read from.
    const unwritten = new Set();
    // After the pruning, so an emptied branch folder is not removed right after
    // being created for this run.
    for (const target of result.targets) {
      fs.mkdirSync(path.dirname(target.reportPath), { recursive: true });
      try {
        fs.writeFileSync(target.importLedger, pendingLedgers.get(target));
      } catch {
        result.warnings.push(`[${target.branch}] Could not write the import ledger ${target.importLedger} - collect the import edges while reading each file.`);
      }
      // Emptied first: a resumed run rewrites what the interrupted one wrote.
      try {
        fs.rmSync(target.workDir, { recursive: true, force: true });
        fs.mkdirSync(target.workDir, { recursive: true });
        for (const [file, text] of pendingWork.get(target) || []) fs.writeFileSync(file, text);
      } catch (err) {
        result.errors.push(`[${target.branch}] Could not write the work folder ${target.workDir} (${(err && err.message) || err}) - the files under review are read from it, so this target is not reviewed.`);
        unwritten.add(target);
        continue;
      }
      const blobs = pendingSnapshots.get(target);
      if (!blobs) continue;
      try {
        fs.writeFileSync(snapshotPathOf(target), JSON.stringify({
          at: now.toISOString(),
          reportPath: target.reportPath,
          files: Object.fromEntries(blobs),
          // What a resumed run restores: the file list this run reviews and the
          // `--since-last` narrowing it was built with.
          reviewed: target.files.map((f) => f.path),
          ...(target.unchangedSinceLastReview
            ? { sinceLast: { unchanged: target.unchangedSinceLastReview, previousReportPath: target.previousReportPath || null } }
            : {}),
        }));
      } catch {}
    }
    result.targets = result.targets.filter((target) => !unwritten.has(target));
  }
  return result;
}

function main() {
  let context;
  try {
    context = buildContext({ ...parseArgs(process.argv.slice(2)), scanDuplicates: duplication.scanDuplicates });
  } catch (err) {
    context = { targets: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(JSON.stringify(writeContext(context)) + '\n');
  process.exit(context.targets.length > 0 ? 0 : 1);
}

// FIXED IDENTIFIERS (SKILL.md Step 1 reads them): `contextPath`, `errors`, `warnings`,
// `targets[].branch|files|reportPath|resumed`. The whole context goes to `contextPath`,
// next to the first target's report; stdout carries only what Step 1 acts on at once.
// A run with no target has nothing worth a file, so it prints everything as before.
function writeContext(context) {
  if (!context.targets || context.targets.length === 0) return context;
  const first = context.targets[0];
  const contextPath = path.join(path.dirname(first.reportPath), `.review-context-${first.kind}.json`);
  const { errors, warnings, ...rest } = context;
  try {
    fs.writeFileSync(contextPath, layoutJson(rest) + '\n');
  } catch (err) {
    return { ...context, errors: [...(errors || []), `Could not write the context file ${contextPath} (${(err && err.message) || err}) - the full context follows inline.`] };
  }
  return {
    contextPath,
    errors: errors || [],
    warnings: warnings || [],
    targets: context.targets.map((t) => ({ branch: t.branch, files: t.files.length, reportPath: t.reportPath, resumed: !!t.resume })),
  };
}

module.exports = { ensureDohGitignore, extractImports, formatImportLedger, readBlobs, unquoteGitPath, patchPathOf, splitPatchByPath, numberChecklist, layoutJson, findInterruptedRun, writeContext, countOf, parseArgs, globToRegExp, parseFrontmatter, sanitizeBranchName, formatTimestamp, git, tryGit, resolveRef, detectPrBase, detectForkBase, aheadCounts, detectCandidateBase, detectBaseBranch, parseRawDiff, parseDiffRangesByPath, countChecklistItems, parseChecklistItems, matchChecklistItems, itemsWalkedBy, formatItemSpec, checklistIdOf, parseHunkRanges, loadInstructions, splitPatterns, matchesScope, matchLocalInstructions, matchGlobalInstructions, isSkippedPath, listFolderFiles, pruneReports, buildContext };

if (require.main === module) main();
