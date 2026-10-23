'use strict';

// The orchestrator's own numbers for the stepper's corner: the tokens its session has spent,
// how much of the 5-hour and the weekly limit that took, the model and effort it runs on and
// how full its context is. Claude Code hands every one of them to the status line command on
// each update, and to nothing a server can read: hooks get none of the limits, and the usage
// API wants the user's OAuth token, which the pipeline has no business opening. So the status
// line is wrapped (statusline-relay.cjs). The wrapper drops each update here as a snapshot,
// one file per session, and the server started from that session reads its own.
//
// Nothing here may break what it serves: the relay sits in front of the user's status line
// and the reader behind a page that polls every second, so every failure ends in "no data".

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A snapshot nobody has updated for this long belongs to a session that is over.
const PRUNE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
// Named in the page's hint for a session with no relay yet, with the slashes a settings.json
// string takes as they are.
const RELAY_SCRIPT = path.join(__dirname, 'statusline-relay.cjs').replace(/\\/g, '/');

const snapshotDir = (env = process.env) => env.DOH_STATUSLINE_DIR || path.join(os.tmpdir(), 'doh-statusline');

// A session id names a file, so only what an id is made of gets that far.
const safeId = (id) => (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null);

function snapshotPath(sessionId, dir = snapshotDir()) {
  const id = safeId(sessionId);
  return id ? path.join(dir, `${id}.json`) : null;
}

// Once per session - the first update it sends - the snapshots of sessions long gone go.
function prune(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > PRUNE_AFTER_MS) fs.unlinkSync(file);
    } catch {}
  }
}

// Write-then-rename: the server reads the file once a second, so it must only ever find a
// whole one. Returns the path written, or null.
function writeSnapshot(status, dir = snapshotDir(), now = Date.now()) {
  const file = snapshotPath(status && status.session_id, dir);
  if (!file) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) prune(dir, now);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status));
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const pct = (v) => (num(v) === null ? null : Math.min(100, v));
// `resets_at` is a Unix time in seconds; one in milliseconds or an ISO string is read too.
function isoOf(v) {
  const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const limitOf = (bucket) => (bucket && typeof bucket === 'object'
  ? { usedPct: pct(bucket.used_percentage), resetsAt: isoOf(bucket.resets_at) } : null);

// The fields the corner shows, from Claude Code's status line JSON. Context is what the last
// request carried - input, cache writes and cache reads - which is the same reading the
// user's own status line takes of it.
function shapeUsage(status, asOf, env = process.env) {
  const s = status && typeof status === 'object' ? status : {};
  const cw = s.context_window && typeof s.context_window === 'object' ? s.context_window : {};
  const cu = cw.current_usage;
  const used = typeof cu === 'number' ? num(cu)
    : cu && typeof cu === 'object'
      ? (num(cu.input_tokens) || 0) + (num(cu.cache_creation_input_tokens) || 0) + (num(cu.cache_read_input_tokens) || 0)
      : null;
  const size = num(cw.context_window_size) || null;
  const usedPct = pct(cw.used_percentage) !== null ? pct(cw.used_percentage)
    : used !== null && size ? pct((used / size) * 100) : null;
  const limits = s.rate_limits && typeof s.rate_limits === 'object' ? s.rate_limits : {};
  return {
    relay: true,
    asOf,
    model: (s.model && (s.model.display_name || s.model.id)) || null,
    effort: (s.effort && typeof s.effort.level === 'string' && s.effort.level) || env.CLAUDE_EFFORT || null,
    tokens: { input: num(cw.total_input_tokens), output: num(cw.total_output_tokens) },
    costUsd: num(s.cost && s.cost.total_cost_usd),
    context: { usedPct, used, size },
    fiveHour: limitOf(limits.five_hour),
    weekly: limitOf(limits.seven_day),
  };
}

// The reader the server polls: the snapshot of ONE session, parsed again only when the file
// changed. Without a session id or a snapshot it still says what it knows - the effort the
// session was started with - and that the relay is missing, so the page can say how to fix it.
function usageReader({ sessionId = process.env.CLAUDE_CODE_SESSION_ID, dir = snapshotDir(), env = process.env } = {}) {
  const file = snapshotPath(sessionId, dir);
  const none = { relay: false, effort: env.CLAUDE_EFFORT || null, relayScript: RELAY_SCRIPT };
  let key = null;
  let value = none;
  return () => {
    if (!file) return none;
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      key = null;
      return none;
    }
    const k = `${st.mtimeMs}|${st.size}`;
    if (k === key) return value;
    try {
      value = shapeUsage(JSON.parse(fs.readFileSync(file, 'utf8')), new Date(st.mtimeMs).toISOString(), env);
      key = k;
    } catch {
      // Caught between the write and the rename on a platform without an atomic one: the
      // next poll reads it whole.
      return value;
    }
    return value;
  };
}

module.exports = { snapshotDir, snapshotPath, writeSnapshot, shapeUsage, usageReader, PRUNE_AFTER_MS,
  RELAY_SCRIPT };
