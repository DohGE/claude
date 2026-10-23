'use strict';

// implementNewFeature's part of the plugin's SessionStart(compact) hook (scripts/compact-hook.cjs).
//
// A compaction re-attaches only the first 20,000 characters of SKILL.md: the cut falls inside
// "Talking to a running agent", and the rest of the head, every step, the failure protocol and
// the final summary go with it. A
// session resumed in a new process gets none of it back. The orchestrator's own notes are a
// summary by then too - but the run's state is not: the server persists it in
// `<SESSION>/pipeline-state.json` on every update. This reads it and names, for the task the
// session orchestrates - every task has an orchestrator of its own, and the state records which
// session it is - where it stands, the E2E slot and the task's waiter, the sections of SKILL.md
// to read again, and the loop card (references/loop-card.md).
//
// The run is found without any state of the hook's own. The session's transcript names its
// session directory - every render, spawn and launcher command carries `<SESSION>` - and the
// run is live while its `server.json` names a living process: the server writes it on start
// and removes it on shutdown. A session that only mentions an old run, or another project's,
// finds no live server under that name and gets nothing.
//
// A hook never breaks a session: every failure ends in no output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skillDir = path.resolve(__dirname, '..');
// A compacted session gets exactly the first 20,000 characters of SKILL.md back (codeReview's
// measurement, 10 of 10 compactions on 2026-09-28/29); the same harness re-attaches this skill.
const reattachedChars = 20000;
const oneTimeMarker = '<!-- one-time:start -->';
// `.claude/doh/<stamp>` or `.implementNewFeature/<stamp>` (SKILL.md Setup point 2), with the
// separators a JSONL transcript writes: `/`, or `\` escaped as `\\`.
const reSessionStamp = /(?:\.claude(?:\\\\|\/)+doh|\.implementNewFeature)(?:\\\\|\/)+(\d{8}-\d{6})/g;
const reCwd = /"cwd":"((?:[^"\\]|\\.)*)"/g;
// wait-answer.cjs: a lock older than its holder's window plus a minute is stale; 50 minutes
// for a lock that does not say.
const waiterWindowMs = 50 * 60 * 1000;
const stepNames = ['Requirements', 'Feature Refinement', 'Mockups', 'Implementation', 'Validation & E2E', 'Code Review', 'Mockoon Mocks', 'Story Description'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const pathKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

// The live runs the transcript names: a stamp it mentions, under the project of any working
// directory the session had (the Bash tool's `cd` moves it into worktrees) or under the skill.
function findRun(input, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(input.transcript_path, 'utf8');
  } catch {
    return null;
  }
  const stamps = new Set([...text.matchAll(reSessionStamp)].map((m) => m[1]));
  if (stamps.size === 0) return null;
  const cwds = new Set([input.cwd]);
  for (const m of text.matchAll(reCwd)) {
    try {
      cwds.add(JSON.parse(`"${m[1]}"`));
    } catch {}
  }
  const roots = new Map();
  for (const cwd of cwds) {
    if (typeof cwd === 'string' && cwd) roots.set(pathKey(path.join(cwd, '.claude', 'doh')), path.join(cwd, '.claude', 'doh'));
  }
  const ownRoot = env.DOH_IND_SESSIONS_DIR || path.join(skillDir, '.implementNewFeature');
  roots.set(pathKey(ownRoot), ownRoot);
  const runs = [];
  for (const root of roots.values()) {
    for (const stamp of stamps) {
      const dir = path.join(root, stamp);
      const server = readJson(path.join(dir, 'server.json'));
      if (server && Number.isInteger(server.pid) && isAlive(server.pid)) runs.push({ dir, stamp, port: server.port, pid: server.pid });
    }
  }
  // One server holds the fixed port at a time; were there two, the newest run is the one going on.
  runs.sort((a, b) => b.stamp.localeCompare(a.stamp));
  return runs[0] || null;
}

// SKILL.md's `## ` sections after the head a compaction keeps: [{ title, line, limit }].
function skillSections(skillFile = path.join(skillDir, 'SKILL.md')) {
  let text;
  try {
    text = fs.readFileSync(skillFile, 'utf8');
  } catch {
    return null;
  }
  const front = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const cutLine = text.slice(0, (front ? front[0].length : 0) + reattachedChars).split('\n').length;
  const lines = text.split(/\r?\n/);
  const heads = [];
  lines.forEach((line, i) => {
    if (line.startsWith('## ')) heads.push({ title: line.slice(3).trim(), line: i + 1 });
    else if (line.startsWith(oneTimeMarker)) heads.push({ title: null, line: i + 1 });
  });
  const sections = [];
  heads.forEach((head, i) => {
    if (!head.title) return;
    const end = i + 1 < heads.length ? heads[i + 1].line : lines.length + 1;
    if (end > cutLine) sections.push({ title: head.title, line: head.line, limit: end - head.line });
  });
  const firstStep = heads.find((head) => head.title && /^Step 1\b/.test(head.title));
  return { path: skillFile.replace(/\\/g, '/'), cutLine, headLimit: firstStep ? firstStep.line - 1 : cutLine, sections };
}

// A task's waiter, by the lock wait-answer.cjs keeps for its port and task.
function waiterOf(port, taskId, env) {
  const lock = readJson(path.join(env.DOH_WAITER_LOCK_DIR || os.tmpdir(), `doh-answer-waiter-${port}-${taskId}.json`));
  const windowMs = lock && Number.isFinite(lock.windowMs) ? lock.windowMs : waiterWindowMs;
  return lock && Number.isInteger(lock.pid) && isAlive(lock.pid) && Date.now() - lock.startedAt < windowMs + 60000 ? lock.pid : null;
}

// The tasks whose orchestrator this session is: its one task. A run from before the server
// recorded orchestrators names none, and its one session drives every task.
function ownTasks(tasks, sessionId) {
  const own = tasks.filter((t) => t.orchestrator && t.orchestrator.session && t.orchestrator.session === sessionId);
  return own.length ? own : tasks;
}

const stepOf = (task, id) => (task.steps || []).find((s) => s.id === id) || null;

function taskLine(task) {
  const n = Number(task.activeStep) || 1;
  const step = stepOf(task, n);
  let line = `- ${task.id} on ${task.branch ? `\`${task.branch}\`` : 'no branch yet'}: step ${n} ${stepNames[n - 1] || ''} - ${step ? step.status : 'unknown'}`;
  if (step && step.currentOperation) line += `, "${step.currentOperation}"`;
  if (task.question) line += '; a question is open';
  const failed = (task.steps || []).filter((s) => s.status === 'failed' && s.id !== n).map((s) => s.id);
  if (failed.length) line += `; failed: step ${failed.join(', ')}`;
  if (task.summary) line += '; final summary shown';
  return line;
}

// SKILL.md "E2E slot", as the server keeps it - every task's, not only this session's. A run from
// before the server kept it is read off the steps, as server.cjs's e2eFromSteps reads it.
function e2eLine(tasks, e2e) {
  let holder = e2e ? e2e.holder : null;
  let queue = e2e && Array.isArray(e2e.queue) ? e2e.queue : [];
  if (!e2e) {
    const held = tasks.find((t) => ['in_progress', 'failed'].includes((stepOf(t, 5) || {}).status));
    const queuedAt = (t) => (((stepOf(t, 5) || {}).log || []).filter((e) => e.text === 'Queued for the E2E slot').at(-1) || {}).time || '';
    holder = held ? held.id : null;
    queue = tasks.filter((t) => {
      const s = stepOf(t, 5);
      return s && s.status === 'waiting' && s.currentOperation === 'Waiting for the E2E slot';
    }).sort((a, b) => queuedAt(a).localeCompare(queuedAt(b))).map((t) => t.id);
  }
  if (!holder && !queue.length) return '- E2E slot: free';
  return `- E2E slot: ${holder ? `held by ${holder}` : 'free'}${queue.length ? `; queued: ${queue.join(', ')} (the server hands it on in this order)` : ''}`;
}

// The sections a task's next event needs: every section of the head the cut reached - it now
// runs through "Talking to a running agent", so the Stop and delete protocols and Server helpers
// come back only this way - the step each task stands at, and the protocols its state calls for.
function sectionsFor(tasks, skill) {
  const wanted = (title) => skill.sections.find((s) => s.title.startsWith(title));
  const picked = skill.sections.filter((s) => s.line <= skill.headLimit);
  const steps = new Set();
  for (const task of tasks) {
    const n = Number(task.activeStep) || 1;
    steps.add(n);
    // The form stays editable until implementation starts, so a revision can arrive at any
    // step of the route before it: 2, 3 and 8 (the story's id, though its tile sits before 4).
    if (task.step1Submitted && [1, 2, 3, 8].includes(n)) picked.push(wanted('Revising step 1'));
    if (task.summary) steps.add(7);
  }
  for (const n of [...steps].sort()) picked.push(wanted(`Step ${n} `));
  if (tasks.some((t) => (t.steps || []).some((s) => s.status === 'failed'))) picked.push(wanted('Failure protocol'));
  if (tasks.some((t) => t.summary || (stepOf(t, 6) || {}).status === 'completed')) picked.push(wanted('Final summary'));
  const seen = new Set();
  return picked.filter((s) => s && !seen.has(s.line) && seen.add(s.line));
}

function loopCard(skillFile = path.join(skillDir, 'SKILL.md')) {
  try {
    const text = fs.readFileSync(path.join(path.dirname(skillFile), 'references', 'loop-card.md'), 'utf8').trim();
    return text ? text.split(/\r?\n/) : null;
  } catch {
    return null;
  }
}

function compactLines(input, env = process.env, skillFile = path.join(skillDir, 'SKILL.md')) {
  if (!input || typeof input.transcript_path !== 'string') return null;
  const run = findRun(input, env);
  if (!run) return null;
  const state = readJson(path.join(run.dir, 'pipeline-state.json'));
  const all = state && Array.isArray(state.tasks) ? state.tasks : [];
  const tasks = ownTasks(all, input.session_id);
  const dir = run.dir.replace(/\\/g, '/');
  const out = [
    'implementNewFeature: this session was compacted while it drives a run. The run\'s state lives in the server, not in your memory - continue from it.',
    `- session: ${dir}, server on port ${run.port} (pid ${run.pid}); state: ${dir}/pipeline-state.json, read through \`/api/state\``,
  ];
  if (tasks.length < all.length) {
    out.push(`- you orchestrate ${tasks.map((t) => t.id).join(', ')} only: every other task has an orchestrator of its own`);
  }
  if (tasks.length) out.push(...tasks.map(taskLine), e2eLine(all, state.e2e));
  else out.push('- no task state on disk yet: the run is still at Setup or step 1');
  for (const task of tasks.length ? tasks : [{ id: 't1' }]) {
    const waiter = waiterOf(run.port, task.id, env);
    out.push(waiter
      ? `- waiter for ${task.id}: listening (pid ${waiter}) - do not start a second one`
      : `- waiter for ${task.id}: none is listening - start one (loop card point 1) before you end this turn`);
  }
  out.push('- agentIds are not in the server state: only the summary above carries them');
  const skill = skillSections(skillFile);
  if (skill) {
    const reads = sectionsFor(tasks, skill).map((s) => `offset ${s.line} limit ${s.limit} (${s.title})`);
    out.push(`- SKILL.md came back only up to about line ${skill.cutLine} (after a resumed session: not at all). Before acting on a task, Read ${skill.path} at: ${reads.join('; ')}; after a resumed session also offset 1 limit ${skill.headLimit} (the head).`);
  }
  const card = loopCard(skillFile);
  if (card) out.push('', ...card);
  return out;
}

function onCompact(input, env = process.env) {
  const lines = compactLines(input, env);
  return lines ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } } : null;
}

module.exports = { findRun, skillSections, sectionsFor, taskLine, e2eLine, ownTasks, loopCard, compactLines, onCompact, reattachedChars };
