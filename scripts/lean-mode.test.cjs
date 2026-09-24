'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');

const lm = require('./lean-mode.cjs');
const { tempDir } = require('../skills/codeReview/scripts/test-helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'lean-mode.cjs');
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_SID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const DAY = 24 * 60 * 60 * 1000;

function input(extra) {
  return JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Bash', ...extra });
}

function stubProxy(t, status) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === '/readyz' ? status : 404;
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

// A port that was free a moment ago: bound, read, released. Nothing answers it.
function closedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---------- parseArgs ----------

test('parseArgs reads --event=activate, --event=subagent and --sync', () => {
  assert.deepStrictEqual(lm.parseArgs(['--event=activate']), { event: 'activate', sync: false });
  assert.deepStrictEqual(lm.parseArgs(['--event=subagent']), { event: 'subagent', sync: false });
  assert.deepStrictEqual(lm.parseArgs(['--sync']), { event: null, sync: true });
});

test('a mistyped flag or an unknown event stops the run', () => {
  assert.throws(() => lm.parseArgs(['--evnt=activate']), /Unknown argument/);
  assert.throws(() => lm.parseArgs(['activate']), /Unknown argument/);
  assert.throws(() => lm.parseArgs(['--event=start']), /--event must be/);
  assert.throws(() => lm.parseArgs(['--event=activate', '--sync']), /either/);
});

test('no flag at all is refused rather than doing nothing silently', () => {
  assert.throws(() => lm.parseArgs([]), /Nothing to do/);
});

// ---------- readHookInput ----------

test('hook input is taken from the first complete JSON object, without waiting for EOF', async () => {
  // On Windows the host can hold the pipe open long after writing the payload;
  // a reader that waits for EOF spends the hook's whole timeout doing nothing.
  const stream = new PassThrough();
  const started = Date.now();
  const pending = lm.readHookInput(stream, 5000);
  stream.write('{"session_id":"');
  stream.write(`${SID}"}`);
  const got = await pending;
  assert.deepStrictEqual(got, { session_id: SID });
  assert.ok(Date.now() - started < 1000, 'resolved at the closing brace, not at the deadline');
  stream.destroy();
});

test('hook input that never completes gives up at the deadline', async () => {
  const stream = new PassThrough();
  stream.write('{"session_id":');
  assert.strictEqual(await lm.readHookInput(stream, 100), null);
  stream.destroy();
});

test('hook input that ends without being JSON is null, not a throw', async () => {
  const stream = new PassThrough();
  const pending = lm.readHookInput(stream, 5000);
  stream.end('not json');
  assert.strictEqual(await pending, null);
});

// ---------- session ids ----------

test('only a UUID session id can name a state file', () => {
  assert.strictEqual(lm.isSessionId(SID), true);
  for (const bad of ['../x', 'a/b', '..\\..\\x', '', undefined, null, 42, `${SID}/../x`]) {
    assert.strictEqual(lm.isSessionId(bad), false, `rejects ${JSON.stringify(bad)}`);
  }
});

// ---------- subagent ----------

test('a sub-agent of a session where a doh skill ran gets the lean rules as additionalContext', (t) => {
  const dir = tempDir(t, 'lean-');
  fs.writeFileSync(path.join(dir, SID), '');
  const out = lm.subagent({ input: { session_id: SID, agent_id: 'a1', agent_type: 'general-purpose' }, env: { DOH_LEAN_STATE_DIR: dir } });
  assert.deepStrictEqual(out, {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: lm.leanText() },
  });
});

test('a sub-agent of any other session gets nothing', (t) => {
  const dir = tempDir(t, 'lean-');
  fs.writeFileSync(path.join(dir, SID), '');
  assert.strictEqual(lm.subagent({ input: { session_id: OTHER_SID }, env: { DOH_LEAN_STATE_DIR: dir } }), null);
});

test('no input or a path-like session id gets nothing', (t) => {
  const dir = tempDir(t, 'lean-');
  // A file that a traversal would reach if the id were joined unchecked.
  fs.writeFileSync(path.join(path.dirname(dir), 'escaped'), '');
  t.after(() => fs.rmSync(path.join(path.dirname(dir), 'escaped'), { force: true }));
  const env = { DOH_LEAN_STATE_DIR: dir };
  assert.strictEqual(lm.subagent({ input: null, env }), null);
  assert.strictEqual(lm.subagent({ input: { session_id: '../escaped' }, env }), null);
});

test('an unreadable rules file fails open: no context, no throw', (t) => {
  const dir = tempDir(t, 'lean-');
  fs.writeFileSync(path.join(dir, SID), '');
  const out = lm.subagent({ input: { session_id: SID }, env: { DOH_LEAN_STATE_DIR: dir }, source: path.join(dir, 'missing.md') });
  assert.strictEqual(out, null);
});

// ---------- activate ----------

test('activate marks the session so later sub-agents get the rules', async (t) => {
  const dir = tempDir(t, 'lean-');
  const env = { DOH_LEAN_STATE_DIR: dir, DOH_LEAN_HEADROOM: 'off' };
  assert.strictEqual(await lm.activate({ input: { session_id: SID }, env }), null);
  assert.ok(fs.existsSync(path.join(dir, SID)));
  assert.ok(lm.subagent({ input: { session_id: SID }, env }));
});

test('activate warns once when this session does not route through headroom', async (t) => {
  const dir = tempDir(t, 'lean-');
  const env = { DOH_LEAN_STATE_DIR: dir };
  const first = await lm.activate({ input: { session_id: SID }, env });
  assert.match(first.systemMessage, /headroom/i);
  assert.match(first.systemMessage, /ANTHROPIC_BASE_URL is not set/);
  // The hook fires on every tool call for the rest of the session; only the
  // first one may speak.
  assert.strictEqual(await lm.activate({ input: { session_id: SID }, env }), null);
});

test('no warning when ANTHROPIC_BASE_URL points at a live local proxy', async (t) => {
  const dir = tempDir(t, 'lean-');
  const base = await stubProxy(t, 200);
  const out = await lm.activate({ input: { session_id: SID }, env: { DOH_LEAN_STATE_DIR: dir, ANTHROPIC_BASE_URL: base } });
  assert.strictEqual(out, null);
});

test('a local proxy that does not answer /readyz with 2xx is reported', async (t) => {
  const dir = tempDir(t, 'lean-');
  const base = await stubProxy(t, 503);
  const out = await lm.activate({ input: { session_id: SID }, env: { DOH_LEAN_STATE_DIR: dir, ANTHROPIC_BASE_URL: base } });
  assert.match(out.systemMessage, /\/readyz/);
  assert.match(out.systemMessage, /503/);
});

test('nothing listening at ANTHROPIC_BASE_URL is reported within the timeout', async (t) => {
  const dir = tempDir(t, 'lean-');
  const base = `http://127.0.0.1:${await closedPort()}`;
  const started = Date.now();
  const out = await lm.activate({ input: { session_id: SID }, env: { DOH_LEAN_STATE_DIR: dir, ANTHROPIC_BASE_URL: base }, timeoutMs: 500 });
  assert.match(out.systemMessage, /did not answer/);
  assert.ok(Date.now() - started < 3000);
});

test('a non-local ANTHROPIC_BASE_URL is not mistaken for headroom', async (t) => {
  const dir = tempDir(t, 'lean-');
  const out = await lm.activate({ input: { session_id: SID }, env: { DOH_LEAN_STATE_DIR: dir, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
  assert.match(out.systemMessage, /not a local/);
});

test('DOH_LEAN_HEADROOM=off silences the headroom check but still marks the session', async (t) => {
  const dir = tempDir(t, 'lean-');
  const out = await lm.activate({ input: { session_id: SID }, env: { DOH_LEAN_STATE_DIR: dir, DOH_LEAN_HEADROOM: 'off' } });
  assert.strictEqual(out, null);
  assert.ok(fs.existsSync(path.join(dir, SID)));
});

test('activate with no usable session id does nothing', async (t) => {
  const dir = tempDir(t, 'lean-');
  assert.strictEqual(await lm.activate({ input: { tool_name: 'Bash' }, env: { DOH_LEAN_STATE_DIR: dir } }), null);
  assert.strictEqual(await lm.activate({ input: null, env: { DOH_LEAN_STATE_DIR: dir } }), null);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('parallel first activations warn once', async (t) => {
  // Parallel tool calls fire the hook concurrently; exactly one of them owns the
  // first activation, so the user sees one warning, not one per call.
  const dir = tempDir(t, 'lean-');
  const env = { DOH_LEAN_STATE_DIR: dir };
  const outs = await Promise.all([1, 2, 3].map(() => lm.activate({ input: { session_id: SID }, env })));
  assert.strictEqual(outs.filter(Boolean).length, 1);
});

test('the state dir is created when missing', async (t) => {
  const dir = path.join(tempDir(t, 'lean-'), 'nested', 'state');
  await lm.activate({ input: { session_id: SID }, env: { DOH_LEAN_STATE_DIR: dir, DOH_LEAN_HEADROOM: 'off' } });
  assert.ok(fs.existsSync(path.join(dir, SID)));
});

test('a first activation sweeps flags older than a week, keeping fresh ones and foreign files', async (t) => {
  const dir = tempDir(t, 'lean-');
  const old = path.join(dir, OTHER_SID);
  const fresh = path.join(dir, '9b2d6c1e-3f4a-4b5c-8d7e-0f1a2b3c4d5e');
  const foreign = path.join(dir, 'README');
  for (const file of [old, fresh, foreign]) fs.writeFileSync(file, '');
  const eightDaysAgo = (Date.now() - 8 * DAY) / 1000;
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
  fs.utimesSync(foreign, eightDaysAgo, eightDaysAgo);
  await lm.activate({ input: { session_id: SID }, env: { DOH_LEAN_STATE_DIR: dir, DOH_LEAN_HEADROOM: 'off' } });
  assert.strictEqual(fs.existsSync(old), false);
  assert.strictEqual(fs.existsSync(fresh), true);
  assert.strictEqual(fs.existsSync(foreign), true);
});

// ---------- syncSkills ----------

function skillRoot(t, bodies) {
  const root = tempDir(t, 'lean-root-');
  for (const [name, body] of Object.entries(bodies)) {
    fs.mkdirSync(path.join(root, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), body);
  }
  const source = path.join(root, 'rules.md');
  fs.writeFileSync(source, '## Lean mode\n\nfresh rules\n');
  return { root, source };
}

test('sync rewrites only what sits between the markers, and a second run changes nothing', (t) => {
  const before = `---\nname: x\n---\n\n# x\n\nintro\n\n${lm.MARK_START}\nstale\n${lm.MARK_END}\n\n## Step 1\n`;
  const { root, source } = skillRoot(t, { x: before });
  const first = lm.syncSkills({ root, source });
  assert.deepStrictEqual(first, { changed: ['skills/x/SKILL.md'], errors: [] });
  const after = fs.readFileSync(path.join(root, 'skills', 'x', 'SKILL.md'), 'utf8');
  assert.strictEqual(after, before.replace('stale', '## Lean mode\n\nfresh rules'));
  assert.deepStrictEqual(lm.syncSkills({ root, source }), { changed: [], errors: [] });
});

test('sync with write:false reports the drift without touching the file', (t) => {
  const before = `# x\n\n${lm.MARK_START}\nstale\n${lm.MARK_END}\n`;
  const { root, source } = skillRoot(t, { x: before });
  assert.deepStrictEqual(lm.syncSkills({ root, source, write: false }), { changed: ['skills/x/SKILL.md'], errors: [] });
  assert.strictEqual(fs.readFileSync(path.join(root, 'skills', 'x', 'SKILL.md'), 'utf8'), before);
});

test('a SKILL.md without markers is reported, not silently skipped', (t) => {
  const { root, source } = skillRoot(t, { y: '# y\n\n## Step 1\n' });
  const out = lm.syncSkills({ root, source });
  assert.deepStrictEqual(out.changed, []);
  assert.strictEqual(out.errors.length, 1);
  assert.match(out.errors[0], /skills\/y\/SKILL\.md/);
});

// ---------- what the plugin ships ----------

const shipped = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, 'skills', e.name, 'SKILL.md')))
  .map((e) => e.name);

test('every shipped SKILL.md carries the current lean block', () => {
  assert.ok(shipped.length >= 3);
  assert.deepStrictEqual(lm.syncSkills({ root: ROOT, write: false }), { changed: [], errors: [] },
    'run: node scripts/lean-mode.cjs --sync');
});

test('the lean block comes before every section of the skill, inside what compaction re-attaches', () => {
  // After auto-compaction Claude Code re-attaches only the first 5 000 tokens of
  // each invoked skill. A block below that line would switch lean mode off in
  // exactly the long runs it exists for.
  for (const name of shipped) {
    const text = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
    const start = text.indexOf(lm.MARK_START);
    const end = text.indexOf(lm.MARK_END);
    assert.ok(start > 0 && end > start, `${name}: markers present`);
    assert.ok(!/\n## /.test(text.slice(0, start)), `${name}: no section before the block`);
    assert.ok(end < 16000, `${name}: block ends at char ${end}, past the re-attached head`);
  }
});

test('every SKILL.md registers the activation hook in its frontmatter', () => {
  for (const name of shipped) {
    // core.autocrlf checks some SKILL.md files out with CRLF; the YAML is the same.
    const text = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const front = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(front, `${name}: frontmatter`);
    assert.match(front[1], /\nhooks:\n {2}PreToolUse:\n/, `${name}: PreToolUse hook`);
    assert.match(front[1], /command: node\n/, `${name}: exec form`);
    assert.ok(front[1].includes('args: ["${CLAUDE_PLUGIN_ROOT}/scripts/lean-mode.cjs", "--event=activate"]'),
      `${name}: activation args`);
  }
  assert.strictEqual(lm.parseArgs(['--event=activate']).event, 'activate');
});

test('the plugin registers one SubagentStart hook, pointing at this script', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const groups = config.hooks.SubagentStart;
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].hooks.length, 1);
  const hook = groups[0].hooks[0];
  assert.strictEqual(hook.type, 'command');
  assert.strictEqual(hook.command, 'node');
  assert.deepStrictEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/lean-mode.cjs', '--event=subagent']);
  assert.strictEqual(lm.parseArgs(hook.args.slice(1)).event, 'subagent');
});

test('the rules keep the doh literals verbatim and credit caveman', () => {
  const text = lm.leanText();
  for (const needle of ['FIXED IDENTIFIER', '`think`', '`ultrathink`', 'headroom_retrieve', 'normal mode', 'caveman', 'MIT']) {
    assert.ok(text.includes(needle), `rules mention ${needle}`);
  }
  const license = fs.readFileSync(path.join(ROOT, 'shared', 'CAVEMAN-LICENSE'), 'utf8');
  assert.match(license, /Copyright \(c\) 2026 Julius Brussee/);
});

// ---------- the CLI the hooks run ----------

function cli(t, args, stdin, extraEnv) {
  const dir = tempDir(t, 'lean-cli-');
  const env = { ...process.env, DOH_LEAN_STATE_DIR: dir, DOH_LEAN_HEADROOM: 'off', ...extraEnv };
  return { dir, run: () => spawnSync(process.execPath, [script, ...args], { input: stdin, env, encoding: 'utf8' }) };
}

test('the hook entry points exit 0 and print JSON only when there is something to say', (t) => {
  const { dir, run } = cli(t, ['--event=subagent'], input({ hook_event_name: 'SubagentStart' }));
  const silent = run();
  assert.strictEqual(silent.status, 0);
  assert.strictEqual(silent.stdout, '');
  fs.writeFileSync(path.join(dir, SID), '');
  const spoken = run();
  assert.strictEqual(spoken.status, 0);
  assert.strictEqual(JSON.parse(spoken.stdout).hookSpecificOutput.additionalContext, lm.leanText());
});

test('garbage on stdin never fails a hook', (t) => {
  for (const event of ['activate', 'subagent']) {
    const { run } = cli(t, [`--event=${event}`], 'not json at all');
    const res = run();
    assert.strictEqual(res.status, 0, `${event} exits 0`);
    assert.strictEqual(res.stdout, '');
  }
});

test('the activate entry point marks the session through the CLI', (t) => {
  const { dir, run } = cli(t, ['--event=activate'], input());
  const res = run();
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, '');
  assert.ok(fs.existsSync(path.join(dir, SID)));
});
