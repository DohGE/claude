#!/usr/bin/env node
'use strict';

// SubagentStop hook for the fixPr and restack agents (hooks/hooks.json): an agent ends with its
// single JSON object, and nothing else.
//
// On 2026-11-06 two fix agents ended with a page of English prose before the JSON - in a run
// whose language was Polish - and the orchestrator carried that prose for the rest of the run;
// another ended its turn three times while its own gate ran in the background, and every time
// the orchestrator was woken for a result that was not there. Both are refused here with the
// reason, once: the agent gets one more turn to end properly (stop_hook_active stops a loop).
//
// The agent is recognised by its brief: the first message of its transcript points at a
// rendered `*-fix-pr-agent-prompt*.md` or `*-restack-agent-prompt*.md`. Any other sub-agent, a
// final message that ends in a tool call, an unreadable transcript: no output, exit 0. A hook
// never breaks a session.

const fs = require('node:fs');

const briefPattern = /-(?:fix-pr|restack)-agent-prompt[\w-]*\.md/;

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('\n') : '');

function isFixAgent(entries) {
  const first = entries.find((e) => e.type === 'user' && e.message);
  return Boolean(first) && briefPattern.test(textOf(first.message.content));
}

// The last assistant message: its text, or null when it ends in a tool call (a hand-back).
function lastAssistant(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.type !== 'assistant' || !e.message) continue;
    const content = e.message.content;
    if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_use')) return null;
    const text = textOf(content);
    if (text.trim()) return text;
  }
  return '';
}

const isFinal = (value) => value && typeof value === 'object' && ['result', 'error'].includes(value.type);

// null when the message is the JSON object alone; otherwise the reason to give the agent.
function verdict(text) {
  const trimmed = String(text || '').trim();
  try {
    if (isFinal(JSON.parse(trimmed))) return null;
  } catch {
    // not the object alone
  }
  const at = trimmed.lastIndexOf('{"type"');
  if (at >= 0) {
    try {
      if (isFinal(JSON.parse(trimmed.slice(at)))) {
        return 'Your final message carries text before its JSON object. The orchestrator reads that message whole: end with the JSON object ALONE - no heading, no summary, no text before or after it. Everything else belongs in the report file and in the JSON\'s "summary" field. Send the same JSON object again, alone.';
      }
    } catch {
      // a broken object: the reason below
    }
  }
  return 'You ended your turn without the final JSON object your brief specifies. If your own background work is still running (the gate, the self-review), never end a turn while it runs: wait for its file with wait-part.cjs, as the brief\'s "Waiting" section says. Then finish the remaining steps and end with the single JSON object - alone, nothing before or after it.';
}

function decide(input) {
  if (!input || input.stop_hook_active) return null;
  const file = input.agent_transcript_path || null;
  if (!file) return null;
  const entries = readJsonl(file);
  if (!isFixAgent(entries)) return null;
  const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : lastAssistant(entries);
  if (text === null) return null;
  const reason = verdict(text);
  return reason ? { decision: 'block', reason } : null;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const out = decide(JSON.parse(raw || '{}'));
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    } catch {
      // never break a session
    }
    process.exit(0);
  });
}

module.exports = { decide, verdict, isFixAgent, lastAssistant };

if (require.main === module) main();
