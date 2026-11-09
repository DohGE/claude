'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const stop = require('./agent-stop.cjs');
const { tempDir } = require('../../codeReview/scripts/test-helpers.cjs');

const brief = 'Your complete instructions are in the file C:\\p\\.claude\\doh\\b\\b-fix-pr-agent-prompt.md. Read it.';
const json = '{"type":"result","committed":true,"summary":"ok"}';

function transcript(t, entries) {
  const file = path.join(tempDir(t, 'fpc-stop-'), 'agent.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
  return file;
}
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('a fix agent ending with the JSON object alone stops', (t) => {
  const file = transcript(t, [user(brief), said(json)]);
  assert.strictEqual(stop.decide({ agent_transcript_path: file }), null);
});

test('prose before the JSON is refused once, with the reason', (t) => {
  const file = transcript(t, [user(brief), said(`All 11 threads fixed.\n\n- Commit: abc\n\n${json}`)]);
  const out = stop.decide({ agent_transcript_path: file });
  assert.strictEqual(out.decision, 'block');
  assert.match(out.reason, /JSON object ALONE/);
  assert.strictEqual(stop.decide({ agent_transcript_path: file, stop_hook_active: true }), null, 'never a loop');
});

test('a turn ended with no JSON - background work still running - is sent back to wait', (t) => {
  const file = transcript(t, [user(brief), said('The gate runs in the background; I will wait for it.')]);
  assert.match(stop.decide({ agent_transcript_path: file }).reason, /wait-part\.cjs/);
});

test('any other sub-agent, a hand-back tool call or no transcript is left alone', (t) => {
  assert.strictEqual(stop.decide({ agent_transcript_path: transcript(t, [user('Review this diff.'), said('prose')]) }), null);
  const handback = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: {} }] } };
  assert.strictEqual(stop.decide({ agent_transcript_path: transcript(t, [user(brief), handback]) }), null);
  assert.strictEqual(stop.decide({}), null);
});

test('the restack agent is held to the same ending, and last_assistant_message is used when given', (t) => {
  const file = transcript(t, [user('Your complete instructions are in the file C:\\x\\p2-fix-pr-agent-prompt-restack.md.'), said(json)]);
  assert.match(stop.decide({ agent_transcript_path: file, last_assistant_message: `Done.\n${json}` }).reason, /ALONE/);
});
