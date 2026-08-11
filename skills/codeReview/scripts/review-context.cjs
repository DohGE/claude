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
const skipGlobs = [
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
  const args = { mode: 'auto', branches: '', path: '', project: process.cwd(), output: 'html' };
  for (const arg of argv) {
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

function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  const result = { appliesTo: [], audience: undefined };
  if (!lines.length || lines[0].trim() !== '---') return result;
  let inAppliesTo = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    if (/^applies-to:\s*$/.test(line)) {
      inAppliesTo = true;
      continue;
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
      continue;
    }
    if (/^\S/.test(line)) inAppliesTo = false;
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

function parseNameStatus(output) {
  if (!output) return [];
  return output.split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t');
    return { path: parts[parts.length - 1], status: parts[0][0] };
  });
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

// audience: 'review' | 'implement' | undefined (no filtering). An instruction
// declares `audience: implement|review|both` in its frontmatter (default both)
// to control which consumer loads it — e.g. a coding persona is implement-only.
function loadInstructions(instructionsDir, audience) {
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
  const globals = [];
  for (const file of list(path.join(instructionsDir, 'global'))) {
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!keep(file, fm)) continue;
    if (fm.appliesTo.length > 0) {
      warnings.push(`Global instruction declares applies-to patterns, which are ignored for global instructions (move it to instructions/local): ${file}`);
    }
    globals.push(file);
  }
  const locals = [];
  for (const file of list(path.join(instructionsDir, 'local'))) {
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (!keep(file, fm)) continue;
    if (fm.appliesTo.length === 0) {
      warnings.push(`Local instruction has no applies-to patterns and will never match: ${file}`);
    }
    locals.push({ file, appliesTo: fm.appliesTo });
  }
  return { globals, locals, warnings };
}

function matchLocalInstructions(locals, filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return locals
    .filter((l) => l.appliesTo.some((p) => globToRegExp(p).test(normalized)))
    .map((l) => l.file);
}

// Keep only the reportsRetain newest reports so the reports folder does not
// grow without bound across runs. Both output formats count toward the cap, so
// a folder of HTML reports is capped exactly like a folder of Markdown ones.
// Reports live one level deep (one folder per branch); loose reports directly
// in reportsDir are still counted, so folders written before the per-branch
// grouping stay capped too. Best-effort: failures never break a review.
function pruneReports(reportsDir, retain = reportsRetain) {
  const isReport = (name) => name.endsWith('.md') || name.endsWith('.html');
  let entries;
  try {
    entries = fs.readdirSync(reportsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const branchDirs = [];
  const files = [];
  for (const entry of entries) {
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
// auth.json, pipeline-state.json). Keep the whole folder out of git with a
// catch-all .gitignore so nothing there is ever committed. Best-effort; a
// pre-existing .gitignore is left untouched.
function ensureDohGitignore(dohDir) {
  const gi = path.join(dohDir, '.gitignore');
  try {
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
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

  const instructions = loadInstructions(path.join(skillDir, 'instructions'), 'review');
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
  result.claudeMd = fs.existsSync(claudeMdPath) ? claudeMdPath : null;
  result.warnings = [...instructions.warnings];
  if (instructions.globals.length === 0 && instructions.locals.length === 0) {
    result.warnings.push('instructions/global and instructions/local are empty - review uses only the project CLAUDE.md and the universal points (cross-file consistency, regressions, readability).');
  }

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
  const makeFiles = (rawFiles, rangesArgsFor) => rawFiles.map((f) => ({
    path: f.path,
    status: f.status,
    localInstructions: matchLocalInstructions(instructions.locals, f.path),
    changedLines: f.status === 'A' || f.status === 'D'
      ? null
      : parseHunkRanges(tryGit(project, rangesArgsFor(f)) || ''),
  }));
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
    const { kept, skipped } = partition(parseNameStatus(tryGit(project, ['diff', '--name-status', `${baseRef}...${branchRef}`]) || ''));
    result.targets.push({
      kind: 'branch',
      branch: branchName,
      baseBranch: baseRef,
      baseSource: base.source,
      prNumber: base.source === 'pr' ? base.prNumber : null,
      ...reportPaths(branchName),
      commands: {
        diff: gitc(`diff ${baseRef}...${branchRef} -- ${q('<path>')}`),
        show: `${gitc(`show ${q(`${branchRef}:<path>`)}`)} | cat -n`,
      },
      files: makeFiles(kept, (f) => ['diff', '-U0', `${baseRef}...${branchRef}`, '--', f.path]),
      skipped,
    });
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
    const { kept, skipped } = partition(parseNameStatus(tryGit(project, ['diff', '--cached', '--name-status']) || ''));
    result.targets.push({
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
      files: makeFiles(kept, (f) => ['diff', '-U0', '--cached', '--', f.path]),
      skipped,
    });
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
      result.targets.push({
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
        files: makeFiles(kept, () => []),
        skipped,
      });
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
      result.warnings.push(`[${target.branch}] Files matching no local instruction (global checklists still apply): ${noLocal.join(', ')}`);
    }
  }

  // Deduplicate matched local instruction paths into one catalog; per-file
  // localInstructions become indexes into it (read each catalog file once).
  const catalog = new Set();
  for (const target of result.targets) {
    for (const file of target.files) for (const p of file.localInstructions) catalog.add(p);
  }
  result.localInstructionsCatalog = [...catalog].sort();
  const indexOf = new Map(result.localInstructionsCatalog.map((p, i) => [p, i]));
  for (const target of result.targets) {
    for (const file of target.files) {
      file.localInstructions = file.localInstructions.map((p) => indexOf.get(p));
    }
  }

  if (result.targets.length > 0) {
    fs.mkdirSync(reportsDir, { recursive: true });
    // The project's own `.claude/doh/` is the user's to manage (and is shared
    // with other artifacts) — never prune it; only cap the skill-local folder.
    if (useProjectDoh) ensureDohGitignore(reportsDir);
    else pruneReports(reportsDir);
    // After the pruning, so an emptied branch folder is not removed right after
    // being created for this run.
    for (const target of result.targets) fs.mkdirSync(path.dirname(target.reportPath), { recursive: true });
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

module.exports = { parseArgs, globToRegExp, parseFrontmatter, sanitizeBranchName, formatTimestamp, git, tryGit, resolveRef, detectPrBase, detectForkBase, detectCandidateBase, detectBaseBranch, parseNameStatus, parseHunkRanges, loadInstructions, matchLocalInstructions, isSkippedPath, listFolderFiles, pruneReports, buildContext };

if (require.main === module) main();
