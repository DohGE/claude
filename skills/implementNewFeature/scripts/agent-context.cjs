#!/usr/bin/env node
'use strict';

// Whether a sub-agent that sat idle is still worth talking to, or a fresh one is cheaper.
//
// A sub-agent's prompt cache lives five minutes (every cache write of a sub-agent is
// `ephemeral_5m`; only the session that spawns it gets an hour). An agent that waited longer -
// at a question, at a gate - has lost it, and the next SendMessage writes its WHOLE context
// again, then every later turn re-reads it. Measured on a validation agent: an answer that came
// 31 minutes after the question rewrote 382k tokens, and the 50 turns after it each read ~410k -
// about 2.7M input-equivalent tokens for work a fresh agent starting from a state file does for
// 0.8M. A small context is the other way round: rewriting 60k costs less than a new agent that
// has to read its brief and its files again.
//
// So the orchestrator asks here before it forwards anything to an agent that may have gone cold:
//
//   node agent-context.cjs --agent=<agentId> [--state-file=<the agent's resume state>]
//        [--session=<this session's id>] [--projects-dir=<dir>] [--ttl-seconds=300] [--min-context=100000]
//
// One JSON line: { agent, found, contextTokens, idleSeconds, cold, stateFile, respawn, reason }.
// `respawn` true -> spawn a fresh agent with the state file; false -> SendMessage. It is true only
// when the cache is gone AND the context is large (or cannot be measured) AND - when a state file
// is named - that file exists: without one a fresh agent would start blind, so the old one is
// resumed whatever it costs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TTL_SECONDS = 300;
const MIN_CONTEXT = 100000;
const TAIL_BYTES = 4 * 1024 * 1024;

function parseArgs(argv) {
  const args = { agent: '', stateFile: '', session: process.env.CLAUDE_CODE_SESSION_ID || '', projectsDir: '',
    ttlSeconds: TTL_SECONDS, minContext: MIN_CONTEXT };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'agent') args.agent = m[2].trim();
    else if (m[1] === 'state-file') args.stateFile = m[2];
    else if (m[1] === 'session') args.session = m[2].trim();
    else if (m[1] === 'projects-dir') args.projectsDir = m[2];
    else if (m[1] === 'ttl-seconds') args.ttlSeconds = Number(m[2]) || TTL_SECONDS;
    else if (m[1] === 'min-context') args.minContext = Number(m[2]) || MIN_CONTEXT;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(args.agent)) throw new Error('--agent=<agentId> is required');
  if (!args.projectsDir) args.projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  return args;
}

// <projectsDir>/<project slug>/<session id>/subagents/agent-<id>.jsonl - the newest when the
// same id shows up twice.
function findTranscript(agentId, { projectsDir, session = '' }) {
  const name = `agent-${agentId}.jsonl`;
  let slugs;
  try {
    slugs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  let best = null;
  for (const slug of slugs) {
    let sessions = session ? [session] : [];
    if (!session) {
      try {
        sessions = fs.readdirSync(path.join(projectsDir, slug));
      } catch {
        continue;
      }
    }
    for (const s of sessions) {
      const file = path.join(projectsDir, slug, s, 'subagents', name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs, size: st.size };
    }
  }
  return best;
}

function readTail(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // The first line of a tail is the end of some other line.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// What the agent's last request carried - its context when it speaks next - and when it last
// wrote a line.
function contextOf(text) {
  let tokens = 0;
  let lastTs = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(entry.timestamp || '');
    if (ts) lastTs = Math.max(lastTs, ts);
    const usage = entry.type === 'assistant' && entry.message && entry.message.usage;
    if (usage) {
      tokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
    }
  }
  return { tokens, lastTs };
}

function agentContext(args, now = Date.now()) {
  const out = { agent: args.agent, found: false, contextTokens: null, idleSeconds: null, cold: null,
    stateFile: args.stateFile ? fs.existsSync(args.stateFile) : null, respawn: false, reason: '' };
  const found = findTranscript(args.agent, args) || (args.session ? findTranscript(args.agent, { ...args, session: '' }) : null);
  if (!found) {
    out.reason = 'no transcript of this agent - resume it';
    return out;
  }
  out.found = true;
  let { tokens, lastTs } = contextOf(readTail(found.file, found.size, TAIL_BYTES));
  // One line can outgrow the tail (a tool result with pictures in it): then read it all.
  if (!tokens && found.size > TAIL_BYTES) ({ tokens, lastTs } = contextOf(fs.readFileSync(found.file, 'utf8')));
  out.contextTokens = tokens || null;
  out.idleSeconds = Math.max(0, Math.round((now - (lastTs || found.mtimeMs)) / 1000));
  out.cold = out.idleSeconds > args.ttlSeconds;
  const large = !tokens || tokens >= args.minContext;
  if (!out.cold) out.reason = 'the prompt cache is still warm - resume it';
  else if (!large) out.reason = `cold, but its context is small (${tokens} tokens) - resuming it is cheaper than a fresh agent`;
  else if (out.stateFile === false) out.reason = 'cold and large, but it left no state file - resume it, a fresh agent would start blind';
  else {
    out.respawn = true;
    out.reason = `cold after ${out.idleSeconds} s with ${tokens || 'an unknown number of'} tokens of context - a fresh agent from the state file is cheaper`;
  }
  return out;
}

if (require.main === module) {
  let result;
  try {
    result = agentContext(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { found: false, respawn: false, reason: String((err && err.message) || err) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { parseArgs, findTranscript, contextOf, agentContext };
