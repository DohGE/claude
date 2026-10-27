#!/usr/bin/env node
'use strict';

// Deterministic mechanics for the doh:codeReview skill: argument parsing,
// glob matching, file-kind matching (rulebook.cjs), base-branch detection and
// the review-context JSON consumed by SKILL.md.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const github = require('./github.cjs');
const duplication = require('./duplication-scan.cjs');
const rulebook = require('./rulebook.cjs');
const repoFacts = require('./repo-facts.cjs');
const reviewBundle = require('./review-bundle.cjs');
const reviewScope = require('./review-scope.cjs');
const mechanical = require('./mechanical.cjs');

const defaultSkillDir = path.resolve(__dirname, '..');
const baseBranchNames = ['main', 'master', 'develop', 'dev'];
const reportsRetain = 30;
const forkCandidateLimit = 60;
// codeReview's own folder - `<project>/.claude/doh/codeReview/`, or `<skillDir>/reports/`
// for a project without `.claude/` - holds two trees:
//   runs/<YYYY-MM-DD-HH-mm-ss>/<branchDir>/raport.md|html   one folder per run and target
//   cache/<branchDir>/                                      what the next run reads
// check-part.cjs walks from a part back to its context through the same shape (runOf).
const reportStem = 'raport';
const reRunStamp = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;

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

// The effort levels a walker's prompt can carry, worded in SKILL.md Step 3 (Windows).
const walkerEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
// Windows walked at once (`--parallel=<n>`): each walker writes parts of its own files only.
const defaultParallel = 4;
const maxParallel = 6;
// The most files a target walked in the main conversation may have to make its cross-file pass there.
const crossInlineMax = 4;
// Where a branch target's reviewed revision is kept for the run's searches (`snapshotDir`): next
// to runs/ and cache/, one short folder per target - the assembly removes it.
const snapshotsDirName = 's';
// What walks a window of files the script found mechanical (mechanical.cjs): two questions per
// file need no deeper model - the same setting the models kinds declare.
const mechanicalWalker = { model: 'sonnet', effort: 'medium' };
// The fewest consecutive files of a kind with a `walker` setting that get windows of their own.
const lightRunMin = 3;

function parseArgs(argv) {
  const args = { mode: 'auto', branches: '', path: '', project: process.cwd(), output: 'html', sinceLast: false, withChecklist: false, withRuleText: false, light: false, batch: true, windows: true, dedupItems: true, walkerModel: '', walkerEffort: '', parallel: 0 };
  const unknown = [];
  for (const arg of argv) {
    // Incremental review: only the files whose content moved since the previous
    // review of this target (see the snapshot written next to the report).
    if (arg === '--since-last') { args.sinceLast = true; continue; }
    // The finished report keeps the walked checklists (render-report.cjs cuts them otherwise).
    if (arg === '--with-checklist') { args.withChecklist = true; continue; }
    // Each checklist item also shows its rule's words; it needs the checklists, so it keeps them.
    if (arg === '--with-rule-text') { args.withChecklist = true; args.withRuleText = true; continue; }
    // No item of severity low is walked, and the report keeps no Low finding and no code snippet.
    if (arg === '--light') { args.light = true; continue; }
    // Every file walked in a response of its own, light ones included (review-bundle.cjs batches).
    if (arg === '--no-batch') { args.batch = false; continue; }
    // The target is walked by the conversation that runs the review, not by a sub-agent per
    // window (review-bundle.cjs planWindows): for a session that cannot dispatch one.
    if (arg === '--no-windows') { args.windows = false; continue; }
    // A bundle read in one compaction window shows an item's text once (review-hooks.cjs), by
    // default; `--dedup-items` is the old opt-in, kept so a caller that still passes it works.
    if (arg === '--dedup-items') { args.dedupItems = true; continue; }
    if (arg === '--no-dedup-items') { args.dedupItems = false; continue; }
    const m = arg.match(/^--([a-z][a-z-]*)=(.*)$/);
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
    // What the window walkers are spawned with (Step 3 Windows): the Agent tool's `model` and
    // the thinking directive their prompt carries. Recorded in the context, so a dispatch after
    // a compaction still sends them on the model the caller picked.
    else if (m[1] === 'walker-model') args.walkerModel = m[2].trim();
    else if (m[1] === 'walker-effort') args.walkerEffort = m[2].trim();
    else if (m[1] === 'parallel') args.parallel = /^\d+$/.test(m[2].trim()) ? Number(m[2].trim()) : NaN;
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --mode, --branches, --path, --project, --output, --since-last, --with-checklist, --with-rule-text, --light, --no-batch, --no-windows, --no-dedup-items, --dedup-items, --walker-model, --walker-effort, --parallel; the skill's own --only-md maps to --output=md)`);
  }
  if (args.walkerModel && !/^[A-Za-z0-9][\w.[\]-]{0,63}$/.test(args.walkerModel)) {
    throw new Error(`Unknown --walker-model=${args.walkerModel} (expected a value the Agent tool's model parameter takes, e.g. sonnet)`);
  }
  if (Number.isNaN(args.parallel) || args.parallel < 0 || args.parallel > maxParallel) {
    throw new Error(`Unknown --parallel value (expected 1-${maxParallel} windows walked at once)`);
  }
  if (args.walkerEffort && !walkerEfforts.includes(args.walkerEffort)) {
    throw new Error(`Unknown --walker-effort=${args.walkerEffort} (expected ${walkerEfforts.join('|')})`);
  }
  if (!['auto', 'staged', 'branches', 'folder'].includes(args.mode)) {
    throw new Error(`Unknown --mode=${args.mode} (expected auto|staged|branches|folder)`);
  }
  if (!['html', 'md'].includes(args.output)) {
    throw new Error(`Unknown --output=${args.output} (expected md|html)`);
  }
  return args;
}

// The compiled globs of one run, keyed by the pattern text, so a caller asking
// about the same pattern for every changed file compiles it once. The returned
// regexes carry no `g`/`y` flag, so they hold no lastIndex and sharing one
// between callers is safe.
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

function sanitizeBranchName(branch) {
  return branch.replace(/[^A-Za-z0-9._-]/g, '-');
}

function formatTimestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}-${p(d.getMinutes())}`,
    seconds: p(d.getSeconds()),
  };
}

// The report's header (references/walk.md Step 4 format), with its date and time read from the run folder
// of `reportPath` (`runs/<YYYY-MM-DD-HH-mm-ss>/`), then the skipped-files line and the since-last
// note when the target has them. Written by the context script, so the conversation that runs
// the review starts with the walk and never needs the format.
function reportHeader(target) {
  const stamp = path.basename(path.dirname(path.dirname(String(target.reportPath)))).match(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-\d{2}$/);
  const when = stamp ? `${stamp[1]} ${stamp[2]}:${stamp[3]}` : '';
  const title = target.kind === 'staged'
    ? `staged (${target.branch})`
    : target.kind === 'folder' ? `folder ${target.folder} (${target.branch})` : `${target.branch} → ${target.baseBranch}`;
  const lines = [`# Code Review: ${title} | ${when}`];
  if (target.skipped && target.skipped.length > 0) lines.push('', `Pominięto pliki wygenerowane/binarne: ${target.skipped.join(', ')}`);
  if (target.unchangedSinceLastReview && target.unchangedSinceLastReview.length > 0) {
    lines.push('', `<!-- since-last: ${target.unchangedSinceLastReview.length} unchanged file(s) skipped; previous report: ${target.previousReportPath} -->`);
  }
  // A blank line closes it: the assembly appends the parts as they are, each opening with `##`.
  return `${lines.join('\n')}\n\n`;
}

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const cacheDirOf = (root, branchDir = '') => path.join(root, 'cache', branchDir);

// The codeReview folder, run stamp and branch folder a report or part file lies in -
// null when it lies in no run folder (a report written before runs/ existed, say).
function runOf(file) {
  const dir = path.dirname(path.resolve(file));
  const stampDir = path.dirname(dir);
  const runsDir = path.dirname(stampDir);
  if (path.basename(runsDir) !== 'runs' || !reRunStamp.test(path.basename(stampDir))) return null;
  return { root: path.dirname(runsDir), stamp: path.basename(stampDir), branchDir: path.basename(dir), dir };
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

// A target's whole assembly as one short Bash call (references/assembly.md), written out here so
// neither the reviewer nor a session resumed after a compaction composes it. check-part.cjs
// --assemble runs the part check and, only when it passes, appends the parts, removes the parts,
// the import ledger and the work folder, and renders - one process, so no step is left out.
function assembleCommand(target, contextPath, project, skillDir) {
  const slash = (p) => String(p).replace(/\\/g, '/');
  return `node ${q(`${slash(skillDir)}/scripts/check-part.cjs`)} --context=${q(slash(contextPath))} --report=${q(slash(target.reportPath))} --assemble`;
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
    // `codeReview/` keeps its own runs and caps them itself (pruneRuns).
    if (entry.name === 'instructions' || entry.name === 'codeReview') continue;
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

// The same cap over codeReview's runs/: one run is one `runs/<stamp>/<branchDir>/`
// folder - its report in either format, or the parts of a review that never assembled -
// and its age is the stamp its name carries. `keep` are the folders the current run
// writes to: a resumed one carries an old stamp and must not be pruned from under it.
// Only runs/ is ever touched, never the cache/ the next run reads. Best-effort.
function pruneRuns(runsDir, keep = [], retain = reportsRetain) {
  let stamps;
  try {
    stamps = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && reRunStamp.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return;
  }
  const runs = [];
  for (const stamp of stamps) {
    try {
      for (const entry of fs.readdirSync(path.join(runsDir, stamp), { withFileTypes: true })) {
        if (entry.isDirectory()) runs.push({ stamp, dir: path.join(runsDir, stamp, entry.name) });
      }
    } catch {}
  }
  const counted = runs.filter((run) => !keep.some((dir) => samePath(dir, run.dir)))
    .sort((a, b) => b.stamp.localeCompare(a.stamp) || a.dir.localeCompare(b.dir));
  for (const { dir } of counted.slice(retain)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  // An import ledger and a work folder outlive their run only when it never assembled;
  // while its parts are there they wait for the resume, which rewrites them. The day of
  // grace is for a review another session has just started: no part written yet, and
  // its work folder is what it is about to read.
  const stale = Date.now() - 24 * 60 * 60 * 1000;
  for (const { dir } of counted.slice(0, retain)) {
    try {
      const names = fs.readdirSync(dir);
      if (names.some((name) => name.startsWith(`${reportStem}.part`))) continue;
      for (const name of [`${reportStem}.imports.txt`, `${reportStem}.work`]) {
        const full = path.join(dir, name);
        if (names.includes(name) && fs.statSync(full).mtimeMs < stale) fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {}
  }
  // A run folder, and then a stamp folder, that the above emptied goes with it; rmdir
  // on one that still holds something throws and is ignored.
  for (const { dir } of counted) {
    try {
      fs.rmdirSync(dir);
    } catch {}
  }
  for (const stamp of stamps) {
    try {
      fs.rmdirSync(path.join(runsDir, stamp));
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

// Blob sizes through one `git cat-file --batch-check`; a blob git cannot size is absent.
function blobSizes(project, blobs) {
  const wanted = [...new Set(blobs.filter((b) => /^[0-9a-f]{7,64}$/.test(b)))];
  const out = new Map();
  if (wanted.length === 0) return out;
  let text;
  try {
    text = execFileSync('git', ['-C', project, 'cat-file', '--batch-check'], {
      input: wanted.join('\n') + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^([0-9a-f]+) blob (\d+)$/);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

// Every path of the reviewed revision, mapped to its blob - or to null in a folder review,
// which reads the working tree as git sees it (tracked and untracked files, not the ignored
// ones). Null when git cannot list it. Paths are the ones `git diff` prints.
function listRevision(project, source) {
  const records = (args) => {
    const out = tryGit(project, args);
    return out === null ? null : out.split('\0').filter(Boolean);
  };
  const entries = new Map();
  if (source.workTree) {
    const listed = records(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (!listed) return null;
    for (const p of listed) entries.set(p, null);
  } else if (source.index) {
    const listed = records(['ls-files', '-s', '-z', '--full-name']);
    if (!listed) return null;
    for (const record of listed) {
      // Stage 0 only: the stages of an unresolved conflict are not the reviewed revision.
      const m = record.match(/^(\d{6}) ([0-9a-f]+) 0\t([\s\S]+)$/);
      if (m && m[1] !== '120000' && m[1] !== '160000') entries.set(m[3], m[2]);
    }
  } else {
    const listed = records(['ls-tree', '-r', '-z', '--full-tree', source.ref]);
    if (!listed) return null;
    for (const record of listed) {
      const m = record.match(/^(\d{6}) blob ([0-9a-f]+)\t([\s\S]+)$/);
      if (m && m[1] !== '120000') entries.set(m[3], m[2]);
    }
  }
  return entries;
}

// Caps on what the repository facts read. Past one, the facts come from the files nearest
// the reviewed ones, and every fact only points at its line: a consumer or a translation key
// in a file left out would otherwise read as missing.
const factFileLimit = 5000;
const factFileBytes = 2 * 1024 * 1024;
const factTotalBytes = 48 * 1024 * 1024;

// The files repo-facts.cjs reads (path -> text): the fact sources of the reviewed revision
// around the reviewed files, and those files as the review reads them (`reviewed`, path ->
// text). `factRoot` is the nearest folder above the reviewed files with a tsconfig - its path
// aliases decide what an import resolves to - and the files come from the workspace around it
// (the nearest Nx or Angular workspace root, else the fact root itself): a library's
// consumers live in the applications next to it. In a workspace of several projects, `scope`
// (review-scope.cjs: the projects the review reaches, their importers included) narrows that
// to what decides a fact, so the caps below stop turning every fact into a hint; the root
// tsconfigs stay, their aliases resolve the imports. `entries` is listRevision's answer when the
// caller already has it. `partial` when git or a cap left files out.
function loadFactUniverse(project, source, reviewed, { entries: listed, scope = null } = {}) {
  const entries = listed === undefined ? listRevision(project, source) : listed;
  const paths = new Set(entries ? entries.keys() : []);
  for (const p of reviewed.keys()) paths.add(p);
  const up = (dir) => dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
  const nearest = (from, names) => {
    for (let dir = from; ; dir = up(dir)) {
      if (names.some((name) => paths.has(dir ? `${dir}/${name}` : name))) return dir;
      if (dir === '') return null;
    }
  };
  let common = null;
  for (const p of reviewed.keys()) {
    const parts = up(p).split('/');
    let i = 0;
    while (common !== null && i < common.length && common[i] === parts[i]) i++;
    common = common === null ? parts : common.slice(0, i);
  }
  const from = (common || []).join('/');
  const factRoot = nearest(from, ['tsconfig.json', 'tsconfig.base.json']) ?? nearest(from, ['angular.json', 'package.json']) ?? '';
  const workspace = nearest(factRoot, ['nx.json', 'angular.json']) ?? factRoot;
  const inWorkspace = (p) => workspace === '' || p.startsWith(`${workspace}/`);
  // The tsconfigs of the repository root and of the fact root stay: their aliases resolve imports.
  const isRootConfig = (p) => /(?:^|\/)tsconfig[^/]*\.json$/.test(p) && (up(p) === '' || up(p) === factRoot);
  const inScope = scope ? (p) => inWorkspace(p) && (scope.has(p) || isRootConfig(p)) : inWorkspace;
  const candidates = [...paths].filter((p) => repoFacts.isFactSource(p) && (reviewed.has(p) || (inScope(p) && !isSkippedPath(p))));
  // Nearest first: the reviewed files, the tsconfigs, then by the deepest folder a path
  // shares with a reviewed file.
  const depthOf = new Map();
  for (const p of reviewed.keys()) {
    for (let dir = up(p); ; dir = up(dir)) {
      depthOf.set(dir, dir === '' ? 0 : dir.split('/').length);
      if (dir === '') break;
    }
  }
  const nearness = (p) => {
    for (let dir = up(p); ; dir = up(dir)) if (depthOf.has(dir) || dir === '') return depthOf.get(dir) || 0;
  };
  const rank = (p) => (reviewed.has(p) ? 0 : /(?:^|\/)tsconfig[^/]*\.json$/.test(p) ? 1 : 2);
  candidates.sort((a, b) => (rank(a) - rank(b)) || (nearness(b) - nearness(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const sizes = entries && !source.workTree ? blobSizes(project, candidates.map((p) => entries.get(p)).filter(Boolean)) : null;
  let partial = entries === null;
  let total = 0;
  const files = new Map();
  const fromBlobs = [];
  for (const p of candidates) {
    let size;
    if (reviewed.has(p)) size = Buffer.byteLength(reviewed.get(p));
    else if (sizes) size = sizes.has(entries.get(p)) ? sizes.get(entries.get(p)) : -1;
    else {
      try {
        const stat = fs.statSync(path.join(project, p));
        size = stat.isFile() ? stat.size : -1;
      } catch {
        size = -1;
      }
    }
    // A tracked file deleted from the working tree is simply not there; a blob git could
    // not size is a file left out.
    if (size < 0) {
      if (sizes) partial = true;
      continue;
    }
    if (!reviewed.has(p) && (files.size + fromBlobs.length >= factFileLimit || size > factFileBytes || total + size > factTotalBytes)) {
      partial = true;
      continue;
    }
    total += size;
    if (reviewed.has(p)) files.set(p, reviewed.get(p));
    else if (sizes) fromBlobs.push(p);
    else {
      try {
        files.set(p, fs.readFileSync(path.join(project, p), 'utf8'));
      } catch {}
    }
  }
  if (fromBlobs.length > 0) {
    const texts = readBlobs(project, fromBlobs.map((p) => entries.get(p)));
    for (const p of fromBlobs) {
      if (texts.has(entries.get(p))) files.set(p, texts.get(entries.get(p)));
      else partial = true;
    }
  }
  for (const [p, text] of files) if (text.includes('\u0000')) files.delete(p);
  return { files, factRoot, partial };
}

// The lines of a reviewed file its findings may cite (SKILL.md scope gate): all of an added file
// and of a folder-mode one, the changed lines of a modified one, none of a pure rename.
function reportedText(file, text) {
  if (typeof text !== 'string') return null;
  if (file.changedLines === null || file.changedLines === undefined) return text;
  const lines = text.split('\n');
  const out = [];
  for (const range of String(file.changedLines).split(',').filter((r) => r.trim())) {
    const [from, to = from] = range.trim().split('-').map(Number);
    if (Number.isInteger(from) && Number.isInteger(to)) out.push(...lines.slice(from - 1, to));
  }
  return out.join('\n');
}

// The projects one target's whole-repository reads cover - the duplication scan and the facts
// (review-scope.cjs) - with the listing they were decided from, so the facts do not list the
// revision again. `scope` null is the whole repository.
function revisionScope(project, source, reviewed) {
  const entries = listRevision(project, source);
  if (!entries || reviewed.size === 0) return { entries, scope: null };
  const readText = (p) => {
    if (source.workTree) {
      try {
        return fs.readFileSync(path.join(project, p), 'utf8');
      } catch {
        return null;
      }
    }
    const blob = entries.get(p);
    return blob ? readBlobs(project, [blob]).get(blob) ?? null : null;
  };
  // Per needle, the files holding it - one `git grep -o` for all of them. Exit 1 is "no file
  // holds any"; anything else is a search that did not run.
  const importersOf = (needles) => {
    const mode = source.ref ? [] : source.index ? ['--cached'] : ['--untracked'];
    const where = source.ref ? [source.ref, '--'] : ['--'];
    const found = new Map(needles.map((needle) => [needle, []]));
    let out;
    try {
      out = execFileSync('git', ['-C', project, '-c', 'core.quotepath=false', 'grep', ...mode, '-o', '-z', '-I', '-F',
        ...needles.flatMap((needle) => ['-e', needle]), ...where], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    } catch (err) {
      return err && err.status === 1 ? found : null;
    }
    // `[<ref>:]<path>\0<match>` per match.
    for (const line of out.split('\n')) {
      const at = line.indexOf('\0');
      if (at < 0) continue;
      let file = line.slice(0, at);
      if (source.ref && file.startsWith(`${source.ref}:`)) file = file.slice(source.ref.length + 1);
      const list = found.get(line.slice(at + 1));
      if (list && list[list.length - 1] !== file) list.push(file);
    }
    return found;
  };
  try {
    return { entries, scope: reviewScope.reviewScope({ paths: new Set(entries.keys()), reviewed, readText, importersOf }) };
  } catch {
    return { entries, scope: null };
  }
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

// A review that died before its assembly leaves `raport.partNN.md` files in its run
// folder, and every finished file among them carries its coverage marker. `reportPath`
// is the report a target's snapshot names - its latest run - so an older interrupted
// run is never picked up in place of a newer one. Resumed only while the snapshot proves
// the target still holds what that run was reviewing; parts written against other
// content would be spliced into a report about code they never saw.
const rePart = new RegExp(`^${reportStem}\\.part\\d+\\.md$`);
const reCoverageMarker = /<!--\s*coverage:\s*(.+?)\s+(?:mechanical|\d+\s*\/\s*\d+)\s*-->/g;

function findInterruptedRun(reportPath) {
  const run = runOf(reportPath);
  if (!run || path.basename(reportPath) !== `${reportStem}.md`) return null;
  let parts;
  try {
    parts = fs.readdirSync(run.dir).filter((entry) => rePart.test(entry));
  } catch {
    return null;
  }
  if (parts.length === 0) return null;
  const doneFiles = new Set();
  for (const part of parts) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(run.dir, part), 'utf8');
    } catch {}
    for (const m of text.matchAll(reCoverageMarker)) doneFiles.add(m[1]);
  }
  return { ...run, doneFiles };
}

// The drafts of refused parts (check-part.cjs) whose part never reached the disk: a resumed
// run promotes them instead of walking their files again, so the rewrite of the work folder
// keeps them.
function keptDrafts(workDir, reportPath) {
  let entries;
  try {
    entries = fs.readdirSync(workDir).filter((entry) => entry.endsWith('.draft.md'));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !fs.existsSync(path.join(path.dirname(reportPath), entry.replace(/\.draft\.md$/, '.md'))))
    .flatMap((entry) => {
      try {
        return [[`${workDir}/${entry}`, fs.readFileSync(path.join(workDir, entry), 'utf8')]];
      } catch {
        return [];
      }
    });
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
    // '' is inherit: no `model` on the dispatch, no directive in the prompt.
    walker: { model: options.walkerModel || '', effort: options.walkerEffort || '' },
    // The root every file `path` is relative to - where the part check finds a file an OK names.
    project,
    instructionsCatalog: [],
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
  // `.claude/doh/instructions/` (file kinds as JSON, like the skill's), so a repo
  // carries its conventions next to its code instead of in the shared skill.
  const projectInstructionsDir = path.join(project, '.claude', 'doh', 'instructions');
  const hasProjectInstructions = isDirectory(projectInstructionsDir);
  // `.claude/doh/local/*.md`: the project's Markdown rules, walked by every kind where their
  // `applies-to` / `applies-when` front matter lets them (rulebook.cjs loadLocalInstructions).
  const localInstructionsDir = path.join(project, '.claude', 'doh', 'local');
  const loaded = rulebook.loadRulebook(
    [path.join(skillDir, 'instructions'), hasProjectInstructions ? projectInstructionsDir : null],
    { localDir: isDirectory(localInstructionsDir) ? localInstructionsDir : null },
  );
  // --light walks the plans without their items of severity low. What it leaves out is
  // known on every run: a resume across the two settings is safe only while it is none.
  const light = rulebook.lightRulebook(loaded);
  const rules = options.light ? light.rules : loaded;
  // `options.timing(phase, ms)` hears how long each phase took (DOH_TIMING=1 in main): the build
  // took 213 s on four branches, and only the duplication scan had ever been measured.
  let lastMark = Date.now();
  const mark = (phase) => {
    if (typeof options.timing !== 'function') return;
    const at = Date.now();
    options.timing(phase, at - lastMark);
    lastMark = at;
  };
  mark('rulebook');
  const ts = formatTimestamp(now);
  // When the reviewed project already has a `.claude/` folder, write into
  // `<project>/.claude/doh/codeReview/` (created on demand) instead of the skill's
  // own `reports/` dir, so real projects collect their artifacts under doh.
  // `legacyDir` is where the layout before runs/ + cache/ kept everything.
  const projectClaudeDir = path.join(project, '.claude');
  const useProjectDoh = isDirectory(projectClaudeDir);
  const legacyDir = useProjectDoh
    ? path.join(projectClaudeDir, 'doh')
    : path.join(skillDir, 'reports');
  const root = useProjectDoh ? path.join(legacyDir, 'codeReview') : legacyDir;
  const runsDir = path.join(root, 'runs');
  // Every run gets its own folder named after its start, and every target of it a
  // branch folder inside, so the report itself is always `raport.md|html` and runs of
  // one branch sort by time. Down to the second: two runs started a minute apart must
  // not share a folder.
  // The Markdown report is always the working file the reviewer writes to. In
  // html mode `render-report.cjs` turns it into `htmlReportPath` at the end of
  // the run and removes it, so the analysis steps never see the format choice.
  // `withChecklist` is the other output choice, read only by the assembly: every
  // part still carries its checklist, and the renderer cuts them from the finished
  // report unless it is true. `light` reaches the renderer the same way: it cuts every
  // Low finding and leaves the page without code snippets.
  const reportPaths = (branchName) => {
    const reportPath = path.join(runsDir, `${ts.date}-${ts.time}-${ts.seconds}`, sanitizeBranchName(branchName), `${reportStem}.md`);
    return {
      reportPath,
      htmlReportPath: wantsHtml ? reportPath.replace(/\.md$/, '.html') : null,
      withChecklist: !!options.withChecklist,
      ...(options.withRuleText ? { withRuleText: true } : {}),
      ...(options.light ? { light: true } : {}),
      ...(options.dedupItems ? { dedupItems: true } : {}),
    };
  };
  const claudeMdPath = path.join(project, 'CLAUDE.md');
  result.projectInstructionsDir = hasProjectInstructions ? projectInstructionsDir : null;
  result.claudeMd = fs.existsSync(claudeMdPath) ? claudeMdPath : null;
  result.warnings = [...rules.warnings];
  if (rules.kinds.length === 0) {
    result.warnings.push('instructions/ holds no file kind - review uses only the project CLAUDE.md and the universal points (cross-file consistency, regressions, readability).');
  }
  if (options.light) {
    const shown = light.dropped.slice(0, 10).join(', ') + (light.dropped.length > 10 ? `, (+${light.dropped.length - 10} more)` : '');
    const cut = `every Low finding${wantsHtml ? ' and every code snippet' : ''}`;
    result.warnings.push(light.dropped.length > 0
      ? `--light: ${light.dropped.length} item(s) of severity low are left out of every checklist: ${shown}. The report also leaves out ${cut}.`
      : `--light: no item of the rulebook has severity low, so every checklist is walked whole - the report still leaves out ${cut}.`);
  }

  // The kind of a path is decided once per run: a file listed on two targets is
  // still one kind. A path two kinds describe equally well keeps its tie here, to be
  // reported once for the files still under review when the context is done.
  const kindMatches = new Map();
  const kindOf = (filePath) => {
    if (!kindMatches.has(filePath)) kindMatches.set(filePath, rulebook.matchKind(rules, filePath));
    return kindMatches.get(filePath).kind;
  };

  // Every run records the post-image blob of each reviewed file in the target's
  // cache folder, so the next `--since-last` run can drop files whose content never
  // moved. Written even when the flag is off — the first incremental run needs
  // something to compare against — and trusted only as far as the previous run
  // got: a review that died half-way still recorded the whole file list. The same
  // snapshot names the run's report, which is how the next run finds one to resume.
  const pendingSnapshots = new Map();
  // The revision each target reviews, in the form the duplication scan reads it
  // (duplication-scan.cjs) - kept out of the target, which is the reviewer's JSON.
  const scanSources = new Map();
  const snapshotPathOf = (target) =>
    path.join(cacheDirOf(root, sanitizeBranchName(target.branch)), `.last-review-${target.kind}.json`);
  // The layout before runs/ + cache/ kept the snapshot in the branch's report folder.
  // Moved, not copied, the first time the branch is reviewed since: a --since-last run
  // right after the upgrade still has something to compare against, and no second copy
  // is left to go stale. The reports themselves stay where they are.
  const adoptLegacySnapshot = (target) => {
    const to = snapshotPathOf(target);
    const from = path.join(legacyDir, sanitizeBranchName(target.branch), `.last-review-${target.kind}.json`);
    if (fs.existsSync(to) || !fs.existsSync(from)) return;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    } catch {}
  };
  const resumeFrom = (target, currentBlobs) => {
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(snapshotPathOf(target), 'utf8'));
    } catch {}
    // Only a run of this codeReview folder: a report path from before runs/ existed is
    // --since-last's to read, never a run to continue.
    const run = previous && typeof previous.reportPath === 'string' ? findInterruptedRun(previous.reportPath) : null;
    if (!run || !samePath(run.root, root) || run.branchDir !== sanitizeBranchName(target.branch)) return false;
    const runDir = run.dir.replace(/\\/g, '/');
    // Its parts were walked against the other checklists: only the report output differs
    // while --light leaves out no item, and the assembly follows this run's setting.
    if (!!previous.light !== !!options.light && light.dropped.length > 0) {
      result.warnings.push(`[${target.branch}] The interrupted review from ${run.stamp} ran ${previous.light ? 'with' : 'without'} --light, whose checklists differ from this run's, so it is not resumed - this run starts from scratch. Its run folder: rm -rf "${runDir}".`);
      return false;
    }
    if (currentBlobs) {
      const same = previous.files
        && Object.keys(previous.files).length === currentBlobs.size
        && [...currentBlobs].every(([p, blob]) => previous.files[p] === blob);
      if (!same) {
        result.warnings.push(`[${target.branch}] The interrupted review from ${run.stamp} was of different content than this target holds now, so it is not resumed - this run starts from scratch. Its run folder: rm -rf "${runDir}".`);
        return false;
      }
    } else if (previous.folder !== target.folder) {
      result.warnings.push(`[${target.branch}] The interrupted review from ${run.stamp} was of folder "${previous.folder}", not "${target.folder}", so it is not resumed - this run starts from scratch. Its run folder: rm -rf "${runDir}".`);
      return false;
    } else {
      result.warnings.push(`[${target.branch}] Resuming the interrupted review from ${run.stamp} without a content check (folder mode keeps no snapshot of file contents) - if files of this folder changed since, delete its run folder (rm -rf "${runDir}") and run again.`);
    }
    if (Array.isArray(previous.reviewed)) {
      // In the order that run numbered its parts: a file's part number is its position.
      const reviewed = new Map(previous.reviewed.map((p, i) => [p, i]));
      target.files = target.files.filter((f) => reviewed.has(f.path)).sort((a, b) => reviewed.get(a.path) - reviewed.get(b.path));
    }
    if (previous.sinceLast) {
      target.unchangedSinceLastReview = previous.sinceLast.unchanged;
      target.previousReportPath = previous.sinceLast.previousReportPath;
    }
    target.reportPath = previous.reportPath;
    target.htmlReportPath = wantsHtml ? previous.reportPath.replace(/\.md$/, '.html') : null;
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
    adoptLegacySnapshot(target);
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
          if (previous.light && !options.light) {
            result.warnings.push(`[${target.branch}] --since-last: the previous review ran with --light, so the skipped file(s) were never checked against the items of severity low and its report shows no Low finding - re-run this target without --since-last for a full review.`);
          }
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
      result.warnings.push(`Branches "${clash.branch}" and "${target.branch}" produce the same report folder (${path.basename(path.dirname(target.reportPath))}), so the second review would overwrite the first and both would share one --since-last snapshot. Review them in separate runs.`);
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
  // Files of one KIND share one plan - the kind IS the plan - so a 200-file diff
  // repeats about eight distinct plans twenty-five times each. Measured with the
  // plans written out per file: 36 850 B of `checklist`, against 2 274 B as a catalog
  // and an index - roughly 13 000 tokens of the orchestrator's own context, which is
  // the thing this whole architecture exists to protect.
  // A kind narrowed for one file (rulebook.cjs planOf) is a plan of its own: its key names the
  // instructions it left out.
  const planCatalog = [];
  const planIndex = new Map();
  const planFor = (kind) => {
    const key = kind ? (kind.skipped ? `${kind.name}\u0000${kind.skipped.join(',')}` : kind.name) : null;
    let at = planIndex.get(key);
    if (at === undefined) {
      at = planCatalog.length;
      planCatalog.push(kind);
      planIndex.set(key, at);
    }
    return at;
  };

  const makeFiles = (rawFiles, rangesByPath) => rawFiles.map((f) => {
    const kind = kindOf(f.path);
    return {
      path: f.path,
      status: f.status,
      // Only a rename/copy has one; the mechanical-change gate compares the two
      // names (and their folders) against the naming instructions.
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      // An INDEX into `checklistPlans`, which holds the plan of this file's kind: its
      // name and role, and one `<id>:<items>` entry per instruction it walks.
      plan: planFor(kind),
      // Every item of that plan; the reviewer reports `<checked>/<checklistTotal>` per file.
      checklistTotal: kind ? kind.itemCount : 0,
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
      ...reportPaths(branchName),
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
        ...reportPaths(branchName),
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

  mark('targets');

  // Each target's reviewed files as the review reads them (path -> text, without deleted and
  // binary ones), and the projects its whole-repository reads cover (revisionScope) - both
  // decided once and shared by the duplication scan and the facts.
  const targetTexts = new Map();
  const textsOf = (target) => {
    if (targetTexts.has(target)) return targetTexts.get(target);
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
    const reviewed = new Map();
    for (const f of target.files) {
      const text = f.status === 'D' ? null : readContent(f.path);
      if (text !== null && !text.includes('\u0000')) reviewed.set(f.path, text);
    }
    const out = { readContent, reviewed };
    targetTexts.set(target, out);
    return out;
  };
  const targetScopes = new Map();
  const scopeOf = (target) => {
    if (!targetScopes.has(target)) {
      const found = revisionScope(project, scanSources.get(target), textsOf(target).reviewed);
      targetScopes.set(target, found);
      if (found.scope) {
        result.warnings.push(`[${target.branch}] The duplication scan and the repository facts read ${found.scope.roots.length} project(s) of the repository - the reviewed files' own, the ones they import and the importers of a reviewed library: ${found.scope.roots.join(', ')}.`);
      }
    }
    return targetScopes.get(target);
  };

  // Copy/paste detection over each reviewed revision (duplication-scan.cjs). Runs
  // only when the caller hands the scanner in - main() does - because it spawns
  // jscpd through npx, which tests and library callers must not pay for.
  // `scanTargets` scans every target in one call, side by side, and keeps a branch target's
  // exported tree as its `snapshotDir`: the reviewed revision as plain files, which a walker
  // searches with the Grep tool. A `git grep <commit>` per question cost a walker 30-250 s each
  // with seven agents at work (2026-10-27), against 1.6 s alone. The working tree of a staged
  // (after `git add .`) or folder review is its revision already.
  const applyScan = (target, scan) => {
    if (scan.tree) {
      target.snapshotDir = scan.tree.replace(/\\/g, '/');
      target.snapshotOwned = true;
    }
    if (scan.error) {
      result.warnings.push(`[${target.branch}] Duplication scan (jscpd) did not run: ${scan.error}. Duplicated code is searched for by the review alone.`);
      return;
    }
    target.duplicationCandidates = scan.candidates;
    if (scan.omitted > 0) {
      result.warnings.push(`[${target.branch}] Duplication scan: ${scan.omitted} more duplication candidate(s) found than the ${scan.candidates.length} listed - they are not in this review.`);
    }
    if (scan.boilerplate > 0) {
      result.warnings.push(`[${target.branch}] Duplication scan: ${scan.boilerplate} changed block(s) repeat a pattern found more than ${duplication.maxCopies} times in the codebase - boilerplate, not listed as candidates.`);
    }
  };
  const jobOf = (target, i) => ({
    project,
    source: scanSources.get(target),
    files: target.files,
    isSkipped: isSkippedPath,
    scope: target.files.length > 0 ? scopeOf(target).scope : null,
    // Short: the tree's own paths go deep, and a path past 260 characters is a trap on Windows.
    treeRoot: target.kind === 'branch' && target.files.length > 0 ? path.join(root, snapshotsDirName, `${ts.time}-${ts.seconds}-${i + 1}`) : null,
  });
  if (options.scanTargets) {
    const scans = options.scanTargets(result.targets.map(jobOf));
    result.targets.forEach((target, i) => applyScan(target, (scans && scans[i]) || { error: 'no scan result' }));
  } else if (options.scanDuplicates) {
    for (const target of result.targets) {
      const { treeRoot, ...job } = jobOf(target, 0);
      applyScan(target, options.scanDuplicates(job));
    }
  }
  for (const target of result.targets) {
    if (!target.snapshotDir && target.kind !== 'branch') target.snapshotDir = project.replace(/\\/g, '/');
  }
  mark('scan');

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
  // What the cross-file bundle of each target is written from, once the walked items are known.
  const pendingCross = new Map();
  for (const target of result.targets) {
    const blobs = pendingSnapshots.get(target);
    const { readContent, reviewed: reviewedTexts } = textsOf(target);
    pendingLedgers.set(target, formatImportLedger(target.files, readContent).text);
    // The repository facts (repo-facts.cjs) about the reviewed files, from the revision the
    // review reads. A failure costs the bundles their facts, never the review.
    let universe = { files: reviewedTexts, factRoot: '', partial: false };
    let collected = { facts: new Map(), exportsByFile: new Map(), membersByFile: new Map(), specsByFile: new Map(), cross: [], answers: new Map() };
    if (reviewedTexts.size > 0) {
      try {
        universe = loadFactUniverse(project, scanSources.get(target), reviewedTexts, scopeOf(target));
        collected = repoFacts.collectFacts({ files: universe.files, reviewed: new Set(reviewedTexts.keys()), root: universe.factRoot });
      } catch (err) {
        universe = { files: reviewedTexts, factRoot: '', partial: false };
        result.warnings.push(`[${target.branch}] Repository facts were not collected (${(err && err.message) || err}) - the file bundles carry the plan without them.`);
      }
    }
    if (universe.partial) {
      result.warnings.push(`[${target.branch}] Repository facts come from part of the repository (git could not list it, or it holds more than ${factFileLimit} files / ${factTotalBytes / 1024 / 1024} MB of sources) - every fact only points at its line.`);
    }
    // Each file's plan without the instructions that do not apply to it (rulebook.cjs planOf): an
    // `appliesWhen` reads the lines the review reports on - the whole of an added file.
    for (const f of target.files) {
      const scoped = rulebook.planOf(kindOf(f.path), f.path, reportedText(f, reviewedTexts.get(f.path)), rules.instructions);
      f.plan = planFor(scoped);
      f.checklistTotal = scoped ? scoped.itemCount : 0;
    }
    const factFiles = {};
    target.importLedger = target.reportPath.replace(/\.md$/, '.imports.txt');
    // Forward slashes: the same path works in a Read, in fs, and in a POSIX shell,
    // and a JSON string of it is not doubled by escaping.
    target.workDir = target.reportPath.replace(/\.md$/, '.work').replace(/\\/g, '/');
    // Matches land in a file, so they reach the reviewer through a Read; `$$` (the
    // shell's pid) keeps two searches of one run from overwriting each other. git grep exits 1
    // on no match, which is an answer ("0 match(es)", exit 0), and 2 or more on a pattern it
    // rejects, which is not: printed as `0 match(es)` it read as "nothing exists".
    // In a repository of several projects it searches the ones the review reaches, like the
    // scan and the facts: half the files, half the time.
    const reach = target.files.length > 0 ? scopeOf(target).scope : null;
    const searched = reach && reach.roots.length > 0
      ? target.commands.grep.replace(/ --$/, ` -- ${reach.roots.map(q).join(' ')}`)
      : target.commands.grep;
    target.commands.grep = `f=${q(`${target.workDir}/grep-`)}$$.txt; ${searched} > "$f" 2> "$f.err"; s=$?; if [ "$s" -le 1 ]; then echo "$(wc -l < "$f") match(es) -> $f"; else echo "grep failed (exit $s - is the pattern a valid extended regex?): $(head -c 300 "$f.err")" >&2; (exit "$s"); fi`;
    const diffArgs = pendingDiffArgs.get(target);
    const patchFlags = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
    const patches = diffArgs ? splitPatchByPath(tryGit(project, [...quiet, 'diff', ...patchFlags, ...diffArgs]) || '') : new Map();
    // The files the diff changed only mechanically (mechanical.cjs): what each one's diff did, the
    // words the target's renames replaced, and where the old ones are still in the reviewed revision.
    const learned = mechanical.substitutionMap(target.files);
    const mechanicalOf = new Map();
    for (const f of diffArgs ? target.files : []) {
      if (f.status === 'A' || f.status === 'D') continue;
      const reason = mechanical.classify({ status: f.status, ...mechanical.diffLines(patches.get(f.path) || '') }, learned);
      if (reason) mechanicalOf.set(f.path, reason);
    }
    const leftOver = mechanicalOf.size > 0 && Object.keys(learned).length > 0
      ? mechanical.leftovers(learned, universe.files)
      : { total: 0, hits: [] };
    // The files of one walker setting walk together: a window is a run of consecutive files, and a
    // rename branch whose mechanical files lay between the others by path was cut into eleven
    // windows (2026-10-27). Behaviour first - it carries the findings - then the files of a light
    // kind, then the mechanical ones; a resumed run keeps the order its parts were numbered in.
    // A group shorter than `lightRunMin` stays among its neighbours, which it is walked with anyway:
    // moved to the end it was a window of its own for one file.
    if (!target.resume) {
      const lightKind = (f) => !!(planCatalog[f.plan] && planCatalog[f.plan].walker);
      const mechanicalGroup = mechanicalOf.size >= lightRunMin;
      const lightGroup = target.files.filter((f) => lightKind(f) && !mechanicalOf.has(f.path)).length >= lightRunMin;
      const rank = (f) => (mechanicalOf.has(f.path) ? (mechanicalGroup ? 2 : 0) : lightKind(f) && lightGroup ? 1 : 0);
      target.files = target.files.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map(({ f }) => f);
    }
    // The part files' own width (check-part.cjs), so `03-a.ts` pairs with `part03.md`.
    const width = Math.max(2, String(target.files.length + 2).length);
    const writes = [];
    // Rendered once every file is known: a bundle ends with the Reads of the next batch.
    const bundles = [];
    target.files.forEach((f, i) => {
      const stem = `${target.workDir}/${String(i + 1).padStart(width, '0')}-${path.basename(f.path).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`;
      f.contentPath = null;
      f.diffPath = null;
      if (mechanicalOf.has(f.path)) f.mechanical = mechanicalOf.get(f.path);
      let diffChars = 0;
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
          diffChars = patch.length;
          writes.push([f.diffPath, patch.endsWith('\n') ? patch : `${patch}\n`]);
        }
      }
      // The file's bundle (review-bundle.cjs): what Step 3 reads next to the file. `f.plan`
      // still indexes the full plan catalog here; it is remapped below.
      const kind = planCatalog[f.plan];
      const text = reviewedTexts.has(f.path) ? reviewedTexts.get(f.path) : null;
      // A file another project imports from outside what the facts read: they point, never decide.
      const scope = targetScopes.has(target) ? targetScopes.get(target).scope : null;
      const partialHere = universe.partial || !!(scope && scope.open.has(f.path));
      const bound = reviewBundle.bindFile({
        plan: kind ? kind.plan : [],
        instructions: rules.instructions,
        filePath: f.path,
        text,
        facts: collected.facts.get(f.path) || [],
        context: {
          // A template's signal reads are told from its component's methods; a class with an
          // inline template is walked by the template probes as well.
          companionText: /\.html?$/.test(f.path) ? universe.files.get(f.path.replace(/\.html?$/, '.ts')) : undefined,
          inlineTemplate: text !== null && /\.[cm]?[jt]sx?$/.test(f.path) && /\btemplate\s*:\s*`/.test(text),
        },
        partial: partialHere,
        // An answer states what the whole repository holds: from part of it, the reviewer searches.
        answers: partialHere ? {} : collected.answers.get(f.path) || {},
      });
      if (Object.keys(bound.items).length > 0 || bound.info.length > 0) factFiles[f.path] = bound;
      f.bundlePath = `${stem}.bundle.md`;
      bundles.push({
        file: f,
        number: i + 1,
        lineCount: reviewBundle.lineCountOf(reviewedTexts.get(f.path)),
        readChars: (text === null ? 0 : text.length) + diffChars,
        render: {
          file: f,
          kind,
          instructions: rules.instructions,
          bound,
          exports: collected.exportsByFile.get(f.path) || [],
          members: collected.membersByFile.get(f.path) || [],
          specs: collected.specsByFile.get(f.path) || null,
          candidates: (target.duplicationCandidates || []).filter((c) => c.path === f.path),
          factRoot: universe.factRoot,
          partial: partialHere,
          mechanical: f.mechanical ? { reason: f.mechanical, map: learned, leftovers: leftOver } : null,
        },
      });
    });
    target.factsPath = `${target.workDir}/${reviewBundle.factsFileName}`;
    writes.push([target.factsPath, JSON.stringify(reviewBundle.factsDocument({
      files: factFiles, factRoot: universe.factRoot, partial: universe.partial, rules: reviewBundle.rulesOf(rules.instructions),
    }))]);
    target.crossBundlePath = `${target.workDir}/${reviewBundle.crossBundleName}`;
    // The batches of the files still to walk - a resumed run's finished files keep their
    // bundle, outside any batch. `batches` lists the multi-file ones as [first, last] file
    // numbers (check-part.cjs lets their parts come in one response), and `start` the Reads
    // the walk opens with.
    const n = target.files.length;
    const done = new Set(target.resume ? target.resume.doneFiles : []);
    const pending = bundles.filter((b) => !done.has(b.file.path));
    // The bundle as rendered below, less its `partia:` and `## Dalej` lines, and the Reads beside it.
    // A mechanical file is read through its short bundle (`fullPath`, review-bundle.cjs).
    const charsOf = new Map(pending.map((b) => [b.number, b.readChars + reviewBundle.renderBundle({ ...b.render, lineCount: b.lineCount, ...(b.file.mechanical ? { fullPath: b.file.bundlePath } : {}) }).length]));
    // The kind's `walker` (rulebook.cjs readWalker): files that need no deep reasoning share
    // batches and windows only with their like, so a window of them runs on the lighter model.
    // A run shorter than `lightRunMin` files stays with its neighbours: a walker's start costs
    // more than the lighter model saves on one or two files.
    const bundleOf = new Map(bundles.map((b) => [b.number, b]));
    // A file the script found mechanical is walked like a models kind's, in windows of its own class.
    const isMechanical = (number) => !!bundleOf.get(number).file.mechanical;
    const ownWalker = (number) => {
      const kind = planCatalog[bundleOf.get(number).file.plan];
      return (kind && kind.walker) || (isMechanical(number) ? mechanicalWalker : null);
    };
    const keyOf = (walker) => (walker ? `${walker.model || ''}|${walker.effort || ''}` : '');
    const order = pending.map((b) => b.number);
    const keys = new Map(order.map((number) => [number, `${isMechanical(number) ? reviewBundle.mechanicalClass : ''}${keyOf(ownWalker(number))}`]));
    for (let start = 0, i = 1; i <= order.length; i++) {
      if (i < order.length && keys.get(order[i]) === keys.get(order[start]) && order[i] === order[i - 1] + 1) continue;
      if (keys.get(order[start]) && i - start < lightRunMin) for (let j = start; j < i; j++) keys.set(order[j], '');
      start = i;
    }
    const walkerKey = (number) => keys.get(number) || '';
    const walkerOf = (number) => (walkerKey(number) ? ownWalker(number) : null);
    const batches = options.batch === false
      ? pending.map((b) => [b.number])
      : reviewBundle.planBatches(pending.map((b) => ({
        number: b.number,
        lines: b.lineCount,
        items: b.file.checklistTotal,
        chars: charsOf.get(b.number),
        walker: walkerKey(b.number),
      })));
    // The windows - runs of whole batches, one sub-agent each - and the first and last file of each.
    // A resume with drafts of refused parts is walked by the conversation that promotes them.
    const drafts = target.resume && Array.isArray(target.resume.drafts) && target.resume.drafts.length > 0;
    const windows = options.windows === false || drafts
      ? []
      : reviewBundle.planWindows(
        batches,
        (number) => reviewBundle.walkTokens(charsOf.get(number), isMechanical(number) ? reviewBundle.mechanicalLimits.fileTokens : undefined),
        undefined,
        (batch) => walkerKey(batch[0]),
        reviewBundle.limitsOfClass,
      );
    const windowSpans = windows.map((window) => [window[0][0], window[window.length - 1][window[window.length - 1].length - 1]]);
    const windowEnds = new Map(windowSpans.map(([first, last]) => [last, { first, last }]));
    const byNumber = new Map(bundles.map((b) => [b.number, b]));
    const crossPartPath = reviewBundle.partPathOf(target.reportPath, n + 1, n);
    // The cross-file pass's own brief (SKILL.md Step 3, Windows): a fresh agent makes the pass.
    target.crossBriefPath = n > 0 ? `${target.workDir}/${reviewBundle.crossBriefName}` : null;
    // A target the conversation walks itself in a few files is no long walk to escape: it makes
    // the pass too, with every file still in its context. A fresh agent re-read 0.4M tokens of its
    // own to answer the pass over three files of one component, and found nothing (2026-10-27).
    const crossInline = windows.length === 0 && n > 0 && n <= crossInlineMax;
    if (crossInline) target.crossInline = true;
    const batchOf = new Map();
    batches.forEach((batch, k) => {
      const next = k + 1 < batches.length ? batches[k + 1].map((number) => byNumber.get(number).file) : [];
      for (const number of batch) batchOf.set(number, { batch, next });
    });
    for (const b of bundles) {
      const at = batchOf.get(b.number);
      const last = at && at.batch.length > 0 && at.batch[at.batch.length - 1] === b.number;
      const rendered = {
        ...b.render,
        lineCount: b.lineCount,
        partPath: reviewBundle.partPathOf(target.reportPath, b.number, n),
        batch: at && at.batch.length > 1 ? at.batch.map((number) => byNumber.get(number).file.path) : null,
        next: last ? reviewBundle.renderNext({ nextFiles: at.next, crossBundlePath: target.crossBundlePath, crossPartPath, crossBriefPath: crossInline ? null : target.crossBriefPath, window: windowEnds.get(b.number) || null }) : null,
      };
      // A mechanical file: the short bundle is the one its walk reads, the full one waits beside it.
      if (b.file.mechanical) {
        b.file.fullBundlePath = b.file.bundlePath.replace(/\.bundle\.md$/, '.full.bundle.md');
        writes.push([b.file.fullBundlePath, reviewBundle.renderBundle(rendered)]);
        writes.push([b.file.bundlePath, reviewBundle.renderBundle({ ...rendered, fullPath: b.file.fullBundlePath })]);
      } else {
        writes.push([b.file.bundlePath, reviewBundle.renderBundle(rendered)]);
      }
    }
    // A window's brief is the one thing its sub-agent is sent: the main conversation passes the path.
    const settings = {
      reportPath: target.reportPath,
      htmlReportPath: target.htmlReportPath,
      workDir: target.workDir,
      withChecklist: target.withChecklist,
      withRuleText: target.withRuleText,
      light: target.light,
      dedupItems: target.dedupItems,
      ...(target.snapshotDir ? { snapshotDir: target.snapshotDir } : {}),
      commands: { grep: target.commands.grep },
    };
    target.windows = windows.map((window, k) => {
      const brief = `${target.workDir}/${reviewBundle.windowBriefName(k + 1)}`;
      writes.push([brief, reviewBundle.renderWindowBrief({
        index: k + 1,
        total: windows.length,
        target: settings,
        batches: window.map((batch) => batch.map((number) => {
          const { file } = byNumber.get(number);
          return { number, path: file.path, partPath: reviewBundle.partPathOf(target.reportPath, number, n), reads: reviewBundle.readsOf([file]) };
        })),
      })]);
      // What the window's walker is spawned with: its kinds' walker setting (a window holds one,
      // planWindows), else the run's --walker-model / --walker-effort; nothing is "inherit".
      const own = walkerOf(window[0][0]);
      const model = (own && own.model) || options.walkerModel || '';
      const effort = (own && own.effort) || options.walkerEffort || '';
      // The part of the window's last file: once it is on disk the window is done, which is what
      // the dispatcher waits for without ending its turn (SKILL.md Step 3, Windows).
      return {
        files: windowSpans[k],
        brief,
        lastPart: reviewBundle.partPathOf(target.reportPath, windowSpans[k][1], n),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      };
    });
    target.batches = batches.filter((batch) => batch.length > 1).map((batch) => [batch[0], batch[batch.length - 1]]);
    target.start = batches.length > 0
      ? reviewBundle.readsOf(batches[0].map((number) => byNumber.get(number).file))
      : n > 0 ? [target.crossBundlePath, `${reviewBundle.skillDir}/references/cross-file.md`] : [];
    pendingCross.set(target, {
      cross: collected.cross,
      factRoot: universe.factRoot,
      partial: universe.partial,
      crossPartPath,
      closingPartPath: reviewBundle.partPathOf(target.reportPath, n + 2, n),
      withPr: !!target.htmlReportPath,
      files: target.files,
      workDir: target.workDir,
    });
    pendingWork.set(target, writes);
  }
  mark('bundles');

  // Only the plans a reviewed file still points at are handed out - a file dropped
  // by `--since-last` or by the reviewed subset takes its kind's plan with it - and
  // every file's index is remapped onto that shorter list, in order of first use.
  const planAt = new Map();
  const noKind = new Set();
  const tied = new Set();
  for (const target of result.targets) {
    for (const file of target.files) {
      if (!planAt.has(file.plan)) planAt.set(file.plan, planAt.size);
      file.plan = planAt.get(file.plan);
      const match = kindMatches.get(file.path);
      if (!match.kind) noKind.add(file.path);
      else if (match.tied.length > 0) tied.add(`${file.path} (${match.tied.join(' = ')})`);
    }
  }
  const plannedKinds = [...planAt.keys()].map((at) => planCatalog[at]);
  result.checklistPlans = plannedKinds.map((kind) => (kind
    ? {
      kind: kind.name,
      role: kind.role,
      ...(kind.notes.length > 0 ? { notes: kind.notes } : {}),
      checklist: kind.plan.map((step) => `${step.id}:${rulebook.formatItemSpec(step.numbers)}`),
    }
    : { kind: null, role: 'No file kind matches this path.', checklist: [] }));
  // Capped: a 200-file diff would otherwise spend thousands of tokens on one
  // warning line the reviewer has to read and translate.
  const capped = (entries) => entries.slice(0, 10).join(', ') + (entries.length > 10 ? `, (+${entries.length - 10} more)` : '');
  if (noKind.size > 0 && rules.kinds.length > 0) {
    result.warnings.push(`${noKind.size} file(s) match no file kind - reviewed only against the project CLAUDE.md and the universal points: ${capped([...noKind])}`);
  }
  if (tied.size > 0) {
    result.warnings.push(`${tied.size} file(s) match two file kinds equally well - each is reviewed as the first kind named, and the rulebook needs a more specific pattern: ${capped([...tied])}`);
  }

  // What the run's plans walk, instruction by instruction: the items its numbered
  // copy lists, and the instructions whose gate and per-file rule are handed out.
  const walked = new Map();
  for (const kind of plannedKinds) {
    for (const step of kind ? kind.plan : []) {
      const numbers = walked.get(step.id) || new Set();
      for (const n of step.numbers) numbers.add(n);
      walked.set(step.id, numbers);
    }
  }
  const walkedIds = [...walked.keys()].sort();
  const instructionOf = (id) => rules.instructions.get(id);
  // The `gate` sentence of every instruction that declares one. The reviewer
  // answers it once per file before walking that instruction's items: a failed
  // gate collapses the whole instruction into one ticked range line.
  result.checklistGates = Object.fromEntries(walkedIds
    .filter((id) => instructionOf(id).gate)
    .map((id) => [id, instructionOf(id).gate]));
  // Instructions declaring `findings: per-file`: their items are facets of one requirement, so
  // a file's breaches of one are a single finding naming every item broken (references/walk.md Step 3
  // point 3) - the part check lets that finding name several of its items, and refuses a second.
  result.checklistPerFile = walkedIds.filter((id) => instructionOf(id).findings === 'per-file');
  for (const [target, cross] of pendingCross) {
    pendingWork.get(target).push([target.crossBundlePath, reviewBundle.renderCrossBundle({
      ...cross,
      instructions: rules.instructions,
      walked,
      candidates: target.duplicationCandidates || null,
      importLedger: target.importLedger,
    })]);
    if (target.crossBriefPath) {
      pendingWork.get(target).push([target.crossBriefPath, reviewBundle.renderCrossBrief({
        target: {
          reportPath: target.reportPath,
          htmlReportPath: target.htmlReportPath,
          workDir: target.workDir,
          importLedger: target.importLedger,
          ...(target.light ? { light: true } : {}),
          ...(target.snapshotDir ? { snapshotDir: target.snapshotDir } : {}),
          commands: { grep: target.commands.grep },
        },
        crossBundlePath: target.crossBundlePath,
        crossPartPath: cross.crossPartPath,
        closingPartPath: cross.closingPartPath,
      })]);
    }
  }

  // `numberedPath` is the copy of the instruction the reviewer reads (renderNumbered),
  // written with the reports into the first target's cache folder - where the run's
  // context goes too.
  const runCacheDir = result.targets.length > 0 ? cacheDirOf(root, sanitizeBranchName(result.targets[0].branch)) : null;
  const rulesDir = runCacheDir
    ? path.join(runCacheDir, 'checklists', result.targets[0].kind).replace(/\\/g, '/')
    : null;
  // `items` names the numbers that copy lists: an agent reviewing again with the copy
  // of an earlier run in its context re-reads it only when this names one it lacks.
  result.instructionsCatalog = walkedIds.map((id) => ({
    id,
    name: instructionOf(id).name,
    items: rulebook.formatItemSpec([...walked.get(id)].sort((a, b) => a - b)),
    ...(rulesDir ? { numberedPath: `${rulesDir}/${id}.md` } : {}),
  }));

  if (result.targets.length > 0) {
    fs.mkdirSync(root, { recursive: true });
    if (useProjectDoh) ensureDohGitignore(legacyDir);
    // Pruning runs in both locations and only ever inside runs/ (see pruneRuns).
    pruneRuns(runsDir, result.targets.map((target) => path.dirname(target.reportPath)));
    pruneSnapshots(path.join(root, snapshotsDirName), result.targets.map((target) => target.snapshotOwned && target.snapshotDir));
    // Rewritten whole every run, so a copy never outlives a change to its instruction.
    try {
      fs.rmSync(rulesDir, { recursive: true, force: true });
      fs.mkdirSync(rulesDir, { recursive: true });
      for (const entry of result.instructionsCatalog) {
        const numbers = [...walked.get(entry.id)].sort((a, b) => a - b);
        fs.writeFileSync(entry.numberedPath, rulebook.renderNumbered(instructionOf(entry.id), numbers));
      }
      // Step 2 reads this one file; the items reach the reviewer in the file bundles.
      result.rulebookNotesPath = `${rulesDir}/${reviewBundle.notesFileName}`;
      fs.writeFileSync(result.rulebookNotesPath, reviewBundle.renderRulebookNotes(walkedIds.map(instructionOf)));
    } catch (err) {
      result.errors.push(`Could not write the numbered instructions to ${rulesDir} (${(err && err.message) || err}) - the review reads its checklists from there, so it cannot run.`);
      // Dropped, not just reported: no target left is what stops Step 1 (exit 1),
      // whoever reads the error text.
      result.targets = [];
    }
    // A target whose work folder could not be written has nothing to be read from.
    const unwritten = new Set();
    // After the pruning, so an emptied run folder is not removed right after
    // being created for this run.
    for (const target of result.targets) {
      fs.mkdirSync(path.dirname(target.reportPath), { recursive: true });
      try {
        fs.writeFileSync(target.importLedger, pendingLedgers.get(target));
      } catch {
        result.warnings.push(`[${target.branch}] Could not write the import ledger ${target.importLedger} - collect the import edges while reading each file.`);
      }
      // Emptied first: a resumed run rewrites what the interrupted one wrote, all but its drafts.
      try {
        const drafts = target.resume ? keptDrafts(target.workDir, target.reportPath) : [];
        fs.rmSync(target.workDir, { recursive: true, force: true });
        fs.mkdirSync(target.workDir, { recursive: true });
        for (const [file, text] of [...(pendingWork.get(target) || []), ...drafts]) fs.writeFileSync(file, text);
        if (drafts.length > 0) target.resume.drafts = drafts.map(([file]) => file);
        // The header, and - for a fresh run - no part a run of the same second left behind,
        // which the assembly's concatenation would splice into this report.
        if (!target.resume) {
          const stem = path.basename(target.reportPath).replace(/\.md$/i, '');
          for (const name of fs.readdirSync(path.dirname(target.reportPath))) {
            if (name.startsWith(`${stem}.part`) && /\.part\d+\.md$/i.test(name)) fs.rmSync(path.join(path.dirname(target.reportPath), name), { force: true });
          }
        }
        if (!target.resume || !target.resume.headerWritten) {
          fs.writeFileSync(target.reportPath, reportHeader(target));
          if (target.resume) target.resume.headerWritten = true;
        }
      } catch (err) {
        result.errors.push(`[${target.branch}] Could not write the work folder ${target.workDir} (${(err && err.message) || err}) - the files under review are read from it, so this target is not reviewed.`);
        unwritten.add(target);
        continue;
      }
      const blobs = pendingSnapshots.get(target);
      try {
        fs.mkdirSync(path.dirname(snapshotPathOf(target)), { recursive: true });
        fs.writeFileSync(snapshotPathOf(target), JSON.stringify({
          at: now.toISOString(),
          reportPath: target.reportPath,
          // Folder mode reads the working tree, which has no blobs to record: its
          // snapshot only names the folder, so a resume continues the same one.
          ...(blobs ? { files: Object.fromEntries(blobs) } : { folder: target.folder }),
          // What a resumed run restores: the file list this run reviews and the
          // `--since-last` narrowing it was built with.
          reviewed: target.files.map((f) => f.path),
          ...(target.unchangedSinceLastReview
            ? { sinceLast: { unchanged: target.unchangedSinceLastReview, previousReportPath: target.previousReportPath || null } }
            : {}),
          // A --light run walked shorter checklists and reported no Low finding: what a
          // resume and the next --since-last run check before trusting this one.
          ...(options.light ? { light: true } : {}),
        }));
      } catch {}
    }
    result.targets = result.targets.filter((target) => !unwritten.has(target));
    if (result.targets.length > 0) {
      result.contextPath = path.join(runCacheDir, `.review-context-${result.targets[0].kind}.json`);
      for (const target of result.targets) target.commands.assemble = assembleCommand(target, result.contextPath, project, skillDir);
    }
    result.workflow = runWorkflow(result, options);
  }
  mark('write');
  return result;
}

// The snapshots a run left behind: the assembly removes its own, so one older than a day is a
// run that never assembled - except the ones this run itself is about to be read from.
function pruneSnapshots(dir, keep = [], maxAgeMs = 24 * 60 * 60 * 1000) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const stale = Date.now() - maxAgeMs;
  for (const name of names) {
    const full = path.join(dir, name);
    if (keep.some((k) => k && samePath(k, full))) continue;
    try {
      if (fs.statSync(full).mtimeMs < stale) fs.rmSync(full, { recursive: true, force: true });
    } catch {}
  }
}

// The Workflow tool's call (SKILL.md Step 3, Windows): the windows of every target, each target's
// cross-file pass after its own, as one background run the main conversation hears from once.
// The windows walk at once over all targets, `--parallel` of them (each target's `parallel` is the
// same number, for a session that dispatches them through the Agent tool). The script is copied
// into the run folder: the Workflow tool runs a `scriptPath` only from a folder of the project,
// and the plugin's own lies outside it. `args` stays small - the script derives each brief's
// path from `dir` and the window's number.
function runWorkflow(result, options) {
  const windowed = result.targets.filter((target) => (target.windows || []).length > 0);
  const total = windowed.reduce((sum, target) => sum + target.windows.length, 0);
  const lanes = Math.max(1, Math.min(options.parallel || defaultParallel, total));
  for (const target of result.targets) target.parallel = target.windows && target.windows.length > 0 ? lanes : 1;
  if (windowed.length === 0) return null;
  const source = path.join(defaultSkillDir, 'workflows', 'review-windows.js');
  let scriptPath = source.replace(/\\/g, '/');
  try {
    const copy = path.join(path.dirname(path.dirname(windowed[0].reportPath)), 'review-windows.js');
    fs.copyFileSync(source, copy);
    scriptPath = copy.replace(/\\/g, '/');
  } catch (err) {
    result.warnings.push(`Could not copy the workflow script into the run folder (${(err && err.message) || err}) - the Workflow tool may refuse ${scriptPath}; pass its text as \`script\` instead.`);
  }
  return {
    scriptPath,
    args: {
      lanes,
      targets: windowed.map((target) => ({
        dir: target.workDir,
        windows: target.windows.map((w) => [`${w.files[0]}-${w.files[1]}`, w.model || '', w.effort || '']),
        cross: { model: options.walkerModel || '', effort: options.walkerEffort || '' },
      })),
    },
  };
}

function main() {
  let context;
  try {
    context = buildContext({
      ...parseArgs(process.argv.slice(2)),
      scanTargets: duplication.scanTargets,
      // DOH_TIMING=1: each phase's time on stderr, which the reviewer never reads as the context.
      timing: process.env.DOH_TIMING ? (phase, ms) => process.stderr.write(`[doh-timing] ${phase} ${ms} ms\n`) : null,
    });
  } catch (err) {
    context = { targets: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(JSON.stringify(writeContext(context)) + '\n');
  process.exit(context.targets.length > 0 ? 0 : 1);
}

// FIXED IDENTIFIERS (SKILL.md Step 1 reads them): `contextPath`, `errors`, `warnings`,
// `targets[].branch|files|reportPath|resumed`. The whole context goes to `contextPath`,
// in the first target's cache folder; stdout carries only what Step 1 acts on at once.
// A run with no target has nothing worth a file, so it prints everything as before.
// FIXED IDENTIFIER: the file in a report's folder that names its context (check-part.cjs reads it).
const contextPointerName = '.review-context-path';

function writeContext(context) {
  if (!context.targets || context.targets.length === 0) return context;
  const first = context.targets[0];
  const { errors, warnings, contextPath: planned, ...rest } = context;
  // A context not built by buildContext names no path; it goes next to its first report.
  const contextPath = planned || path.join(path.dirname(first.reportPath), `.review-context-${first.kind}.json`);
  try {
    fs.writeFileSync(contextPath, layoutJson(rest) + '\n');
  } catch (err) {
    return { ...context, errors: [...(errors || []), `Could not write the context file ${contextPath} (${(err && err.message) || err}) - the full context follows inline.`] };
  }
  // Next to each report, the context that planned it: the part check runs before every Write,
  // and it otherwise opened every context of the cache folder to find this one (check-part.cjs
  // findContextFor) - on a monorepo, 66 MB of JSON parsed per part.
  for (const target of context.targets) {
    try {
      fs.mkdirSync(path.dirname(target.reportPath), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(target.reportPath), contextPointerName), `${contextPath}\n`);
    } catch {}
  }
  return {
    contextPath,
    errors: errors || [],
    warnings: warnings || [],
    // What the review itself uses, so the reviewer never reads the whole context file: the
    // scripts and hooks read that one. Keys a step needs beyond these stay in `contextPath`.
    // Counts, not lists: a 115-file run printed 31 kB here - more than the harness shows inline,
    // so it went to a file and cost a round trip to read back.
    outputFormat: context.outputFormat,
    walker: context.walker || { model: '', effort: '' },
    rulebookNotesPath: context.rulebookNotesPath,
    claudeMd: context.claudeMd,
    workflow: context.workflow || null,
    targets: context.targets.map((t) => {
      const windows = (t.windows || []).length;
      const unchanged = t.unchangedSinceLastReview;
      return {
        branch: t.branch,
        kind: t.kind,
        baseBranch: t.baseBranch === undefined ? null : t.baseBranch,
        baseSource: t.baseSource === undefined ? null : t.baseSource,
        prNumber: t.prNumber === undefined ? null : t.prNumber,
        files: t.files.length,
        reportPath: t.reportPath,
        htmlReportPath: t.htmlReportPath,
        workDir: t.workDir,
        ...(t.snapshotDir ? { snapshotDir: t.snapshotDir } : {}),
        crossBundlePath: t.crossBundlePath,
        crossBriefPath: t.crossBriefPath || null,
        ...(t.crossInline ? { crossInline: true } : {}),
        windows,
        ...(windows > 0 ? { parallel: t.parallel || 1 } : { start: t.start }),
        ...(t.light ? { light: true } : {}),
        skipped: (t.skipped || []).length,
        ...(unchanged ? { unchangedSinceLastReview: Array.isArray(unchanged) ? unchanged.length : unchanged, previousReportPath: t.previousReportPath || null } : {}),
        commands: { assemble: t.commands && t.commands.assemble },
        resumed: !!t.resume,
        resume: t.resume || null,
      };
    }),
  };
}

module.exports = { contextPointerName, reportHeader, reportedText, reportStem, runOf, cacheDirOf, pruneRuns, ensureDohGitignore, extractImports, formatImportLedger, readBlobs, listRevision, loadFactUniverse, revisionScope, unquoteGitPath, patchPathOf, splitPatchByPath, layoutJson, findInterruptedRun, writeContext, countOf, parseArgs, globToRegExp, sanitizeBranchName, formatTimestamp, git, tryGit, resolveRef, detectPrBase, detectForkBase, aheadCounts, detectCandidateBase, detectBaseBranch, parseRawDiff, parseDiffRangesByPath, parseHunkRanges, isSkippedPath, listFolderFiles, pruneReports, buildContext };

if (require.main === module) main();
