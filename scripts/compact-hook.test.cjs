'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const hook = require('./compact-hook.cjs');

const note = (text) => ({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });

test('compact: every part\'s note in order; a part that throws or has nothing costs only its own', () => {
  const handlers = [() => note('codeReview'), () => { throw new Error('broken'); }, () => null, () => note('implementNewFeature')];
  assert.deepStrictEqual(hook.onCompact({ session_id: 's1' }, {}, handlers), note('codeReview\n\nimplementNewFeature'));
  assert.deepStrictEqual(hook.onCompact({ session_id: 's1' }, {}, [() => note('codeReview')]), note('codeReview'));
  assert.strictEqual(hook.onCompact({ session_id: 's1' }, {}, [() => null, () => { throw new Error('x'); }]), null);
});

test('parts: codeReview\'s and implementNewFeature\'s, each with its onCompact', () => {
  assert.deepStrictEqual(hook.parts.map((file) => path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/')), [
    'skills/codeReview/scripts/review-hooks.cjs',
    'skills/implementNewFeature/scripts/pipeline-hooks.cjs',
  ]);
  for (const file of hook.parts) assert.strictEqual(typeof require(file).onCompact, 'function', file);
});

test('CLI: a session no skill drives gets no output; a bad input is exit 0, a bad argument exit 1', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 's1.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: dir, message: { content: 'hi' } })}\n`);
  const env = { ...process.env, DOH_REVIEW_STATE_DIR: path.join(dir, 'state'), DOH_IND_SESSIONS_DIR: path.join(dir, 'own') };
  const run = (args, input) => spawnSync(process.execPath, [path.join(__dirname, 'compact-hook.cjs'), ...args], { input, encoding: 'utf8', env });
  let r = run(['--event=compact'], JSON.stringify({ session_id: 's1', transcript_path: transcript, cwd: dir, source: 'compact' }));
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  r = run(['--event=compact'], 'not JSON');
  assert.deepStrictEqual([r.status, r.stdout], [0, '']);
  for (const args of [[], ['--event=read'], ['--event=compact', '--x']]) {
    r = run(args, '{}');
    assert.strictEqual(r.status, 1, args.join(' '));
    assert.match(r.stderr, /--event=compact/);
  }
});
