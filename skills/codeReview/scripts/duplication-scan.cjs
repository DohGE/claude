'use strict';

// Copy/paste detection for the revision a review covers. jscpd scans the WHOLE
// reviewed tree - a copy of an untouched file is found only when that file is
// scanned too - and the clone pairs are then narrowed to the ones the diff wrote:
// a pair survives when one side is at least half made of changed lines. That side
// is the anchor the reviewer reports on, the other one the source it repeats.
//
// jscpd's own baseline mode (`--baseline-from-ref`) was measured for this and
// rejected: editing one literal inside a clone that already existed changes the
// clone's fingerprint, so a one-line fix reads as two new clones.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pinned: the report shape and the clone kinds are read as this version writes them.
const jscpdPackage = 'jscpd@5.3.1';
// Token-level detection: `--ignore-identifiers` also catches a copy whose names were
// changed, `--max-gap-lines` one with a line inserted or dropped. jscpd's AST mode
// (`--similarity`) was measured on an Angular monorepo and left out: 212 of its 235
// pairs were the CLI-generated spec skeleton matched against every other spec.
// `--min-tokens 30` instead of jscpd's 50, measured on 15 commits of the same
// monorepo: 24 candidates became 67, and 50 missed e.g. a nine-line mapping copied
// within one component.
const jscpdFlags = ['--reporters', 'json', '--ignore-identifiers', '--max-gap-lines', '2', '--min-tokens', '30', '--no-gitignore', '--no-tips', '--silent'];
// With identifiers ignored any two import lists are one clone, so import statements
// are skipped: from a line starting with `import` to its `from '...'`, across the
// indented or `}` lines of a multi-line one. A side-effect import has no `from` and
// is left alone rather than let the match run on into the code below it.
const importStatement = String.raw`(?m)^import\s(?:[^;\n]|\n[\s}])*?\sfrom\s*['"][^'"\n]*['"];?`;
const minChangedShare = 0.5;
// Per target: a diff that vendors a library would otherwise put hundreds of entries
// into the context the orchestrator reads.
const candidateLimit = 50;
// The first run downloads jscpd; after that the npx cache answers.
const timeoutMs = 180000;

// Snapshots repeat the template they render by design, and the code-quality
// instruction, which owns duplication, does not apply to them.
const isSnapshot = (p) => /\.snap$/i.test(p);

// The part of lines start-end of a reviewed file that the diff wrote. `changedLines`
// is null for an added file (every line is new) and '' when the diff wrote no line
// (a pure rename); a file outside the review wrote none either.
function changedShare(file, start, end) {
  if (!file || file.changedLines === '') return 0;
  if (file.changedLines === null) return 1;
  let written = 0;
  for (const range of file.changedLines.split(',')) {
    const [from, to = from] = range.trim().split('-').map(Number);
    const overlap = Math.min(to, end) - Math.max(from, start) + 1;
    if (overlap > 0) written += overlap;
  }
  return written / (end - start + 1);
}

const byPathAndStart = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start);

// Ranges of one file that overlap become one; `absorb` carries over whatever else
// the swallowed item holds.
function mergeOverlapping(items, absorb = () => {}) {
  const merged = [];
  for (const item of [...items].sort(byPathAndStart)) {
    const last = merged[merged.length - 1];
    if (last && last.path === item.path && item.start <= last.end) {
      last.end = Math.max(last.end, item.end);
      absorb(last, item);
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

// jscpd clone pairs -> the candidates the diff wrote, one per block: a block matched
// by two detectors or against two sources is opened by the reviewer once.
function pickCandidates(duplicates, files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const anchors = [];
  for (const clone of duplicates || []) {
    const [first, second] = [clone.firstFile, clone.secondFile].map((side) => {
      const p = String(side.name).replace(/\\/g, '/').replace(/^\.\//, '');
      return { path: p, start: side.start, end: side.end, share: changedShare(byPath.get(p), side.start, side.end) };
    });
    // Both sides written (two copies the diff adds) is still one candidate - each
    // names the other - taken on the second side, which in one file is the later copy.
    const anchor = first.share > second.share ? first : second;
    if (anchor.share < minChangedShare) continue;
    const source = anchor === first ? second : first;
    anchors.push({
      path: anchor.path,
      start: anchor.start,
      end: anchor.end,
      sources: [{ path: source.path, start: source.start, end: source.end }],
      kinds: [clone.kind],
    });
  }
  return mergeOverlapping(anchors, (into, item) => {
    into.sources.push(...item.sources);
    into.kinds.push(...item.kinds);
  }).map((c) => ({
    path: c.path,
    lines: `${c.start}-${c.end}`,
    sources: mergeOverlapping(c.sources).map((s) => `${s.path}:${s.start}-${s.end}`),
    kinds: [...new Set(c.kinds)].sort(),
  }));
}

function git(project, args, { env, input } = {}) {
  return execFileSync('git', ['-C', project, ...args], {
    encoding: 'utf8',
    env,
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// The reviewed revision as plain files under `<workDir>/tree`, minus the paths the
// review skips and the snapshots. A branch is read into an index of its own outside
// the repository, so the checkout, the real index and every ref stay as they were;
// a staged review reads the real index, which checkout-index writes back only when
// asked to (`-u`); a folder review copies the working tree as git sees it - tracked
// and untracked files, not the ignored ones.
function exportTree({ project, source, workDir, isSkipped = () => false }) {
  const root = path.join(workDir, 'tree');
  fs.mkdirSync(root, { recursive: true });
  const keep = (p) => p !== '' && !isSkipped(p) && !isSnapshot(p);
  if (source.workTree) {
    const listed = new Set(git(project, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(keep));
    let count = 0;
    for (const rel of listed) {
      const from = path.join(project, rel);
      // A tracked file deleted from disk is still listed; a symlinked folder is not a file.
      if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.copyFileSync(from, path.join(root, rel));
      count++;
    }
    return { root, count };
  }
  // LFS pointers stay pointers: the objects behind them are binaries jscpd skips,
  // and fetching them would turn a scan into a download.
  const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', ...(source.ref ? { GIT_INDEX_FILE: path.join(workDir, 'index') } : {}) };
  if (source.ref) git(project, ['read-tree', source.ref], { env });
  const listed = [...new Set(git(project, ['ls-files', '-z'], { env }).split('\0').filter(keep))];
  if (listed.length > 0) {
    git(project, ['checkout-index', '-f', '-z', '--stdin', `--prefix=${root.replace(/\\/g, '/')}/`], {
      env,
      input: listed.map((p) => `${p}\0`).join(''),
    });
  }
  return { root, count: listed.length };
}

// npx runs the pinned jscpd without installing anything into the project. It is
// started as a script of the running node when npm sits next to it (the Windows
// installer, nvm, the official tarballs): node cannot spawn `npx.cmd` without a
// shell, and a shell is one more layer to quote for.
function jscpdInvocation({ execPath = process.execPath, exists = fs.existsSync } = {}) {
  const npxArgs = ['--yes', '--prefer-offline', `--package=${jscpdPackage}`, '--', 'jscpd'];
  const nodeDir = path.dirname(execPath);
  const cli = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].find((p) => exists(p));
  return cli
    ? { command: execPath, args: [cli, ...npxArgs], shell: false }
    : { command: 'npx', args: npxArgs, shell: true };
}

function runJscpd(root, workDir, invocation = jscpdInvocation()) {
  // An explicit config: without one jscpd reads `.jscpd.json` or package.json#jscpd
  // from the scanned tree, and the project's threshold, reporters or ignores would
  // decide what this scan reports. The pattern travels in it rather than on the
  // command line, which npx hands on through cmd.exe on Windows.
  const config = path.join(workDir, 'jscpd.json');
  fs.writeFileSync(config, JSON.stringify({ ignorePattern: [importStatement] }));
  const output = path.join(workDir, 'report');
  const args = [...invocation.args, '.', '--config', config, '--output', output, ...jscpdFlags];
  const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
  const res = spawnSync(invocation.shell ? [invocation.command, ...args.map(quote)].join(' ') : invocation.command,
    invocation.shell ? [] : args, {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      shell: invocation.shell,
      windowsHide: true,
    });
  const report = path.join(output, 'jscpd-report.json');
  if (!fs.existsSync(report)) {
    const why = res.error && res.error.code === 'ETIMEDOUT'
      ? `timed out after ${timeoutMs / 1000} s`
      : (res.error && res.error.message)
        || `${res.stderr || ''}${res.stdout || ''}`.split('\n').map((l) => l.trim()).find(Boolean)
        || `exit code ${res.status}`;
    throw new Error(`jscpd wrote no report (${why})`);
  }
  return JSON.parse(fs.readFileSync(report, 'utf8'));
}

// One target's scan. Never throws: a scan that cannot run (no npx, offline on the
// first run, a ref that does not resolve) comes back as `{ error }` and the review
// goes on without it.
function scanDuplicates({ project, source, files, isSkipped, run = runJscpd }) {
  if (files.length === 0) return { candidates: [], omitted: 0 };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-cpd-'));
  try {
    const { root, count } = exportTree({ project, source, workDir, isSkipped });
    const found = count === 0 ? [] : pickCandidates(run(root, workDir).duplicates, files);
    return { candidates: found.slice(0, candidateLimit), omitted: Math.max(0, found.length - candidateLimit) };
  } catch (err) {
    return { error: String((err && err.message) || err).split('\n')[0].trim() };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
}

module.exports = { candidateLimit, changedShare, pickCandidates, exportTree, jscpdInvocation, runJscpd, scanDuplicates };
