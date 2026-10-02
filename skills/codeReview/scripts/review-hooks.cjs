#!/usr/bin/env node
'use strict';

// codeReview's hooks around reading and resuming a run, one `--event` per caller:
//
//   --event=read     PreToolUse on Read (hooks/hooks.json). Reading a run's context JSON or
//                    one of its bundles ties this session to the run - what --event=compact
//                    reads. Before the cross-file bundle is read, its live section is rewritten
//                    from the parts on disk: every finding the file parts report and the items
//                    the unverified block answers (check-part.cjs reportedState). Under
//                    --dedup-items (`target.dedupItems`) a file bundle is read from a copy in
//                    which an item another bundle showed since the last compaction is a
//                    reference to that bundle, line for line.
//   --event=draft    PostToolUse on Write|Edit (hooks/hooks.json). A refused part's draft,
//                    once an Edit fixed it, is checked again and moved into place
//                    (check-part.cjs promoteDraft), and the drafts waiting behind it follow.
//   --event=compact  SessionStart with the matcher "compact", called through the plugin's
//                    shared scripts/compact-hook.cjs (hooks/hooks.json: a skill's frontmatter
//                    cannot register it). A compaction brings back only the head of
//                    SKILL.md; this names where the run stands, the Reads that resume it and the
//                    lines of SKILL.md to read again.
//
// The session's state is one small JSON file per session id: the run's context and, under
// --dedup-items, the bundle that showed each item first. A hook never breaks a session: every
// failure ends in exit 0 and no output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skillDir = path.resolve(__dirname, '..').replace(/\\/g, '/');
const reContextName = /^\.review-context-[a-z]+\.json$/;
const reBundleName = /\.bundle\.md$/i;
const reDraftName = /^(.+\.part\d+)\.draft\.md$/i;
const reSessionId = /^[0-9A-Za-z_-]{1,128}$/;
// An item of a bundle's plan: `- general#3: <text>`.
const reItemLine = /^- ([a-z0-9][a-z0-9-]*#\d+): /;
// A compacted session gets exactly the first 20,000 characters of SKILL.md back (measured on
// 10 of 10 compactions, 2026-09-28/29) - and none at all once the session was resumed in a new
// process. The lines to read again start a little before that cut.
const reattachedChars = 19000;
// SKILL.md: what follows this line is read once per run, never again after a compaction.
const oneTimeMarker = '<!-- one-time:start -->';
const stateMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const lockWaitMs = 2000;
const lockStaleMs = 10 * 1000;

function parseArgs(argv) {
  const args = { event: null };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m && m[1] === 'event' && ['read', 'draft', 'compact'].includes(m[2])) args.event = m[2];
    else throw new Error(`Nieznany argument: ${arg} (oczekiwano --event=read|draft|compact).`);
  }
  if (!args.event) throw new Error('Brak --event=read|draft|compact.');
  return args;
}

const pathKey = (p) => {
  const resolved = path.resolve(String(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const samePath = (a, b) => pathKey(a) === pathKey(b);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function stateDir(env = process.env) {
  return env.DOH_REVIEW_STATE_DIR || path.join(os.tmpdir(), 'doh-codereview', 'sessions');
}

function statePath(sessionId, env) {
  return reSessionId.test(String(sessionId || '')) ? path.join(stateDir(env), `${sessionId}.json`) : null;
}

function readState(file) {
  const state = readJson(file);
  return state && typeof state.contextPath === 'string' ? { contextPath: state.contextPath, shown: state.shown || {} } : null;
}

// The Reads of one batch run their hooks at once: every change of the state holds the lock.
function withLock(file, change) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + lockWaitMs;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST' || Date.now() > deadline) throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > lockStaleMs) fs.rmSync(lock, { force: true });
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return change();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

// Ties the session to a run; the items shown so far count only within the same run.
function record(stateFile, contextPath, change = (shown) => shown) {
  return withLock(stateFile, () => {
    const current = readState(stateFile);
    const shown = current && samePath(current.contextPath, contextPath) ? current.shown : {};
    const result = change(shown);
    writeAtomic(stateFile, JSON.stringify({ contextPath, shown }));
    return result;
  });
}

function sweep(dir, now = Date.now()) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > stateMaxAgeMs) fs.rmSync(file, { force: true });
    } catch {}
  }
}

// The run a bundle belongs to: the session's own run first, then the one check-part.cjs finds
// from the report next to the work folder.
function runOfWork(workDir, state) {
  if (state) {
    const context = readJson(state.contextPath);
    const target = context && (context.targets || []).find((t) => t && t.workDir && samePath(t.workDir, workDir));
    if (target) return { context, target, contextPath: state.contextPath };
  }
  const stem = path.basename(workDir).replace(/\.work$/i, '');
  if (stem === path.basename(workDir)) return null;
  return require('./check-part.cjs').findContextFor(path.join(path.dirname(workDir), `${stem}.part01.md`));
}

function partReader(target) {
  const bundle = require('./review-bundle.cjs');
  const n = (target.files || []).length;
  return (k) => {
    try {
      return fs.readFileSync(bundle.partPathOf(target.reportPath, k, n), 'utf8');
    } catch {
      return null;
    }
  };
}

// The cross bundle's live section, from the parts as they are now.
function refreshCross(found, file) {
  const cp = require('./check-part.cjs');
  const bundle = require('./review-bundle.cjs');
  const text = fs.readFileSync(file, 'utf8');
  const next = bundle.withReported(text, cp.reportedState(found.target, partReader(found.target), cp.readFacts(found.target)));
  if (next !== null && next !== text) writeAtomic(file, next);
}

// An item line of the plan whose text another bundle already showed becomes a reference to it;
// `shown` gains the items this bundle shows first. Line for line: every line number stays.
function dedupItems(text, name, shown) {
  let inPlan = false;
  let replaced = 0;
  const lines = text.split('\n').map((line) => {
    if (line.startsWith('## ')) inPlan = line.trim() === '## Plan';
    const m = inPlan ? line.match(reItemLine) : null;
    if (!m) return line;
    const first = shown[m[1]];
    if (!first) shown[m[1]] = name;
    if (!first || first === name) return line;
    replaced++;
    return `- ${m[1]}: treść jak w paczce ${first}, przeczytanej wcześniej`;
  });
  return { text: lines.join('\n'), replaced };
}

function onRead(input, env = process.env) {
  const args = (input && input.tool_input) || {};
  const file = args.file_path;
  if (typeof file !== 'string') return null;
  const name = path.basename(file);
  const isContext = reContextName.test(name);
  if (!isContext && !reBundleName.test(name)) return null;
  const stateFile = statePath(input.session_id, env);
  if (isContext) {
    const context = readJson(file);
    if (!stateFile || !context || !Array.isArray(context.targets) || context.targets.length === 0) return null;
    record(stateFile, path.resolve(file));
    sweep(path.dirname(stateFile));
    return null;
  }
  const workDir = path.dirname(path.resolve(file));
  const found = runOfWork(workDir, stateFile ? readState(stateFile) : null);
  if (!found) return null;
  const bundle = require('./review-bundle.cjs');
  if (name === bundle.crossBundleName) {
    refreshCross(found, file);
    if (stateFile) record(stateFile, found.contextPath);
    return null;
  }
  if (!stateFile) return null;
  if (!found.target.dedupItems) {
    record(stateFile, found.contextPath);
    return null;
  }
  const text = fs.readFileSync(file, 'utf8');
  const result = record(stateFile, found.contextPath, (shown) => dedupItems(text, name, shown));
  if (result.replaced === 0) return null;
  const copy = path.join(workDir, name.replace(reBundleName, '.bundle.dedup.md'));
  writeAtomic(copy, result.text);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `codeReview --dedup-items: ${result.replaced} pozycji z treścią z wcześniejszej paczki`,
      updatedInput: { ...args, file_path: copy.replace(/\\/g, '/') },
    },
  };
}

function note(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function onDraft(input) {
  const tool = input && input.tool_name;
  const file = input && input.tool_input && input.tool_input.file_path;
  if ((tool !== 'Write' && tool !== 'Edit') || typeof file !== 'string') return null;
  const m = path.basename(file).match(reDraftName);
  if (!m) return null;
  const draft = path.resolve(file);
  // Gone already: the hook of an earlier Edit moved it in with its own draft.
  if (!fs.existsSync(draft)) return null;
  const cp = require('./check-part.cjs');
  // The draft lies in the target's work folder, `<stem>.work`, next to its parts.
  const found = cp.findContextFor(path.join(path.dirname(path.dirname(draft)), `${m[1]}.md`));
  if (!found || !samePath(cp.draftPathOf(found.target, `${m[1]}.md`), draft)) return null;
  const options = { timing: false, root: input.cwd };
  const result = cp.promoteDraft(found, draft, options);
  if (result.state === 'refused') {
    let text = '';
    try {
      text = fs.readFileSync(draft, 'utf8');
    } catch {}
    return note('PostToolUse', cp.formatProblems(
      `Szkic ${path.basename(draft)} nadal nie przechodzi kontroli formatu (codeReview SKILL.md, Step 3 point 4) - popraw kolejnym Edit tylko wskazane miejsca, hook sprawdzi go znowu:`,
      cp.withDraftLines(result.problems, text),
    ));
  }
  const lines = [result.state === 'stale'
    ? `check-part: ${result.partName} zapisano po tym szkicu - szkic był nieaktualny i został usunięty.`
    : `check-part: ${result.partName} zapisana ze szkicu.`];
  for (const later of cp.promoteLater(found, options)) {
    if (later.state === 'promoted') lines.push(`check-part: ${later.partName} zapisana ze szkicu.`);
  }
  return note('PostToolUse', lines.join('\n'));
}

// The lines of SKILL.md a compaction took away: from a little before the cut to the one-time part.
function skillLines(file = `${skillDir}/SKILL.md`) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const front = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const cut = (front ? front[0].length : 0) + reattachedChars;
  const end = text.indexOf(oneTimeMarker);
  if (end === -1 || end <= cut) return null;
  const lineAt = (offset) => text.slice(0, offset).split('\n').length;
  const from = lineAt(cut);
  return { path: file, from, limit: lineAt(end) - from };
}

// references/walk-card.md next to SKILL.md: the per-file procedure in a few lines.
function walkCard(skillFile = `${skillDir}/SKILL.md`) {
  try {
    const text = fs.readFileSync(path.join(path.dirname(skillFile), 'references', 'walk-card.md'), 'utf8').trim();
    return text ? text.split(/\r?\n/) : null;
  } catch {
    return null;
  }
}

function listDrafts(workDir) {
  try {
    return fs.readdirSync(workDir).filter((name) => /\.part\d+\.draft\.md$/i.test(name)).sort().map((name) => `${workDir}/${name}`);
  } catch {
    return [];
  }
}

const labelOf = (target) => target.branch || path.basename(target.reportPath);

// Where the run stands after a compaction: the first target whose work folder the assembly has
// not removed yet, its next part and the Reads that walk it. Null once every target is assembled.
function position(context, contextPath, skillFile) {
  const bundle = require('./review-bundle.cjs');
  const targets = (context.targets || []).filter((t) => t && t.workDir && t.reportPath);
  const open = targets.filter((t) => fs.existsSync(t.workDir));
  if (open.length === 0) return null;
  const target = open[0];
  const files = target.files || [];
  const n = files.length;
  const partOf = (k) => bundle.partPathOf(target.reportPath, k, n);
  const exists = (k) => fs.existsSync(partOf(k));
  const out = [
    'codeReview: sesję skompaktowano w trakcie recenzji. Kontynuuj od miejsca niżej; zapisanych części nie pisz od nowa.',
    `- kontekst: ${contextPath}`,
    `- cel ${targets.indexOf(target) + 1}/${targets.length}: ${labelOf(target)}, raport ${target.reportPath}`,
  ];
  const rulebook = [context.rulebookNotesPath, context.claudeMd].filter(Boolean);
  if (rulebook.length) out.push(`- rulebook (Step 2) wraca tylko z pliku: przeczytaj (Read) ${rulebook.join(' i ')}`);
  const missing = [];
  for (let k = 1; k <= n; k++) if (!exists(k)) missing.push(k);
  const assembly = `- następne: złożenie - przeczytaj (Read) ${skillDir}/references/assembly.md i uruchom \`target.commands.assemble\`:`;
  if (n === 0 && !exists(1)) {
    out.push(`- następne: ${partOf(1)} z jedyną linią \`Nie wykryto zmian do analizy.\`, potem złożenie (${skillDir}/references/assembly.md)`);
  } else if (missing.length > 0) {
    const k = missing[0];
    const range = (target.batches || []).find(([first, last]) => k >= first && k <= last);
    const walk = files.slice(k - 1, range ? range[1] : k);
    out.push(`- zapisane części plików: ${n - missing.length}/${n}; następny plik ${k}/${n}: ${files[k - 1].path}, część ${partOf(k)}`);
    if (walk.length > 1) out.push(`- partia: pliki ${k}-${k + walk.length - 1}, ich części razem w jednej odpowiedzi`);
    out.push('- przeczytaj (Read) w jednej odpowiedzi:', ...bundle.readsOf(walk).map((p) => `  - ${p}`));
  } else if (n > 0 && !exists(n + 1)) {
    out.push(`- części plików zapisane (${n}/${n}); następne: przejście międzyplikowe, część ${partOf(n + 1)}`);
    out.push('- przeczytaj (Read) w jednej odpowiedzi:', `  - ${target.crossBundlePath}`, `  - ${skillDir}/references/cross-file.md`);
  } else {
    out.push(assembly, `  ${(target.commands && target.commands.assemble) || '(brak w kontekście - złóż według assembly.md)'}`);
  }
  const drafts = listDrafts(target.workDir);
  if (drafts.length) out.push(`- szkice odrzuconych części czekają na Edit (hook przenosi szkic po Edit): ${drafts.join(', ')}`);
  if (open.length > 1) out.push(`- potem cele: ${open.slice(1).map(labelOf).join(', ')}`);
  const skill = skillLines(skillFile);
  if (skill) {
    out.push(`- SKILL.md wrócił po kompaktowaniu tylko do około linii ${skill.from} (po wznowieniu sesji - wcale): przeczytaj (Read) ${skill.path} z offset ${skill.from} i limit ${skill.limit} - reszta kroku 3 i format raportu.`);
  }
  // The walk itself, whatever the harness re-attached: after a resumed session it re-attaches nothing.
  const card = walkCard(skillFile);
  if (card) out.push('', ...card);
  return out;
}

function onCompact(input, env = process.env) {
  const stateFile = statePath(input && input.session_id, env);
  const state = stateFile ? readState(stateFile) : null;
  if (!state) return null;
  const context = readJson(state.contextPath);
  const lines = context ? position(context, state.contextPath) : null;
  if (!lines) {
    fs.rmSync(stateFile, { force: true });
    return null;
  }
  // The item texts shown before the compaction are gone from the conversation.
  withLock(stateFile, () => writeAtomic(stateFile, JSON.stringify({ contextPath: state.contextPath, shown: {} })));
  return note('SessionStart', lines.join('\n'));
}

const handlers = { read: onRead, draft: onDraft, compact: onCompact };

function readStdin(deadlineMs) {
  return new Promise((resolve) => {
    let text = '';
    const timer = setTimeout(() => resolve(text), deadlineMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(text); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(text); });
  });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exit(1);
  }
  let out = null;
  try {
    out = handlers[args.event](JSON.parse(await readStdin(3000)));
  } catch {
    out = null;
  }
  if (!out) process.exit(0);
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

module.exports = {
  parseArgs, stateDir, statePath, readState, dedupItems, skillLines, walkCard, position, onRead, onDraft, onCompact,
  reattachedChars, oneTimeMarker,
};

if (require.main === module) main();
