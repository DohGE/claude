'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hooks = require('./pipeline-hooks.cjs');
const { taskState } = require('./server.cjs');

const skillFile = path.join(__dirname, '..', 'SKILL.md');
const slash = (p) => p.replace(/\\/g, '/');
const noteOf = (out) => out && out.hookSpecificOutput.additionalContext;
const stepFile = (name) => `${slash(path.join(__dirname, '..'))}/references/steps/${name}`;

// The line of SKILL.md's `## <title…>` heading and the length of its section.
function sectionOf(title) {
  const lines = fs.readFileSync(skillFile, 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`## ${title}`));
  const next = lines.findIndex((l, i) => i > at && (l.startsWith('## ') || l.startsWith('<!-- one-time:start -->')));
  return `offset ${at + 1} limit ${next - at}`;
}

function task(id, active, steps = {}, extra = {}) {
  const t = taskState(id);
  t.activeStep = active;
  for (const [n, fields] of Object.entries(steps)) Object.assign(t.steps[n - 1], fields);
  return Object.assign(t, extra);
}

// A project whose run lives in `.claude/doh/<stamp>`, and a transcript that names it the way a
// JSONL line does - Windows separators escaped - from a worktree the session `cd`-ed into.
function fixture(t, { tasks = null, e2e = undefined, serverPid = process.pid, waiters = {}, mention = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const session = path.join(project, '.claude', 'doh', '20261001-120000');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, 'server.json'), JSON.stringify({ port: 9999, pid: serverPid }));
  if (tasks) fs.writeFileSync(path.join(session, 'pipeline-state.json'), JSON.stringify({ tasks, nextTaskId: tasks.length + 1, e2e }));
  const locks = path.join(root, 'locks');
  fs.mkdirSync(locks);
  for (const [taskId, pid] of Object.entries(waiters)) {
    fs.writeFileSync(path.join(locks, `doh-answer-waiter-9999-${taskId}.json`), JSON.stringify({ pid, startedAt: Date.now(), windowMs: 3000000 }));
  }
  const worktree = path.join(project, 'worktree');
  const lines = [{ type: 'user', cwd: project, message: { content: 'go' } }];
  if (mention) {
    const out = path.join(session, 'tasks', 't1', 'prompts', 'impl.md');
    lines.push({ type: 'assistant', cwd: worktree, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `node render-agent-prompt.cjs --out="${out}"` } }] } });
  }
  const transcript = path.join(root, 's1.jsonl');
  fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n'));
  return {
    session,
    env: { DOH_WAITER_LOCK_DIR: locks, DOH_IND_SESSIONS_DIR: path.join(root, 'own') },
    input: { session_id: 's1', transcript_path: transcript, cwd: worktree, source: 'compact' },
  };
}

test('compact: names the run, where each task stands and the sections to read again', (t) => {
  // A run from before the server recorded orchestrators: one session for all.
  const f = fixture(t, {
    waiters: { t1: process.pid },
    tasks: [
      task('t1', 4, { 4: { status: 'in_progress', currentOperation: 'Writing tests' } }, { branch: 'feature/a' }),
      task('t2', 5, { 5: { status: 'in_progress' } }),
      task('t3', 5, { 5: { status: 'waiting', currentOperation: 'Waiting for the backend' } }, { question: { id: 'q1' } }),
    ],
  });
  const note = noteOf(hooks.onCompact(f.input, f.env));
  assert.ok(note, 'a session that drives a live run gets a note');
  assert.ok(note.includes(`- session: ${slash(f.session)}, server on port 9999 (pid ${process.pid})`), note);
  assert.ok(note.includes('- t1 on `feature/a`: step 4 Implementation - in_progress, "Writing tests"'), note);
  assert.ok(note.includes('- t2 on no branch yet: step 5 Validation & E2E - in_progress'), note);
  assert.ok(note.includes('- t3 on no branch yet: step 5 Validation & E2E - waiting, "Waiting for the backend"; a question is open'), note);
  assert.ok(!note.includes('E2E slot'), 'every task validates on its own: there is no slot to report');
  assert.ok(note.includes(`- waiter for t1: listening (pid ${process.pid}) - do not start a second one`), note);
  assert.ok(note.includes('- waiter for t2: none is listening'), note);
  assert.ok(!note.includes('- you orchestrate'), note);
  for (const title of ['Talking to a running agent', 'Stopping a step', 'Server helpers']) {
    assert.ok(note.includes(`${sectionOf(title)} (${title}`), `the cut reached ${title}: ${note}`);
  }
  assert.ok(note.includes(stepFile('4-implementation.md')), note);
  assert.ok(note.includes(stepFile('5-validation.md')), note);
  assert.ok(!/2-refinement|\(Failure protocol|final-summary/.test(note), 'only what the tasks\' state calls for');
  for (const name of ['4-implementation.md', '5-validation.md']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'references', 'steps', name)), name);
  assert.ok(note.includes(hooks.loopCard(skillFile)[0]), 'the loop card rides along');
});

test('compact: a failed step adds the failure protocol; a shown summary the final summary and step 7', (t) => {
  const f = fixture(t, {
    tasks: [
      task('t1', 6, { 5: { status: 'failed' }, 6: { status: 'completed' } }, { summary: { files: 3 } }),
    ],
  });
  const note = noteOf(hooks.onCompact(f.input, f.env));
  assert.ok(note.includes('failed: step 5; final summary shown'), note);
  assert.ok(note.includes(`${sectionOf('Failure protocol')} (Failure protocol`), note);
  for (const name of ['6-code-review.md', '7-mockoon.md', 'final-summary.md']) assert.ok(note.includes(stepFile(name)), `${name}: ${note}`);
  assert.ok(note.includes('- waiter for t1: none is listening - start one (loop card point 1) before you end this turn'), note);
});

test('compact: a session hears only of the task it orchestrates', (t) => {
  const own = (session) => ({ orchestrator: { session, claimedAt: '2026-10-01T12:00:00.000Z' } });
  const f = fixture(t, {
    waiters: { t1: process.pid, t2: process.pid },
    tasks: [
      task('t1', 4, { 4: { status: 'in_progress' } }, own('s0')),
      task('t2', 5, { 5: { status: 'waiting', currentOperation: 'Waiting for the backend' } }, own('s1')),
      task('t3', 5, { 5: { status: 'in_progress' } }, own('s3')),
    ],
  });
  const note = noteOf(hooks.onCompact(f.input, f.env));
  assert.ok(note.includes('- you orchestrate t2 only: every other task has an orchestrator of its own'), note);
  assert.ok(note.includes('- t2 on no branch yet: step 5 Validation & E2E - waiting, "Waiting for the backend"'), note);
  assert.ok(!/- t[13] on /.test(note), note);
  assert.ok(note.includes(`- waiter for t2: listening (pid ${process.pid})`), note);
  assert.ok(!note.includes('waiter for t1'), note);
  assert.ok(note.includes(stepFile('5-validation.md')) && !note.includes('4-implementation.md'), note);
});

test('compact: a task before implementation can still be revised; the story step has its own section', (t) => {
  const f = fixture(t, {
    tasks: [
      task('t1', 8, { 8: { status: 'in_progress', currentOperation: 'Writing the story' } }, { step1Submitted: true }),
      task('t2', 4, { 4: { status: 'in_progress' } }, { step1Submitted: true }),
    ],
  });
  const note = noteOf(hooks.onCompact(f.input, f.env));
  assert.ok(note.includes('- t1 on no branch yet: step 8 Story Description - in_progress, "Writing the story"'), note);
  for (const name of ['8-story.md', '1-requirements.md']) assert.ok(note.includes(stepFile(name)), `${name}: ${note}`);
  const alone = fixture(t, { tasks: [task('t2', 4, { 4: { status: 'in_progress' } }, { step1Submitted: true })] });
  assert.ok(!noteOf(hooks.onCompact(alone.input, alone.env)).includes('1-requirements.md'), 'implementation closed the form');
});

test('compact: a run with no task state yet still names the run and its sections', (t) => {
  const f = fixture(t);
  const note = noteOf(hooks.onCompact(f.input, f.env));
  assert.ok(note.includes('- no task state on disk yet'), note);
  assert.ok(note.includes(`${sectionOf('Server helpers')} (Server helpers`), note);
});

test('compact: no note without a live server, or for a session whose transcript never named the run', (t) => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const stopped = fixture(t, { serverPid: dead, tasks: [task('t1', 4)] });
  assert.strictEqual(hooks.onCompact(stopped.input, stopped.env), null, 'a shut-down run is over');
  const other = fixture(t, { mention: false, tasks: [task('t1', 4)] });
  assert.strictEqual(hooks.onCompact(other.input, other.env), null, 'another session of the same project');
  const live = fixture(t, { tasks: [task('t1', 4)] });
  assert.strictEqual(hooks.onCompact({ ...live.input, transcript_path: path.join(path.dirname(live.input.transcript_path), 'gone.jsonl') }, live.env), null);
  assert.strictEqual(hooks.onCompact({ session_id: 's1' }, live.env), null);
});

test('skillSections: only what the compaction cut, each section up to the next heading', () => {
  const skill = hooks.skillSections(skillFile);
  const titles = skill.sections.map((s) => s.title);
  assert.ok(titles.some((title) => title.startsWith('Talking to a running agent')), 'it straddles the cut');
  assert.ok(!titles.some((title) => title.startsWith('Spawning a sub-agent')), 'that one stays in the head');
  for (const s of skill.sections) assert.ok(s.line + s.limit > skill.cutLine, `${s.title} runs past the cut`);
  const failure = skill.sections.find((s) => s.title.startsWith('Failure protocol'));
  const lines = fs.readFileSync(skillFile, 'utf8').split(/\r?\n/);
  assert.ok(lines[failure.line - 1 + failure.limit].startsWith('<!-- one-time:start -->'), 'the failure protocol ends at the one-time part');
  assert.ok(lines[skill.headLimit].startsWith('## Steps'), 'the head runs up to the steps index');
  assert.strictEqual(hooks.skillSections(path.join(__dirname, 'no-such', 'SKILL.md')), null);
});

test('loop card: short enough to ride in every compaction, and the plugin\'s compaction hook asks this part', () => {
  const card = hooks.loopCard(skillFile).join('\n');
  assert.ok(card.length <= 3000, `${card.length} chars`);
  for (const term of ['wait-answer.cjs', '--task T', 'run_in_background', 'WAITER_RUNNING', 'ORCHESTRATOR_RUNNING', 'task-info.cjs', '"taskId"', 'SendMessage']) {
    assert.ok(card.includes(term), term);
  }
  const shared = require('../../../scripts/compact-hook.cjs');
  assert.ok(shared.parts.includes(path.join(__dirname, 'pipeline-hooks.cjs')));
});

test('compact: the final review is a step file of its own, and the summary follows the route\'s last step', (t) => {
  const done = task('t1', 9, { 5: { status: 'completed' }, 6: { status: 'completed' }, 9: { status: 'completed' } });
  const f = fixture(t, { tasks: [done] });
  const note = noteOf(hooks.onCompact(f.input, f.env));
  assert.ok(note.includes(stepFile('9-final-code-review.md')) && note.includes(stepFile('final-summary.md')), note);
  assert.ok(note.includes('step 9 Final Code Review - completed'), note);
  // A task with the final review switched off ends at validation.
  const off = task('t1', 5, { 5: { status: 'completed' }, 9: { enabled: false } });
  const g = fixture(t, { tasks: [off] });
  assert.ok(noteOf(hooks.onCompact(g.input, g.env)).includes(stepFile('final-summary.md')));
  const running = task('t1', 5, { 5: { status: 'in_progress' } });
  const h = fixture(t, { tasks: [running] });
  assert.ok(!noteOf(hooks.onCompact(h.input, h.env)).includes('final-summary'), 'validation still running');
});

test('resume: a server that died with the session is started again, a live one is only described', (t) => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const f = fixture(t, { serverPid: dead, tasks: [task('t1', 5, { 5: { status: 'in_progress' } })] });
  const started = [];
  const restart = (run) => {
    started.push(run);
    fs.writeFileSync(path.join(run.dir, 'server.json'), JSON.stringify({ port: 9999, pid: process.pid }));
    return { ok: true, port: 9999 };
  };
  const note = noteOf(hooks.onResume(f.input, f.env, restart));
  assert.strictEqual(started.length, 1);
  assert.strictEqual(slash(started[0].dir), slash(f.session));
  assert.ok(note.includes('started again on port 9999'), note);
  assert.ok(note.includes('- t1 on no branch yet: step 5 Validation & E2E - in_progress'), note);
  const live = fixture(t, { tasks: [task('t1', 4)] });
  assert.ok(noteOf(hooks.onResume(live.input, live.env, () => assert.fail('a live server is never restarted'))).includes('was resumed'));
  const finished = fixture(t, { serverPid: dead, tasks: [task('t1', 9, {}, { summary: { finalStatus: 'Completed' } })] });
  assert.strictEqual(hooks.onResume(finished.input, finished.env, () => assert.fail('a finished run stays down')), null);
  const failed = fixture(t, { serverPid: dead, tasks: [task('t1', 5)] });
  assert.ok(noteOf(hooks.onResume(failed.input, failed.env, () => ({ ok: false, error: 'port 9999 is already in use' }))).includes('could not be started again (port 9999 is already in use)'));
});

test('stop: a large orchestrator context earns one /compact hint per 100k of growth', (t) => {
  const f = fixture(t, { tasks: [task('t1', 5)] });
  const usage = (tokens) => fs.appendFileSync(f.input.transcript_path, `\n${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } })}`);
  usage(120000);
  assert.strictEqual(hooks.onStop(f.input, f.env), null, 'below the threshold');
  usage(300000);
  const hint = hooks.onStop(f.input, f.env);
  assert.ok(hint && /about 300k tokens.*\/compact/.test(hint.systemMessage), JSON.stringify(hint));
  usage(350000);
  assert.strictEqual(hooks.onStop(f.input, f.env), null, 'said once per step of growth');
  usage(420000);
  assert.ok(hooks.onStop(f.input, f.env));
  const other = fixture(t, { mention: false, tasks: [task('t1', 5)] });
  assert.strictEqual(hooks.onStop(other.input, other.env), null, 'a session that drives no run hears nothing');
});
