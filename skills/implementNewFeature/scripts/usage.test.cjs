'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { snapshotPath, writeSnapshot, shapeUsage, usageReader, PRUNE_AFTER_MS, RELAY_SCRIPT } = require('./usage.cjs');
const { commandOf } = require('./statusline-relay.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inf-usage-'));
}

// What Claude Code sends a status line command, cut to the fields the corner reads.
const status = (over = {}) => ({
  session_id: 'abc-123',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'max' },
  cost: { total_cost_usd: 12.5 },
  context_window: {
    context_window_size: 200000, total_input_tokens: 150000, total_output_tokens: 40000,
    current_usage: { input_tokens: 10, output_tokens: 500, cache_creation_input_tokens: 990,
      cache_read_input_tokens: 49000 },
  },
  rate_limits: {
    five_hour: { used_percentage: 42.5, resets_at: 1792000000 },
    seven_day: { used_percentage: 12, resets_at: 1792500000 },
  },
  ...over,
});

test('shapeUsage reads the model, effort, tokens, context and both limits', () => {
  assert.deepStrictEqual(shapeUsage(status(), '2026-10-23T10:00:00.000Z', {}), {
    relay: true, asOf: '2026-10-23T10:00:00.000Z', model: 'Opus 5.5', effort: 'max',
    tokens: { input: 150000, output: 40000 }, costUsd: 12.5,
    // What the last request carried: input, cache writes and cache reads, not its output.
    context: { usedPct: 25, used: 50000, size: 200000 },
    fiveHour: { usedPct: 42.5, resetsAt: new Date(1792000000 * 1000).toISOString() },
    weekly: { usedPct: 12, resetsAt: new Date(1792500000 * 1000).toISOString() },
  });
});

test('shapeUsage takes Claude Code\'s own context percentage and leaves out what is missing', () => {
  const u = shapeUsage(status({
    model: { id: 'claude-sonnet-5-5' }, effort: undefined, rate_limits: undefined, cost: undefined,
    context_window: { context_window_size: 1000000, used_percentage: 7, current_usage: null },
  }), 'x', { CLAUDE_EFFORT: 'high' });
  assert.strictEqual(u.model, 'claude-sonnet-5-5');
  // The effort the session was started with, when the status line names none.
  assert.strictEqual(u.effort, 'high');
  assert.deepStrictEqual(u.context, { usedPct: 7, used: null, size: 1000000 });
  assert.deepStrictEqual(u.tokens, { input: null, output: null });
  assert.strictEqual(u.costUsd, null);
  assert.strictEqual(u.fiveHour, null);
  assert.strictEqual(u.weekly, null);
});

test('the reader follows one session\'s snapshot, and says so when there is none', () => {
  const dir = tmpDir();
  const read = usageReader({ sessionId: 'abc-123', dir, env: { CLAUDE_EFFORT: 'max' } });
  // With the script the page tells the user to wrap their status line with.
  assert.deepStrictEqual(read(), { relay: false, effort: 'max', relayScript: RELAY_SCRIPT });
  assert.ok(fs.existsSync(RELAY_SCRIPT) && !RELAY_SCRIPT.includes('\\'));
  assert.strictEqual(writeSnapshot(status(), dir), path.join(dir, 'abc-123.json'));
  assert.strictEqual(read().model, 'Opus 5.5');
  // Another session's update is not this one's.
  writeSnapshot(status({ session_id: 'other', model: { display_name: 'Haiku 5.5' } }), dir);
  assert.strictEqual(read().model, 'Opus 5.5');
  writeSnapshot(status({ model: { display_name: 'Sonnet 5.5' } }), dir);
  assert.strictEqual(read().model, 'Sonnet 5.5');
  assert.ok(!fs.readdirSync(dir).some(n => n.endsWith('.tmp')), 'no half-written file left behind');
});

test('a session id that is not one names no file', () => {
  assert.strictEqual(snapshotPath('../etc/passwd', tmpDir()), null);
  assert.strictEqual(writeSnapshot(status({ session_id: '../x' }), tmpDir()), null);
  assert.strictEqual(writeSnapshot(null, tmpDir()), null);
  assert.deepStrictEqual(usageReader({ sessionId: null, dir: tmpDir(), env: {} })(),
    { relay: false, effort: null, relayScript: RELAY_SCRIPT });
});

test('a session\'s first snapshot clears those of sessions long over', () => {
  const dir = tmpDir();
  const old = path.join(dir, 'old.json');
  const recent = path.join(dir, 'recent.json');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(recent, '{}');
  const past = (Date.now() - PRUNE_AFTER_MS - 60000) / 1000;
  fs.utimesSync(old, past, past);
  writeSnapshot(status(), dir);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(recent));
  assert.ok(fs.existsSync(path.join(dir, 'abc-123.json')));
});

test('the relay runs one argument as a command line and quotes the parts of several', () => {
  assert.strictEqual(commandOf(['ccstatusline --flag']), 'ccstatusline --flag');
  assert.strictEqual(commandOf(['node', 'C:/Program Files/x.cjs']), 'node "C:/Program Files/x.cjs"');
});

test('the relay hands the update on unchanged, keeps it, and exits as the command did', async () => {
  const dir = tmpDir();
  const line = path.join(dir, 'line.cjs');
  fs.writeFileSync(line, "let s = ''; process.stdin.on('data', c => { s += c; }).on('end', () => {"
    + " process.stdout.write('line:' + JSON.parse(s).model.display_name); process.exit(3); });");
  const child = spawn(process.execPath, [path.join(__dirname, 'statusline-relay.cjs'), process.execPath, line],
    { env: { ...process.env, DOH_STATUSLINE_DIR: dir } });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.stdin.end(JSON.stringify(status()));
  const code = await new Promise(r => child.on('exit', r));
  assert.strictEqual(out, 'line:Opus 5.5');
  assert.strictEqual(code, 3);
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'abc-123.json'), 'utf8'));
  assert.strictEqual(kept.model.display_name, 'Opus 5.5');
});

test('the relay still runs the command when the update is not JSON', async () => {
  const dir = tmpDir();
  const line = path.join(dir, 'line.cjs');
  fs.writeFileSync(line, "process.stdin.resume().on('end', () => process.stdout.write('ok'));");
  const child = spawn(process.execPath, [path.join(__dirname, 'statusline-relay.cjs'), process.execPath, line],
    { env: { ...process.env, DOH_STATUSLINE_DIR: dir } });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.stdin.end('not json');
  const code = await new Promise(r => child.on('exit', r));
  assert.strictEqual(out, 'ok');
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(n => n.endsWith('.json')), []);
});
