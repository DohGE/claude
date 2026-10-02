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
function fixture(t, { tasks = null, serverPid = process.pid, waiterPid = null, mention = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const session = path.join(project, '.claude', 'doh', '20261001-120000');
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, 'server.json'), JSON.stringify({ port: 9999, pid: serverPid }));
  if (tasks) fs.writeFileSync(path.join(session, 'pipeline-state.json'), JSON.stringify({ tasks, nextTaskId: tasks.length + 1 }));
  const locks = path.join(root, 'locks');
  fs.mkdirSync(locks);
  if (waiterPid) fs.writeFileSync(path.join(locks, 'doh-answer-waiter-9999.json'), JSON.stringify({ pid: waiterPid, startedAt: Date.now() }));
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

test('compact: names the run, where each task stands, the E2E slot and the sections to read again', (t) => {
  const f = fixture(t, {
    waiterPid: process.pid,
    tasks: [
      task('t1', 4, { 4: { status: 'in_progress', currentOperation: 'Writing tests' } }, { branch: 'feature/a' }),
      task('t2', 5, { 5: { status: 'in_progress' } }),
      task('t3', 5, { 5: { status: 'waiting', currentOperation: 'Waiting for the E2E slot' } }, { question: { id: 'q1' } }),
    ],
  });
  const note = noteOf(hooks.onCompact(f.input, f.env));
  assert.ok(note, 'a session that drives a live run gets a note');
  assert.ok(note.includes(`- session: ${slash(f.session)}, server on port 9999 (pid ${process.pid})`), note);
  assert.ok(note.includes('- t1 on `feature/a`: step 4 Implementation - in_progress, "Writing tests"'), note);
  assert.ok(note.includes('- t2 on no branch yet: step 5 Validation & E2E - in_progress'), note);
  assert.ok(note.includes('- t3 on no branch yet: step 5 Validation & E2E - waiting, "Waiting for the E2E slot"; a question is open'), note);
  assert.ok(note.includes('- E2E_LOCK: held by t2; queued: t3'), note);
  assert.ok(note.includes(`- waiter: listening (pid ${process.pid}) - do not start a second one`), note);
  assert.ok(note.includes(`${sectionOf('Server helpers')} (Server helpers`), 'the cut runs through Server helpers');
  assert.ok(note.includes(`${sectionOf('Step 4 ')} (Step 4`), note);
  assert.ok(note.includes(`${sectionOf('Step 5 ')} (Step 5`), note);
  assert.ok(!/\(Step 2 |\(Failure protocol|\(Final summary/.test(note), 'only what the tasks\' state calls for');
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
  for (const title of ['Step 6 ', 'Step 7 ', 'Failure protocol', 'Final summary']) {
    assert.ok(note.includes(`${sectionOf(title)} (${title.trim()}`), `${title}: ${note}`);
  }
  assert.ok(note.includes('- waiter: none is listening - start one (loop card point 1) before you end this turn'), note);
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
  assert.ok(titles.some((title) => title.startsWith('Server helpers')), 'it straddles the cut');
  assert.ok(!titles.some((title) => title.startsWith('Talking to a running agent')), 'that one stays in the head');
  const summary = skill.sections.find((s) => s.title.startsWith('Final summary'));
  const lines = fs.readFileSync(skillFile, 'utf8').split(/\r?\n/);
  assert.ok(lines[summary.line - 1 + summary.limit].startsWith('<!-- one-time:start -->'), 'Final summary ends at the one-time part');
  assert.ok(lines[skill.headLimit].startsWith('## Step 1 '), 'the head runs up to step 1');
  assert.strictEqual(hooks.skillSections(path.join(__dirname, 'no-such', 'SKILL.md')), null);
});

test('loop card: short enough to ride in every compaction, and the plugin\'s compaction hook asks this part', () => {
  const card = hooks.loopCard(skillFile).join('\n');
  assert.ok(card.length <= 3000, `${card.length} chars`);
  for (const term of ['wait-answer.cjs', 'run_in_background', 'WAITER_RUNNING', 'E2E_LOCK', '"taskId"', 'SendMessage']) {
    assert.ok(card.includes(term), term);
  }
  const shared = require('../../../scripts/compact-hook.cjs');
  assert.ok(shared.parts.includes(path.join(__dirname, 'pipeline-hooks.cjs')));
});
