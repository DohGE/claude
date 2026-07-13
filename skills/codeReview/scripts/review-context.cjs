#!/usr/bin/env node
'use strict';

// Deterministic mechanics for the doh:codeReview skill: argument parsing,
// glob matching, instruction frontmatter parsing, base-branch detection and
// the review-context JSON consumed by SKILL.md.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_DIR = path.resolve(__dirname, '..');
const BASE_CANDIDATES = ['main', 'master', 'develop', 'dev'];
const AUDIENCES = ['implement', 'review', 'both'];
const REPORTS_RETAIN = 30;

// Generated, vendored and binary files: reviewing them wastes context without
// producing findings. Skipped paths are listed per target so the report can
// mention them in one line.
const SKIP_GLOBS = [
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
  if (!skipRes) skipRes = SKIP_GLOBS.map(globToRegExp);
  const normalized = filePath.replace(/\\/g, '/');
  return skipRes.some((re) => re.test(normalized));
}

function parseArgs(argv) {
  const args = { mode: 'auto', branches: '', project: process.cwd() };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'mode') args.mode = m[2];
    else if (m[1] === 'branches') args.branches = m[2];
    else if (m[1] === 'project') args.project = m[2];
  }
  if (!['auto', 'staged', 'branches'].includes(args.mode)) {
    throw new Error(`Unknown --mode=${args.mode} (expected auto|staged|branches)`);
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

function resolveRef(project, name) {
  if (tryGit(project, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null) return name;
  if (tryGit(project, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]) !== null) return `origin/${name}`;
  return null;
}

function baseCandidates(project) {
  const names = [];
  const head = tryGit(project, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (head) names.push(head.replace('refs/remotes/origin/', ''));
  for (const n of BASE_CANDIDATES) if (!names.includes(n)) names.push(n);
  return names;
}

function detectBaseBranch(project, branchRef, branchName) {
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
    if (!AUDIENCES.includes(declared)) {
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

// Keep only the REPORTS_RETAIN newest reports so the reports folder does not
// grow without bound across runs. Best-effort: failures never break a review.
function pruneReports(reportsDir, retain = REPORTS_RETAIN) {
  let names;
  try {
    names = fs.readdirSync(reportsDir).filter((n) => n.endsWith('.md'));
  } catch {
    return;
  }
  if (names.length <= retain) return;
  const stamped = names.map((name) => {
    const full = path.join(reportsDir, name);
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

function buildContext(options) {
  const project = path.resolve(options.project || process.cwd());
  const skillDir = options.skillDir || SKILL_DIR;
  const now = options.now || new Date();
  const result = {
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
  const reportsDir = path.join(skillDir, 'reports');
  const claudeMdPath = path.join(project, 'CLAUDE.md');
  result.globalInstructions = instructions.globals;
  result.claudeMd = fs.existsSync(claudeMdPath) ? claudeMdPath : null;
  result.warnings = [...instructions.warnings];
  if (instructions.globals.length === 0 && instructions.locals.length === 0) {
    result.warnings.push('instructions/global and instructions/local are empty - review uses only the project CLAUDE.md and the universal points (cross-file consistency, regressions, readability).');
  }

  const gitc = (args) => `git -C ${q(project)} ${args}`;
  // Added files: the diff is the whole file, identical to showCommand output —
  // emit only one of the two. Deleted files: diff only. showCommand pipes
  // through `cat -n` so finding line numbers can be read off the output.
  const makeFiles = (rawFiles, diffFor, showFor) => rawFiles.map((f) => ({
    path: f.path,
    status: f.status,
    localInstructions: matchLocalInstructions(instructions.locals, f.path),
    diffCommand: f.status === 'A' ? null : diffFor(f),
    showCommand: f.status === 'D' ? null : `${showFor(f)} | cat -n`,
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
    const baseRef = detectBaseBranch(project, branchRef, branchName);
    if (!baseRef) {
      result.errors.push(`Cannot detect base branch for: ${branchName} (no origin/HEAD, main, master, develop or dev candidate found)`);
      return;
    }
    const { kept, skipped } = partition(parseNameStatus(tryGit(project, ['diff', '--name-status', `${baseRef}...${branchRef}`]) || ''));
    result.targets.push({
      kind: 'branch',
      branch: branchName,
      baseBranch: baseRef,
      reportPath: path.join(reportsDir, `${sanitizeBranchName(branchName)}-${ts.date}-${ts.time}.md`),
      files: makeFiles(
        kept,
        (f) => gitc(`diff ${baseRef}...${branchRef} -- ${q(f.path)}`),
        (f) => gitc(`show ${q(`${branchRef}:${f.path}`)}`),
      ),
      skipped,
    });
  };

  if (options.mode === 'staged') {
    const branchName = tryGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
    const { kept, skipped } = partition(parseNameStatus(tryGit(project, ['diff', '--cached', '--name-status']) || ''));
    result.targets.push({
      kind: 'staged',
      branch: branchName,
      baseBranch: null,
      reportPath: path.join(reportsDir, `${sanitizeBranchName(branchName)}-staged-${ts.date}-${ts.time}.md`),
      files: makeFiles(
        kept,
        (f) => gitc(`diff --cached -- ${q(f.path)}`),
        (f) => gitc(`show ${q(`:${f.path}`)}`),
      ),
      skipped,
    });
  } else if (options.mode === 'branches') {
    const names = [...new Set(String(options.branches || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
    if (names.length === 0) result.errors.push('No branches given (expected --branches="a,b;c").');
    for (const name of names) addBranchTarget(name);
  } else {
    const branchName = tryGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branchName || branchName === 'HEAD') {
      result.errors.push('Detached HEAD - check out a branch or pass an explicit branch list.');
    } else {
      addBranchTarget(branchName);
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
    pruneReports(reportsDir);
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

module.exports = { parseArgs, globToRegExp, parseFrontmatter, sanitizeBranchName, formatTimestamp, git, tryGit, resolveRef, detectBaseBranch, parseNameStatus, loadInstructions, matchLocalInstructions, isSkippedPath, pruneReports, buildContext };

if (require.main === module) main();
