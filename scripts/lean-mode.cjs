#!/usr/bin/env node
'use strict';

// doh lean mode: caveman ultra for the orchestrator and for every sub-agent of a
// session in which a doh skill ran, plus a one-time check that the session is
// routed through the headroom proxy. shared/README.md explains the whole of it.
//
// Three entry points, one per caller:
//
//   --event=activate   a PreToolUse hook in the frontmatter of every doh SKILL.md.
//                      Claude Code registers a skill's frontmatter hooks when the
//                      skill is invoked and keeps them for the rest of the
//                      session, so the first tool call after any doh skill loads
//                      lands here. It drops a flag named after the session id
//                      and, that first time only, checks headroom.
//   --event=subagent   the SubagentStart hook in the plugin's hooks/hooks.json.
//                      It fires for every sub-agent of every session; only a
//                      session holding the flag gets the rules, as
//                      additionalContext at the start of the sub-agent's context.
//   --sync             maintainer command: copies shared/caveman-ultra.md into the
//                      marked block of every skills/*/SKILL.md, which is where
//                      the orchestrator reads the same rules.
//
// Why a flag plus one plugin-level hook, not a SubagentStart hook in each
// skill's frontmatter: hooks declared by different skills are never
// deduplicated, so a session that ran two doh skills would hand every later
// sub-agent the rules twice. One plugin hook reading one flag injects exactly
// one copy, whatever ran and however often.
//
// Why the flag is created with O_EXCL instead of trusting `once: true`: Claude
// Code 2.1.280 runs a plugin skill's `once` PreToolUse hook on every tool call
// (measured: three tool calls, three runs). The first run creates the flag;
// every later run finds it and returns before doing anything else, so the
// warning below is shown once and the per-call cost is one failed open().
//
// A hook must never break a session. Every failure here ends in exit 0 and no
// output, which is exactly "lean mode off" - never a blocked tool call.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'shared', 'caveman-ultra.md');
const MARK_START = '<!-- lean-mode:start (generated from shared/caveman-ultra.md) -->';
const MARK_END = '<!-- lean-mode:end -->';
const FLAG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parseArgs(argv) {
  const args = { event: null, sync: false };
  const unknown = [];
  for (const arg of argv) {
    if (arg === '--sync') {
      args.sync = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=([\s\S]*)$/);
    if (m && m[1] === 'event') {
      if (m[2] !== 'activate' && m[2] !== 'subagent') {
        throw new Error(`--event must be activate or subagent, not ${JSON.stringify(m[2])}.`);
      }
      args.event = m[2];
    } else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --event=activate|subagent or --sync).`);
  }
  if (args.event && args.sync) throw new Error('Pass either --event or --sync, not both.');
  if (!args.event && !args.sync) {
    throw new Error('Nothing to do: pass --event=activate, --event=subagent or --sync.');
  }
  return args;
}

// Resolves with the hook payload as soon as the text read so far parses as one
// JSON object - not at EOF. On Windows the host can keep the pipe open long
// after writing the payload, and a reader that waits for EOF spends the hook's
// whole timeout waiting (caveman hit exactly this: JuliusBrussee/caveman #729,
// #833). Anything that never becomes an object by the deadline is null.
function readHookInput(stream, deadlineMs) {
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const parsed = () => {
      try {
        const value = JSON.parse(text);
        return value && typeof value === 'object' ? value : null;
      } catch {
        return undefined;
      }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onEnd);
      if (typeof stream.pause === 'function') stream.pause();
      resolve(value);
    };
    const onData = (chunk) => {
      text += chunk;
      const value = parsed();
      if (value !== undefined) finish(value);
    };
    const onEnd = () => {
      const value = parsed();
      finish(value === undefined ? null : value);
    };
    const timer = setTimeout(() => finish(null), deadlineMs);
    if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onEnd);
  });
}

// The session id becomes a file name, so it must be exactly a UUID: anything
// else could carry a path separator out of the state directory.
function isSessionId(value) {
  return typeof value === 'string' && UUID.test(value);
}

function stateDir(env) {
  return env.DOH_LEAN_STATE_DIR || path.join(os.tmpdir(), 'claude-doh-lean');
}

function leanText(source = SOURCE) {
  return fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n').trimEnd();
}

function subagent({ input, env = process.env, source = SOURCE }) {
  try {
    const sid = input && input.session_id;
    if (!isSessionId(sid)) return null;
    if (!fs.existsSync(path.join(stateDir(env), sid))) return null;
    return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: leanText(source) } };
  } catch {
    return null;
  }
}

// Flags are session-scoped and tiny, but nothing else ever deletes them. A
// flag older than a week belongs to a session nobody is going to resume.
function sweep(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!UUID.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > FLAG_MAX_AGE_MS) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      // a parallel sweep got there first
    }
  }
  return removed;
}

// headroom only helps if this very session talks to the API through it: the
// base URL is fixed when Claude Code starts, so a proxy that is merely
// installed, or running for some other session, compresses nothing here.
function checkHeadroom(env, timeoutMs = 1500) {
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return Promise.resolve({ active: false, reason: 'ANTHROPIC_BASE_URL is not set' });
  let url;
  try {
    url = new URL(base);
  } catch {
    return Promise.resolve({ active: false, reason: `ANTHROPIC_BASE_URL (${base}) is not a URL` });
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname)) {
    return Promise.resolve({ active: false, reason: `ANTHROPIC_BASE_URL points at ${url.origin}, not a local headroom proxy` });
  }
  return new Promise((resolve) => {
    const req = http.get(new URL('/readyz', url.origin), { timeout: timeoutMs }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve({ active: true, reason: '' });
      else resolve({ active: false, reason: `the proxy at ${url.origin} answered /readyz with ${res.statusCode}` });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', (err) => {
      resolve({ active: false, reason: `the proxy at ${url.origin} did not answer /readyz (${err.code || err.message})` });
    });
  });
}

async function activate({ input, env = process.env, now = Date.now(), timeoutMs = 1500 }) {
  const sid = input && input.session_id;
  if (!isSessionId(sid)) return null;
  const dir = stateDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.closeSync(fs.openSync(path.join(dir, sid), 'wx'));
  } catch {
    // EEXIST is the fast path: an earlier tool call of this session already
    // activated. Any other error leaves lean mode off for sub-agents - failing
    // open, as every hook here must.
    return null;
  }
  sweep(dir, now);
  if (String(env.DOH_LEAN_HEADROOM || '').toLowerCase() === 'off') return null;
  const headroom = await checkHeadroom(env, timeoutMs);
  if (headroom.active) return null;
  return {
    systemMessage: `doh lean mode: headroom is not active in this session (${headroom.reason}), so context is not compressed; caveman ultra still is. `
      + 'To enable: `uv tool install --python 3.13 "headroom-ai[all]"`, then `headroom init -g claude`; the full setup, telemetry opt-out included, is in shared/README.md of the doh plugin. '
      + 'To silence: set DOH_LEAN_HEADROOM=off.',
  };
}

// The orchestrator reads the rules from its own SKILL.md, not from a hook: skill
// content survives auto-compaction (its first 5 000 tokens are re-attached),
// hook context injected into the main session would not. So each SKILL.md holds
// a copy, and this keeps every copy identical to the one source.
function syncSkills({ root = ROOT, source = SOURCE, write = true } = {}) {
  const changed = [];
  const errors = [];
  let rules;
  try {
    rules = leanText(source);
  } catch (err) {
    return { changed, errors: [`Could not read ${source}: ${(err && err.message) || err}`] };
  }
  const skillsDir = path.join(root, 'skills');
  let names = [];
  try {
    names = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    return { changed, errors: [`Could not list ${skillsDir}: ${(err && err.message) || err}`] };
  }
  for (const name of names) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const rel = `skills/${name}/SKILL.md`;
    const text = fs.readFileSync(file, 'utf8');
    const start = text.indexOf(MARK_START);
    const end = text.indexOf(MARK_END);
    if (start === -1 || end === -1 || end < start) {
      errors.push(`${rel}: no lean-mode block - put ${MARK_START} and ${MARK_END} on their own lines before the first section.`);
      continue;
    }
    // A checkout with CRLF endings gets a CRLF block, so the file never ends up
    // with mixed line endings.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const block = [MARK_START, ...rules.split('\n'), MARK_END].join(eol);
    const next = text.slice(0, start) + block + text.slice(end + MARK_END.length);
    if (next === text) continue;
    changed.push(rel);
    if (write) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, file);
    }
  }
  return { changed, errors };
}

function exitWith(out) {
  if (!out) process.exit(0);
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exit(1);
  }
  if (args.sync) {
    const result = syncSkills();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.errors.length > 0 ? 1 : 0);
  }
  let out = null;
  try {
    const input = await readHookInput(process.stdin, 3000);
    out = args.event === 'subagent' ? subagent({ input }) : await activate({ input });
  } catch {
    out = null;
  }
  exitWith(out);
}

module.exports = {
  parseArgs, readHookInput, isSessionId, stateDir, leanText, subagent, sweep, checkHeadroom, activate, syncSkills,
  SOURCE, MARK_START, MARK_END,
};

if (require.main === module) main();
