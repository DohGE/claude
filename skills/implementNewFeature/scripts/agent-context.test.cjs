'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, findTranscript, contextOf, agentContext } = require('./agent-context.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = Date.parse('2026-11-12T10:38:00.000Z');
const call = (timestamp, usage) => JSON.stringify({ type: 'assistant', timestamp, message: { usage } });

function transcript(dir, { slug = 'C--proj', session = 's1', agent = 'a1', lines }) {
  const file = path.join(dir, slug, session, 'subagents', `agent-${agent}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const big = { input_tokens: 10, cache_read_input_tokens: 380000, cache_creation_input_tokens: 2000, output_tokens: 90 };
const small = { input_tokens: 10, cache_read_input_tokens: 58000, cache_creation_input_tokens: 2000, output_tokens: 90 };

test('the context is what the last request carried, and the idle time runs from the last line', () => {
  const text = [
    call('2026-11-12T09:00:00.000Z', small),
    'not json',
    JSON.stringify({ type: 'user', timestamp: '2026-11-12T10:06:41.000Z', message: { content: [] } }),
    call('2026-11-12T10:06:40.000Z', big),
  ].join('\n');
  assert.deepStrictEqual(contextOf(text), { tokens: 382100, lastTs: Date.parse('2026-11-12T10:06:41.000Z') });
});

test('a large context gone cold is respawned from its state file; without one it is resumed', (t) => {
  const dir = tempDir(t);
  transcript(dir, { lines: [call('2026-11-12T10:06:41.000Z', big)] });
  const state = path.join(dir, 'state.md');
  const base = { agent: 'a1', projectsDir: dir, session: 's1', ttlSeconds: 300, minContext: 100000 };

  const blind = agentContext({ ...base, stateFile: state }, NOW);
  assert.strictEqual(blind.respawn, false, 'a fresh agent would start blind');
  assert.match(blind.reason, /left no state file/);
  assert.deepStrictEqual([blind.found, blind.contextTokens, blind.idleSeconds, blind.cold, blind.stateFile], [true, 382100, 1879, true, false]);

  fs.writeFileSync(state, '# state\n');
  const fresh = agentContext({ ...base, stateFile: state }, NOW);
  assert.strictEqual(fresh.respawn, true);
  assert.match(fresh.reason, /cold after 1879 s with 382100 tokens/);
  // No state file named at all: the caller keeps its own record (a step's files), so cold and large is enough.
  assert.strictEqual(agentContext({ ...base, stateFile: '' }, NOW).respawn, true);
});

test('a warm agent and a small one are resumed', (t) => {
  const dir = tempDir(t);
  transcript(dir, { agent: 'warm', lines: [call('2026-11-12T10:35:00.000Z', big)] });
  transcript(dir, { agent: 'small', lines: [call('2026-11-12T09:00:00.000Z', small)] });
  const base = { projectsDir: dir, session: 's1', stateFile: '', ttlSeconds: 300, minContext: 100000 };
  const warm = agentContext({ ...base, agent: 'warm' }, NOW);
  assert.deepStrictEqual([warm.cold, warm.respawn], [false, false]);
  const little = agentContext({ ...base, agent: 'small' }, NOW);
  assert.deepStrictEqual([little.cold, little.respawn], [true, false]);
  assert.match(little.reason, /context is small \(60100 tokens\)/);
});

test('an agent nobody recorded is resumed, never guessed about', (t) => {
  const out = agentContext({ agent: 'ghost', projectsDir: tempDir(t), session: 's1', stateFile: '', ttlSeconds: 300, minContext: 100000 }, NOW);
  assert.deepStrictEqual([out.found, out.respawn], [false, false]);
});

test('the transcript is found under any project and session, the newest when an id repeats', (t) => {
  const dir = tempDir(t);
  const old = transcript(dir, { slug: 'A', session: 'old', lines: [call('2026-11-10T10:00:00.000Z', small)] });
  const recent = transcript(dir, { slug: 'B', session: 'new', lines: [call('2026-11-12T10:00:00.000Z', big)] });
  fs.utimesSync(old, new Date('2026-11-10T10:00:00Z'), new Date('2026-11-10T10:00:00Z'));
  assert.strictEqual(findTranscript('a1', { projectsDir: dir }).file, recent);
  assert.strictEqual(findTranscript('a1', { projectsDir: dir, session: 'old' }).file, old);
  // A session id that does not hold it is no reason to miss the transcript.
  assert.strictEqual(agentContext({ agent: 'a1', projectsDir: dir, session: 'elsewhere', stateFile: '', ttlSeconds: 300, minContext: 100000 }, NOW).found, true);
});

test('a line that outgrows the tail does not hide the usage', (t) => {
  const dir = tempDir(t);
  const picture = JSON.stringify({ type: 'user', timestamp: '2026-11-12T10:06:50.000Z', blob: 'x'.repeat(5 * 1024 * 1024) });
  transcript(dir, { lines: [call('2026-11-12T10:06:41.000Z', big), picture] });
  const out = agentContext({ agent: 'a1', projectsDir: dir, session: 's1', stateFile: '', ttlSeconds: 300, minContext: 100000 }, NOW);
  assert.strictEqual(out.contextTokens, 382100);
});

test('parseArgs needs an agent id and refuses a mistyped flag', () => {
  assert.strictEqual(parseArgs(['--agent=afaf0abb', '--min-context=50000']).minContext, 50000);
  assert.throws(() => parseArgs([]), /--agent=<agentId> is required/);
  assert.throws(() => parseArgs(['--agent=a', '--statefile=x']), /Unknown argument/);
});
