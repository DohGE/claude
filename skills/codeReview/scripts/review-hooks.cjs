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
//                    (check-part.cjs promoteDraft), and the drafts waiting behind it follow -
//                    as they do after a part written whole lands.
//   --event=search   PreToolUse on Grep|Glob (hooks/hooks.json). While a review of a branch
//                    runs, a search of the project's working tree is a search of another
//                    revision: it goes to the same path in the walker's target.snapshotDir, the
//                    reviewed commit as plain files, and a path that revision lacks is refused.
//   --event=compact  SessionStart with the matcher "compact", called through the plugin's
//                    shared scripts/compact-hook.cjs (hooks/hooks.json: a skill's frontmatter
//                    cannot register it). A compaction brings back only the head of
//                    SKILL.md; this names where the run stands, the Reads that resume it and the
//                    lines of SKILL.md to read again.
//   --event=subagent SubagentStart and SubagentStop (hooks/hooks.json). A sub-agent begins with an
//                    empty conversation and the one that started it holds none of what the
//                    sub-agent read, so no item text counts as shown to whoever reads next:
//                    the next file bundle is whole, never a reference to a bundle the reader
//                    has not got.
//
// The session's state is one small JSON file per session id: the run's context and, under
// --dedup-items, the bundle that showed each item first. A hook never breaks a session: every
// failure ends in exit 0 and no output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skillDir = path.resolve(__dirname, '..').replace(/\\/g, '/');
const { carriedNote } = require('./stack-carry.cjs');
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
    if (m && m[1] === 'event' && ['read', 'draft', 'compact', 'subagent', 'search'].includes(m[2])) args.event = m[2];
    else throw new Error(`Nieznany argument: ${arg} (oczekiwano --event=read|draft|compact|subagent|search).`);
  }
  if (!args.event) throw new Error('Brak --event=read|draft|compact|subagent|search.');
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

// `agents`: the work folder of the target each agent last read a bundle of ('' for reads without
// an agent id) - which snapshot a search of that agent goes to.
function readState(file) {
  const state = readJson(file);
  return state && typeof state.contextPath === 'string' ? { contextPath: state.contextPath, shown: state.shown || {}, agents: state.agents || {} } : null;
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

// Ties the session to a run; the items shown so far count only within the same run. `tie`
// (`{ agent, workDir }`) records the target an agent walks.
function record(stateFile, contextPath, change = (shown) => shown, tie = null) {
  return withLock(stateFile, () => {
    const current = readState(stateFile);
    const same = current && samePath(current.contextPath, contextPath);
    const shown = same ? current.shown : {};
    const agents = same ? current.agents : {};
    if (tie && tie.workDir) agents[tie.agent || ''] = tie.workDir;
    const result = change(shown);
    writeAtomic(stateFile, JSON.stringify({ contextPath, shown, agents }));
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
// `shown` gains the items this bundle shows first. So does a rule line of `## Zapis części` that
// another bundle showed word for word (`§<line>` in `shown`): 9% of what the walkers of a
// 188-file run read was that section, the same lines in every bundle (2026-10-30). Line for line:
// every line number stays.
function dedupItems(text, name, shown) {
  let section = '';
  let replaced = 0;
  const lines = text.split('\n').map((line) => {
    if (line.startsWith('## ')) section = line.trim();
    if (section === '## Zapis części' && line.startsWith('- ')) {
      const key = `§${line.trim()}`;
      const first = shown[key];
      if (!first) shown[key] = name;
      if (!first || first === name) return line;
      replaced++;
      return `- zasada zapisu jak w paczce ${first}`;
    }
    const m = section === '## Plan' ? line.match(reItemLine) : null;
    // A verdict carried from an earlier part of the stack shows no item text to refer to.
    if (!m || line.includes(carriedNote)) return line;
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
  const agent = input.agent_id ? String(input.agent_id) : '';
  const tie = { agent, workDir: found.target.workDir };
  if (name === bundle.crossBundleName) {
    refreshCross(found, file);
    if (stateFile) record(stateFile, found.contextPath, undefined, tie);
    return null;
  }
  // A later part of a stack takes over the earlier part's verdicts on the items its diff cannot
  // have changed (stack-carry.cjs): their text leaves the bundle, and the part check writes them in.
  let text = null;
  let carried = 0;
  const files = found.target.files || [];
  const number = files.findIndex((f) => f && f.carry && f.bundlePath && samePath(f.bundlePath, file)) + 1;
  if (number > 0) {
    try {
      text = fs.readFileSync(file, 'utf8');
      const result = require('./stack-carry.cjs').carryForRead({ context: found.context, target: found.target, file: files[number - 1], number, text });
      if (result && result.count > 0) {
        writeAtomic(result.recordPath, JSON.stringify(result.record));
        text = result.text;
        carried = result.count;
      }
    } catch {}
  }
  const reasons = carried ? [`codeReview: ${carried} werdyktów z poprzedniej części stosu`] : [];
  // Walkers side by side (`target.parallel`) share the session id. A Read carrying the agent's
  // own id dedups against what that agent read (`@<id>` in the state); one without it could be
  // any walker's, and a reference to a bundle another walker read is an item never shown.
  if (!stateFile || !found.target.dedupItems || (!agent && (found.target.parallel || 1) > 1)) {
    if (stateFile) record(stateFile, found.contextPath, undefined, tie);
  } else {
    if (text === null) text = fs.readFileSync(file, 'utf8');
    const source = text;
    const result = record(stateFile, found.contextPath, (shown) => {
      if (!agent) return dedupItems(source, name, shown);
      if (!shown[`@${agent}`]) shown[`@${agent}`] = {};
      return dedupItems(source, name, shown[`@${agent}`]);
    }, tie);
    if (result.replaced > 0) {
      text = result.text;
      reasons.push(`codeReview --dedup-items: ${result.replaced} pozycji z treścią z wcześniejszej paczki`);
    }
  }
  if (reasons.length === 0) return null;
  const copy = path.join(workDir, name.replace(reBundleName, '.bundle.dedup.md'));
  writeAtomic(copy, text);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reasons.join('; '),
      updatedInput: { ...args, file_path: copy.replace(/\\/g, '/') },
    },
  };
}

function note(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

// A part that landed whole: the drafts its absence held back (`najpierw brakujące wcześniejsze
// części`) are checked again and moved in - the walker was told they land by themselves.
function onPartLanded(file, input) {
  const cp = require('./check-part.cjs');
  const found = cp.findContextFor(path.resolve(file));
  if (!found || !fs.existsSync(path.resolve(file))) return null;
  const landed = cp.promoteLater(found, { timing: false, root: input.cwd }).filter((result) => result.state === 'promoted');
  return landed.length ? note('PostToolUse', landed.map((result) => `check-part: ${result.partName} zapisana ze szkicu.`).join('\n')) : null;
}

function onDraft(input) {
  const tool = input && input.tool_name;
  const file = input && input.tool_input && input.tool_input.file_path;
  if ((tool !== 'Write' && tool !== 'Edit') || typeof file !== 'string') return null;
  if (/^.+\.part\d+\.md$/i.test(path.basename(file))) return onPartLanded(file, input);
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
      `Szkic ${path.basename(draft)} nadal nie przechodzi kontroli formatu (codeReview references/walk.md, Step 3 point 4) - popraw kolejnym Edit tylko wskazane miejsca, hook sprawdzi go znowu:`,
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
  // Every part written - the cross-file one too - is a target that waits for the assembly of all
  // of them (`commands.assembleAll`): the next one still to walk comes first.
  const complete = (t) => {
    const count = (t.files || []).length;
    const last = count === 0 ? 1 : count + 1;
    for (let k = 1; k <= last; k++) if (!fs.existsSync(bundle.partPathOf(t.reportPath, k, count))) return false;
    return true;
  };
  const target = open.find((t) => !complete(t)) || open[0];
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
  const all = context.commands && context.commands.assembleAll;
  const assembly = all
    ? `- następne: złożenie wszystkich celów - przeczytaj (Read) ${skillDir}/references/assembly.md i uruchom \`commands.assembleAll\` (na końcu drukuje podsumowanie Step 5):`
    : `- następne: złożenie - przeczytaj (Read) ${skillDir}/references/assembly.md i uruchom \`target.commands.assemble\`:`;
  if (n === 0 && !exists(1)) {
    out.push(`- następne: ${partOf(1)} z jedyną linią \`Nie wykryto zmian do analizy.\`, potem złożenie (${skillDir}/references/assembly.md)`);
  } else if (missing.length > 0) {
    const k = missing[0];
    const windows = target.windows || [];
    const window = windows.find((w) => k >= w.files[0] && k <= w.files[1]);
    out.push(`- zapisane części plików: ${n - missing.length}/${n}; następny plik ${k}/${n}: ${files[k - 1].path}, część ${partOf(k)}`);
    if (window) {
      // Whoever sent the walkers is the conversation that was compacted: the walk is theirs, not its own.
      const model = window.model ? ` z \`model: ${window.model}\`` : '';
      const effort = window.effort ? ` i \`effort: ${window.effort}\`` : '';
      const lanes = (target.parallel || 1) > 1 ? `, do ${target.parallel} okien naraz` : '';
      const wait = window.lastPart
        ? ` i nie kończ tury: \`node "${skillDir}/scripts/wait-part.cjs" --path="<lastPart każdego wysłanego okna>"\` aż \`PART_READY\`, potem następne okno`
        : ` i czekaj na jedną linię \`${bundle.windowReplies.done} ${window.files[0]}-${window.files[1]}\``;
      out.push(`- workflow recenzji (\`workflow\` kontekstu, jeden dla wszystkich celów z oknami), jeśli go uruchomiłeś i nie przyszło jego powiadomienie, jeszcze działa: czekaj na nie, nie wysyłaj okien drugi raz.`);
      out.push(`- okno ${windows.indexOf(window) + 1}/${windows.length}: pliki ${window.files[0]}-${window.files[1]}; bez workflow wyślij \`doh:codereview-walker\`${model}${effort} z promptem \`Read ${window.brief} and follow it.\`${lanes} (części na dysku pomija)${wait}; bez Agent albo po odmowie przejdź plik ${k} sam według ${bundle.walkRulesPath}, tak:`);
    }
    const range = (target.batches || []).find(([first, last]) => k >= first && k <= last);
    const walk = files.slice(k - 1, range ? range[1] : k);
    if (walk.length > 1) out.push(`- partia: pliki ${k}-${k + walk.length - 1}, ich części razem w jednej odpowiedzi`);
    out.push('- przeczytaj (Read) w jednej odpowiedzi, także to, co czytałeś przed kompaktowaniem - tego tekstu nie ma już w rozmowie, a kilka Grep po pozycjach to kilka odpowiedzi:', ...bundle.readsOf(walk).map((p) => `  - ${p}`));
  } else if (n > 0 && !exists(n + 1)) {
    out.push(`- części plików zapisane (${n}/${n}); następne: przejście międzyplikowe, część ${partOf(n + 1)}`);
    if (target.crossBriefPath && !target.crossInline) {
      out.push(`- robi je świeży agent: wyślij \`doh:codereview-cross\` z promptem \`Read ${target.crossBriefPath} and follow it.\` i czekaj na \`${bundle.crossReplies.done}\` (\`wait-part.cjs --path="${partOf(n + 1)}"\`); bez Agent:`);
    } else if (target.crossInline) {
      out.push('- mały cel (`crossInline`): przejście robisz sam, w tej rozmowie:');
    }
    out.push('- przeczytaj (Read) w jednej odpowiedzi:', `  - ${bundle.pagedRead(target.crossBundlePath, target.crossPages)}`, `  - ${skillDir}/references/cross-file.md`);
  } else {
    out.push(assembly, `  ${all || (target.commands && target.commands.assemble) || '(brak w kontekście - złóż według assembly.md)'}`);
  }
  const drafts = listDrafts(target.workDir);
  if (drafts.length) out.push(`- szkice odrzuconych części czekają na Edit (hook przenosi szkic po Edit): ${drafts.join(', ')}`);
  const later = open.filter((t) => t !== target && !complete(t));
  if (later.length > 0) out.push(`- potem cele: ${later.map(labelOf).join(', ')}`);
  const skill = skillLines(skillFile);
  if (skill) {
    out.push(`- SKILL.md wrócił po kompaktowaniu tylko do około linii ${skill.from} (po wznowieniu sesji - wcale): przeczytaj (Read) ${skill.path} z offset ${skill.from} i limit ${skill.limit} - reszta prowadzenia recenzji.`);
  }
  if (missing.length > 0 || (n > 0 && !exists(n + 1))) {
    out.push(`- reguły przejścia pliku i format części (Step 3 i 4) są w ${bundle.walkRulesPath}: przeczytaj (Read), zanim sam przejdziesz plik albo zrobisz przejście międzyplikowe.`);
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
  forget(stateFile, state.contextPath);
  return note('SessionStart', lines.join('\n'));
}

// The item texts shown so far are not in the conversation of whoever reads next.
function forget(stateFile, contextPath) {
  withLock(stateFile, () => {
    const current = readState(stateFile);
    writeAtomic(stateFile, JSON.stringify({ contextPath, shown: {}, agents: current && samePath(current.contextPath, contextPath) ? current.agents : {} }));
  });
}

// A sub-agent's start or stop: what the session's reads without an agent id showed is reset, as
// before (they may have been the sub-agent's), and so is that agent's own map; the maps of the
// walkers still running stay.
function onSubagent(input, env = process.env) {
  const stateFile = statePath(input && input.session_id, env);
  const state = stateFile ? readState(stateFile) : null;
  if (!state) return null;
  const agent = input && input.agent_id ? `@${input.agent_id}` : null;
  const others = Object.fromEntries(Object.entries(state.shown).filter(([key]) => key.startsWith('@') && key !== agent));
  withLock(stateFile, () => writeAtomic(stateFile, JSON.stringify({ contextPath: state.contextPath, shown: others, agents: state.agents })));
  return null;
}

const inside = (p, dir) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Whether git tracks something at `rel` in the working tree's checkout: a path the reviewed revision
// lacks but the checkout tracks belongs to another revision; an untracked one (node_modules, a
// build folder) belongs to none, and is searched where it is.
function tracked(project, rel) {
  const r = require('node:child_process').spawnSync('git', ['-C', project, 'ls-files', '--', rel || '.'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0 && String(r.stdout || '').trim() !== '';
}

function deny(text) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } };
}

function allow(text, updatedInput) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: text, updatedInput } };
}

// A Glob's pattern - and a Grep's `glob` - that holds a `/` without opening with `**/` is read
// from the session's working directory, not from `path`: searched in any other folder it matches
// nothing. Every search this hook sends to a snapshot, and every one a walker points there itself,
// is such a search: all 45 Globs of that shape came back empty in a 250-file run, 15 were never
// asked again another way, and one verdict cited the empty result (2026-11-12).
const reGlobMagic = /[*?[\]{}]/;
const anchoredGlob = (pattern) => typeof pattern === 'string' && pattern.includes('/') && !pattern.startsWith('**/');

// A Glob in `dir`: the folders its pattern opens with move into `path` - the search walks only
// them - and what is left matches at any depth below. Null when the pattern works as it is, and
// when the revision has no such folder: there the Glob rightly finds nothing.
function unanchoredGlob(dir, pattern) {
  if (!anchoredGlob(pattern)) return null;
  const segments = pattern.split('/').filter((s) => s !== '' && s !== '.');
  let k = 0;
  while (k < segments.length - 1 && !reGlobMagic.test(segments[k]) && segments[k] !== '..') k++;
  const base = path.join(dir, ...segments.slice(0, k));
  if (k > 0) {
    try {
      if (!fs.statSync(base).isDirectory()) return null;
    } catch {
      return null;
    }
  }
  const rest = segments.slice(k).join('/');
  return { path: base.replace(/\\/g, '/'), pattern: anchoredGlob(rest) ? `**/${rest}` : rest };
}

// What a search's input changes to in `dir`, or null: a Grep keeps its `path` and its filter
// matches at any depth below it.
function unanchoredSearch(tool, args, dir) {
  if (tool === 'Glob') return unanchoredGlob(dir, args.pattern);
  const glob = typeof args.glob === 'string' ? args.glob : '';
  const negated = glob.startsWith('!');
  const body = negated ? glob.slice(1) : glob;
  return anchoredGlob(body) ? { glob: `${negated ? '!' : ''}**/${body}` } : null;
}

// A Grep or Glob of the project while this session reviews a branch: the working tree is whatever
// is checked out - in a stacked review, the stack's last part - and not the revision under review.
// Of a 188-file run's lookups, 19 read the working tree or a branch name (2026-10-30). The search
// goes to the same path in the target's snapshot; the search of the run's own folder, of a path
// outside the project and of an untracked one stays as it is.
function onSearch(input, env = process.env) {
  const tool = input && input.tool_name;
  if (tool !== 'Grep' && tool !== 'Glob') return null;
  const stateFile = statePath(input.session_id, env);
  const state = stateFile ? readState(stateFile) : null;
  if (!state) return null;
  const context = readJson(state.contextPath);
  const project = context && typeof context.project === 'string' ? path.resolve(context.project) : null;
  if (!project) return null;
  // A staged or folder review reads the working tree itself (its snapshotDir is the project).
  const live = (context.targets || []).filter((t) => t && t.workDir && t.snapshotDir && !samePath(t.snapshotDir, project) && fs.existsSync(t.workDir));
  if (live.length === 0) return null;
  const args = (input && input.tool_input) || {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : project;
  const asked = typeof args.path === 'string' && args.path.trim() ? path.resolve(cwd, args.path) : path.resolve(cwd);
  if (!inside(asked, project)) return null;
  // The run's own folders - a snapshot, a work folder - are searched where they are; only the
  // pattern is read from the searched folder.
  const inPlace = () => {
    const fixed = unanchoredSearch(tool, args, asked);
    return fixed ? allow(`codeReview: wzorzec ${tool} liczony od przeszukiwanego folderu, nie od katalogu sesji`, { ...args, ...fixed }) : null;
  };
  if (inside(asked, path.join(project, '.claude'))) return inPlace();
  const tied = state.agents[input.agent_id ? String(input.agent_id) : ''];
  const target = live.find((t) => tied && samePath(t.workDir, tied)) || (live.length === 1 ? live[0] : null);
  if (!target) return null;
  if (inside(asked, target.snapshotDir)) return inPlace();
  const rel = path.relative(project, asked).replace(/\\/g, '/');
  const mapped = path.join(target.snapshotDir, rel);
  const revision = target.revision ? target.revision.slice(0, 9) : target.branch;
  if (!fs.existsSync(mapped)) {
    if (!tracked(project, rel)) return null;
    return deny(`codeReview: ${rel || '.'} nie istnieje w recenzowanej rewizji (${revision}) - drzewo robocze ma inną. Szukaj w target.snapshotDir (${target.snapshotDir.replace(/\\/g, '/')}): ścieżka po nim to ścieżka w repozytorium.`);
  }
  return allow(
    `codeReview: ${tool} w recenzowanej rewizji (${revision}): ${rel || '.'} w snapshotDir, nie w drzewie roboczym`,
    { ...args, path: mapped.replace(/\\/g, '/'), ...(unanchoredSearch(tool, args, mapped) || {}) },
  );
}

const handlers = { read: onRead, draft: onDraft, compact: onCompact, subagent: onSubagent, search: onSearch };

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
  onSubagent, onSearch, reattachedChars, oneTimeMarker,
};

if (require.main === module) main();
