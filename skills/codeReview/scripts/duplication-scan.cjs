'use strict';

// Copy/paste detection for the revision a review covers. jscpd scans the WHOLE
// reviewed tree - a copy of an untouched file is found only when that file is
// scanned too - or, in a repository of several projects, the projects the review
// reaches (review-scope.cjs), and the clone pairs are then narrowed to the ones the diff wrote:
// a pair survives when one side is at least half made of changed lines and the
// block exists at least three times. That side is the anchor the reviewer reports
// on, the other copies the sources it repeats.
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
// Duplication is a finding from its third copy: two may still diverge, three are a pattern.
const minCopies = 3;
// A block the codebase repeats more often than this is boilerplate - a TestBed setup, a store
// skeleton, a CLI-generated file - not a copy the diff made. Measured on an Angular monorepo:
// counting every block a chain of overlapping clones reached put a median of 9 337 "copies"
// behind each of 50 candidates, 59 MB of review context and bundles no Read could open.
const maxCopies = 12;
// What a candidate names: enough copies to open and see the pattern, the count of the rest.
// Every source is a line of the bundle a walker reads, and of the cross-file bundle after it.
const sourceLimit = 3;
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
// by two detectors or against two sources is opened by the reviewer once. The copies of
// a block are what it was paired with and what those were paired with - jscpd pairs each
// copy with one other, so two steps reach a clone repeated in a row or around one
// original, the pairs the diff did not touch included. Further than that, a chain of
// overlapping blocks walks into code that only shares a run of tokens with a neighbour of
// a neighbour, which is how one candidate used to name the whole repository. A candidate
// needs `minCopies` copies and at most `maxCopies` (more is boilerplate, counted in
// `stats.boilerplate`), and names up to `sourceLimit` of them; `copies` then says how
// many there are.
function pickCandidates(duplicates, files, stats = {}) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const pairs = (duplicates || []).map((clone) => {
    const [first, second] = [clone.firstFile, clone.secondFile].map((side) => {
      const p = String(side.name).replace(/\\/g, '/').replace(/^\.\//, '');
      return { path: p, start: side.start, end: side.end, share: changedShare(byPath.get(p), side.start, side.end) };
    });
    return { first, second, kind: clone.kind };
  });
  // Pair i's sides are numbered 2i and 2i + 1; each lands in the block that covers it.
  const blocks = mergeOverlapping(
    pairs.flatMap(({ first, second }, i) => [{ ...first, sides: [2 * i] }, { ...second, sides: [2 * i + 1] }]),
    (into, item) => into.sides.push(...item.sides),
  );
  const blockOf = [];
  blocks.forEach((block, b) => block.sides.forEach((side) => { blockOf[side] = b; }));
  const neighbours = blocks.map(() => new Set());
  pairs.forEach((_, i) => {
    const [a, b] = [blockOf[2 * i], blockOf[2 * i + 1]];
    if (a !== b) {
      neighbours[a].add(b);
      neighbours[b].add(a);
    }
  });
  // Two steps out from `own`, and no further than one copy past maxCopies: a block that
  // stands next to a hub of thousands is decided by then, and its walk stays short.
  const copiesOf = (own) => {
    const seen = new Set([own]);
    let frontier = [own];
    for (let depth = 0; depth < 2 && seen.size <= maxCopies; depth++) {
      const next = [];
      for (const b of frontier) {
        for (const n of neighbours[b]) {
          if (seen.size > maxCopies) break;
          if (!seen.has(n)) {
            seen.add(n);
            next.push(n);
          }
        }
      }
      frontier = next;
    }
    seen.delete(own);
    return [...seen];
  };
  const boilerplate = new Set();
  const anchors = [];
  pairs.forEach(({ first, second, kind }, i) => {
    // Both sides written (two copies the diff adds) is still one candidate - each
    // names the other - taken on the second side, which in one file is the later copy.
    const anchor = first.share > second.share ? first : second;
    if (anchor.share < minChangedShare) return;
    const own = blockOf[anchor === first ? 2 * i : 2 * i + 1];
    const others = copiesOf(own);
    if (others.length + 1 < minCopies) return;
    if (others.length + 1 > maxCopies) {
      boilerplate.add(own);
      return;
    }
    anchors.push({
      path: anchor.path,
      start: anchor.start,
      end: anchor.end,
      sources: others.map((b) => ({ path: blocks[b].path, start: blocks[b].start, end: blocks[b].end })),
      kinds: [kind],
    });
  });
  if (boilerplate.size > 0) stats.boilerplate = boilerplate.size;
  return mergeOverlapping(anchors, (into, item) => {
    into.sources.push(...item.sources);
    into.kinds.push(...item.kinds);
  }).map((c) => {
    const sources = mergeOverlapping(c.sources).map((s) => `${s.path}:${s.start}-${s.end}`);
    return {
      path: c.path,
      lines: `${c.start}-${c.end}`,
      sources: sources.slice(0, sourceLimit),
      ...(sources.length > sourceLimit ? { copies: sources.length + 1 } : {}),
      kinds: [...new Set(c.kinds)].sort(),
    };
  });
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
// `scope` (review-scope.cjs) narrows it to the projects the review reaches; null is the whole tree.
// `root` puts the tree elsewhere - where the review searches it after the scan (scanTargets).
function exportTree({ project, source, workDir, isSkipped = () => false, scope = null, root = path.join(workDir, 'tree') }) {
  fs.mkdirSync(root, { recursive: true });
  const keep = (p) => p !== '' && !isSkipped(p) && !isSnapshot(p) && (!scope || scope.has(p));
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
    // A tree kept inside the project sits a few folders deeper than the repository's own files:
    // past 260 characters git for Windows writes nothing without core.longpaths.
    git(project, ['-c', 'core.longpaths=true', 'checkout-index', '-f', '-z', '--stdin', `--prefix=${root.replace(/\\/g, '/')}/`], {
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

// One jscpd process over `root`, its config and report in `workDir`: what to start, and where.
function jscpdCall(root, workDir, invocation) {
  // An explicit config: without one jscpd reads `.jscpd.json` or package.json#jscpd
  // from the scanned tree, and the project's threshold, reporters or ignores would
  // decide what this scan reports. The pattern travels in it rather than on the
  // command line, which npx hands on through cmd.exe on Windows.
  const config = path.join(workDir, 'jscpd.json');
  fs.writeFileSync(config, JSON.stringify({ ignorePattern: [importStatement] }));
  const output = path.join(workDir, 'report');
  const args = [...invocation.args, '.', '--config', config, '--output', output, ...jscpdFlags];
  const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
  return {
    command: invocation.shell ? [invocation.command, ...args.map(quote)].join(' ') : invocation.command,
    args: invocation.shell ? [] : args,
    options: { cwd: root, shell: invocation.shell, windowsHide: true },
    report: path.join(output, 'jscpd-report.json'),
  };
}

// The report a run left, or why there is none.
function readReport(report, res) {
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

function runJscpd(root, workDir, invocation = jscpdInvocation()) {
  const call = jscpdCall(root, workDir, invocation);
  const res = spawnSync(call.command, call.args, { ...call.options, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return readReport(call.report, res);
}

// How many scans run at once: jscpd is one thread, and a review of four branches scanned them
// one after another - 4 x 36 s of a 213 s context build (2026-10-27).
function defaultScanParallel(count, cpus = os.cpus().length) {
  return Math.max(1, Math.min(count, 4, Math.floor(cpus / 2) || 1));
}

// Several scans side by side: `entries` are `{ root, workDir }`, the result one `{ report }` or
// `{ error }` per entry. The review builds its context synchronously, so the processes run in a
// child of this script (`--run-many`) that waits for all of them; one entry runs here directly.
function runJscpdMany(entries, { parallel = defaultScanParallel(entries.length), invocation = jscpdInvocation() } = {}) {
  const attempt = (fn) => {
    try {
      return { report: fn() };
    } catch (err) {
      return { error: String((err && err.message) || err).split('\n')[0].trim() };
    }
  };
  if (entries.length === 0) return [];
  if (entries.length === 1 || parallel <= 1) return entries.map((entry) => attempt(() => runJscpd(entry.root, entry.workDir, invocation)));
  const calls = entries.map((entry) => jscpdCall(entry.root, entry.workDir, invocation));
  const res = spawnSync(process.execPath, [__filename, '--run-many'], {
    input: JSON.stringify({ calls, parallel }),
    encoding: 'utf8',
    timeout: timeoutMs * Math.ceil(entries.length / parallel) + 30000,
    windowsHide: true,
  });
  let outcomes = [];
  try {
    outcomes = JSON.parse(res.stdout || '[]');
  } catch {}
  return calls.map((call, i) => attempt(() => readReport(call.report, outcomes[i] || { error: res.error, stderr: res.stderr, status: res.status })));
}

// The child of runJscpdMany: every call, `parallel` at a time; prints each one's exit as JSON.
function runCalls({ calls, parallel }) {
  const { spawn } = require('node:child_process');
  const outcomes = new Array(calls.length);
  let next = 0;
  const lane = () => new Promise((done) => {
    const step = () => {
      if (next >= calls.length) return done();
      const k = next++;
      const call = calls[k];
      let output = '';
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcomes[k] = outcome;
        step();
      };
      const child = spawn(call.command, call.args, call.options);
      const timer = setTimeout(() => {
        child.kill();
        finish({ error: { code: 'ETIMEDOUT' }, stderr: output });
      }, timeoutMs);
      child.stdout && child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-2000); });
      child.stderr && child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-2000); });
      child.on('error', (err) => finish({ error: { message: err.message }, stderr: output }));
      child.on('close', (status) => finish({ status, stderr: output }));
    };
    step();
  });
  return Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, calls.length)) }, lane)).then(() => outcomes);
}

// One target's scan. Never throws: a scan that cannot run (no npx, offline on the
// first run, a ref that does not resolve) comes back as `{ error }` and the review
// goes on without it.
function scanDuplicates({ project, source, files, isSkipped, scope = null, run = runJscpd }) {
  if (files.length === 0) return { candidates: [], omitted: 0 };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-cpd-'));
  try {
    const { root, count } = exportTree({ project, source, workDir, isSkipped, scope });
    const stats = {};
    const found = count === 0 ? [] : pickCandidates(run(root, workDir).duplicates, files, stats);
    return {
      candidates: found.slice(0, candidateLimit),
      omitted: Math.max(0, found.length - candidateLimit),
      ...(stats.boilerplate ? { boilerplate: stats.boilerplate } : {}),
    };
  } catch (err) {
    return { error: String((err && err.message) || err).split('\n')[0].trim() };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
}

// Every target of a run: each exported (`treeRoot` keeps a target's tree there, for the review's
// searches), then all scanned in one call (runJscpdMany), side by side. Never throws: a target
// that cannot be exported or scanned comes back as `{ error }`, with its `tree` when it was kept.
function scanTargets(jobs, { run = runJscpdMany, parallel } = {}) {
  const results = jobs.map(() => null);
  const pending = [];
  jobs.forEach((job, i) => {
    if (job.files.length === 0) {
      results[i] = { candidates: [], omitted: 0 };
      return;
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doh-cpd-'));
    const kept = job.treeRoot ? { tree: job.treeRoot } : {};
    try {
      if (job.treeRoot) fs.rmSync(job.treeRoot, { recursive: true, force: true });
      const { root, count } = exportTree({ project: job.project, source: job.source, workDir, isSkipped: job.isSkipped, scope: job.scope || null, ...(job.treeRoot ? { root: job.treeRoot } : {}) });
      if (count === 0) results[i] = { candidates: [], omitted: 0, ...kept };
      else pending.push({ i, root, workDir, kept });
    } catch (err) {
      results[i] = { error: String((err && err.message) || err).split('\n')[0].trim(), ...kept };
    }
    if (results[i]) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  let reports = [];
  try {
    reports = run(pending.map(({ root, workDir }) => ({ root, workDir })), parallel === undefined ? {} : { parallel });
  } catch (err) {
    reports = pending.map(() => ({ error: String((err && err.message) || err).split('\n')[0].trim() }));
  }
  pending.forEach(({ i, workDir, kept }, k) => {
    const outcome = reports[k] || { error: 'no report' };
    if (outcome.error) results[i] = { error: outcome.error, ...kept };
    else {
      const stats = {};
      const found = pickCandidates(outcome.report.duplicates, jobs[i].files, stats);
      results[i] = {
        candidates: found.slice(0, candidateLimit),
        omitted: Math.max(0, found.length - candidateLimit),
        ...(stats.boilerplate ? { boilerplate: stats.boilerplate } : {}),
        ...kept,
      };
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  });
  return results;
}

module.exports = {
  candidateLimit, maxCopies, sourceLimit, changedShare, pickCandidates, exportTree, jscpdInvocation, runJscpd, scanDuplicates,
  runJscpdMany, scanTargets, defaultScanParallel,
};

if (require.main === module && process.argv[2] === '--run-many') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    runCalls(JSON.parse(input)).then((outcomes) => process.stdout.write(JSON.stringify(outcomes)));
  });
}
