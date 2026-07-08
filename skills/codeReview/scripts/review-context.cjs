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
  const result = { appliesTo: [] };
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

function loadInstructions(instructionsDir) {
  const warnings = [];
  const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []);
  const globalDir = path.join(instructionsDir, 'global');
  const localDir = path.join(instructionsDir, 'local');
  const globals = list(globalDir).map((f) => path.join(globalDir, f));
  const locals = list(localDir).map((f) => {
    const file = path.join(localDir, f);
    const { appliesTo } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    if (appliesTo.length === 0) {
      warnings.push(`Local instruction has no applies-to patterns and will never match: ${file}`);
    }
    return { file, appliesTo };
  });
  return { globals, locals, warnings };
}

function matchLocalInstructions(locals, filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return locals
    .filter((l) => l.appliesTo.some((p) => globToRegExp(p).test(normalized)))
    .map((l) => l.file);
}

function buildContext(options) {
  const project = path.resolve(options.project || process.cwd());
  const skillDir = options.skillDir || SKILL_DIR;
  const now = options.now || new Date();
  const result = { targets: [], errors: [] };

  if (tryGit(project, ['rev-parse', '--git-dir']) === null) {
    result.errors.push(`Not a git repository: ${project}`);
    return result;
  }
  if (tryGit(project, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) {
    result.errors.push('Repository has no commits yet.');
    return result;
  }

  const instructions = loadInstructions(path.join(skillDir, 'instructions'));
  const ts = formatTimestamp(now);
  const reportsDir = path.join(skillDir, 'reports');
  const claudeMdPath = path.join(project, 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudeMdPath) ? claudeMdPath : null;
  const baseWarnings = [...instructions.warnings];
  if (instructions.globals.length === 0 && instructions.locals.length === 0) {
    baseWarnings.push('instructions/global and instructions/local are empty - review uses only the project CLAUDE.md and the universal checklist points.');
  }

  const gitc = (args) => `git -C ${q(project)} ${args}`;
  const makeFiles = (rawFiles, diffFor, showFor) => rawFiles.map((f) => ({
    path: f.path,
    status: f.status,
    localInstructions: matchLocalInstructions(instructions.locals, f.path),
    diffCommand: diffFor(f),
    showCommand: f.status === 'D' ? null : showFor(f),
  }));

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
    const rawFiles = parseNameStatus(tryGit(project, ['diff', '--name-status', `${baseRef}...${branchRef}`]) || '');
    result.targets.push({
      kind: 'branch',
      branch: branchName,
      baseBranch: baseRef,
      reportPath: path.join(reportsDir, `${sanitizeBranchName(branchName)}-${ts.date}-${ts.time}.md`),
      files: makeFiles(
        rawFiles,
        (f) => gitc(`diff ${baseRef}...${branchRef} -- ${q(f.path)}`),
        (f) => gitc(`show ${q(`${branchRef}:${f.path}`)}`),
      ),
      globalInstructions: instructions.globals,
      claudeMd,
      warnings: [...baseWarnings],
    });
  };

  if (options.mode === 'staged') {
    const branchName = tryGit(project, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
    const rawFiles = parseNameStatus(tryGit(project, ['diff', '--cached', '--name-status']) || '');
    result.targets.push({
      kind: 'staged',
      branch: branchName,
      baseBranch: null,
      reportPath: path.join(reportsDir, `${sanitizeBranchName(branchName)}-staged-${ts.date}-${ts.time}.md`),
      files: makeFiles(
        rawFiles,
        (f) => gitc(`diff --cached -- ${q(f.path)}`),
        (f) => gitc(`show ${q(`:${f.path}`)}`),
      ),
      globalInstructions: instructions.globals,
      claudeMd,
      warnings: [...baseWarnings],
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

  if (result.targets.length > 0) fs.mkdirSync(reportsDir, { recursive: true });
  return result;
}

function main() {
  let context;
  try {
    context = buildContext(parseArgs(process.argv.slice(2)));
  } catch (err) {
    context = { targets: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(JSON.stringify(context, null, 2) + '\n');
  process.exit(context.targets.length > 0 ? 0 : 1);
}

module.exports = { parseArgs, globToRegExp, parseFrontmatter, sanitizeBranchName, formatTimestamp, git, tryGit, resolveRef, detectBaseBranch, parseNameStatus, loadInstructions, matchLocalInstructions, buildContext };

if (require.main === module) main();
