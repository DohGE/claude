#!/usr/bin/env node
'use strict';

// The closing summary of a fixPr run, in Polish, from the files the run left: the run file (with
// each target's `outcome` and `landingResult`, fixpr-after.cjs), each agent's
// `<reportPath>.result.json` and the stack check (restack.cjs --action=verify, with --verify=yes).
//
// On 2026-11-16 the orchestrator wrote it by hand from nine agent replies of 6-8 kB, a step where a
// rejected comment's ground or a file to look at is easily left out. Printed as Markdown; the
// orchestrator's final message is this text as it is.
//
// Usage: node fixpr-summary.cjs --run=<fixpr-run-*.json> [--verify=yes|no]

const fs = require('node:fs');
const path = require('node:path');
const { runScript } = require('./fixpr-launch.cjs');
const { failureCount } = require('./fixpr-after.cjs');

function parseArgs(argv) {
  const args = { run: '', verify: 'yes' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'run') args.run = m[2];
    else if (m[1] === 'verify') args.verify = m[2].trim();
    else unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --run, --verify).`);
  if (!args.run) throw new Error('--run is required.');
  return args;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const short = (sha) => (sha ? String(sha).slice(0, 9) : '—');

function landingText(t) {
  const l = t.landingResult;
  if (t.landing !== 'hold') return t.landing === 'keep-base' ? 'na bazie (keep-base)' : 'rebase na bazę';
  if (!l) return 'nie przeniesiona';
  if (l.status === 'landed') return `przeniesiona na ${(t.stack && t.stack.parent) || 'rodzica'}`;
  if (l.status === 'noop') return `bez zmian: już siedziała na ${(t.stack && t.stack.parent) || 'rodzicu'}`;
  if (t.outcome && t.outcome.landedBy === 'landing') return `przeniesiona przez agenta (${l.mode || l.status})`;
  return `zatrzymana: ${l.status}`;
}

// `stackImpact`, one line per name. On 2026-11-18 each use was printed as `<branch>:<full repo
// path>:<line>`, and the same file:line of part-3..7 five times over came to about 9 kB for this
// one section. Here a name's uses are grouped by the parts they sit in (`part-3..7`, with the
// prefix every branch shares said once in the heading), each path is cut to the shortest tail no
// other path of the section shares, and a long list ends in "+N" naming the result file that holds
// every use in full - nothing leaves the files, only the repetition leaves the summary.
const impactCaps = { uses: 6, names: 15 };

function impactLines(entries, caps = impactCaps) {
  const parse = (use) => {
    const m = String(use).match(/^([^:]+):(.+?)(?::(\d+))?$/);
    return m ? { branch: m[1], path: m[2], line: m[3] || '' } : { branch: '', path: String(use), line: '' };
  };
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.symbol}\u0000${e.change}`;
    if (!groups.has(key)) groups.set(key, { symbol: e.symbol, change: e.change, prs: [], files: [], uses: [] });
    const g = groups.get(key);
    if (!g.prs.includes(e.pr)) g.prs.push(e.pr);
    if (!g.files.includes(e.resultFile)) g.files.push(e.resultFile);
    g.uses.push(...(e.usedIn || []).map(parse));
  }
  const all = [...groups.values()].flatMap((g) => g.uses);
  const tails = distinctTails([...new Set(all.map((u) => u.path))]);
  const branchNames = [...new Set(all.map((u) => u.branch).filter(Boolean))];
  const prefix = branchNames.length > 1 ? sharedPrefix(branchNames) : '';
  const lines = [];
  const list = [...groups.values()];
  for (const g of list.slice(0, caps.names)) {
    // A location (tail:line) per set of parts that use it: one file:line used by part-3..7 reads once.
    const byLocation = new Map();
    for (const u of g.uses) {
      const where = `${tails.get(u.path) || u.path}${u.line ? `:${u.line}` : ''}`;
      if (!byLocation.has(where)) byLocation.set(where, new Set());
      if (u.branch) byLocation.get(where).add(u.branch.slice(prefix.length));
    }
    const byParts = new Map();
    for (const [where, parts] of byLocation) {
      const label = partRanges([...parts]);
      if (!byParts.has(label)) byParts.set(label, []);
      byParts.get(label).push(where);
    }
    const shown = [];
    let count = 0;
    let hidden = 0;
    for (const [label, wheres] of byParts) {
      const room = caps.uses - count;
      if (room <= 0) { hidden += wheres.length; continue; }
      const take = wheres.slice(0, room);
      hidden += wheres.length - take.length;
      count += take.length;
      shown.push(`${take.join(', ')}${label ? ` (${label})` : ''}`);
    }
    const more = hidden ? `; +${hidden} więcej: ${g.files.join(', ')}` : '';
    lines.push(`- ${g.prs.join(', ')} \`${g.symbol}\`: ${g.change} — używane w: ${shown.join('; ') || '—'}${more}`);
  }
  if (list.length > caps.names) {
    const files = [...new Set(list.slice(caps.names).flatMap((g) => g.files))];
    lines.push(`- +${list.length - caps.names} kolejnych nazw: ${files.join(', ')}`);
  }
  return { lines, prefix };
}

// The shortest run of trailing path segments that no other path of the list ends in.
function distinctTails(paths) {
  const split = paths.map((p) => p.split(/[\\/]/));
  const out = new Map();
  split.forEach((segments, i) => {
    for (let n = 1; n <= segments.length; n++) {
      const tail = segments.slice(-n).join('/');
      const clash = split.some((other, j) => j !== i && (other.length >= n && other.slice(-n).join('/') === tail));
      if (!clash || n === segments.length) { out.set(paths[i], tail); break; }
    }
  });
  return out;
}

// What every branch name begins with, cut back to a separator so a bare number is never what is
// left (`TEAM-1-part-3`, `TEAM-1-part-7` → `TEAM-1-`, leaving `part-3`, `part-7`).
function sharedPrefix(names) {
  const lastSep = (s) => Math.max(s.lastIndexOf('-'), s.lastIndexOf('/'), s.lastIndexOf('_'));
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.slice(0, lastSep(prefix) + 1);
  if (names.some((n) => /^\d+$/.test(n.slice(prefix.length)))) prefix = prefix.slice(0, lastSep(prefix.slice(0, -1)) + 1);
  return names.every((n) => n.length > prefix.length) ? prefix : '';
}

// `part-3, part-4, part-5, part-7` → `part-3..5, part-7`: consecutive numbers of one stem as a range.
function partRanges(parts) {
  const stems = new Map();
  const plain = [];
  for (const p of parts) {
    const m = p.match(/^(.*?)(\d+)$/);
    if (!m) { plain.push(p); continue; }
    if (!stems.has(m[1])) stems.set(m[1], []);
    stems.get(m[1]).push(Number(m[2]));
  }
  const out = [];
  for (const [stem, numbers] of stems) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
      out.push(j > i ? `${stem}${sorted[i]}..${sorted[j]}` : `${stem}${sorted[i]}`);
      i = j + 1;
    }
  }
  return [...out, ...plain.sort()].join(', ');
}

// What CI said about the pushed commit (ci-status.cjs, `<checksDir>/ci-status.json`): green, red
// with the lines that say why, or still running. Nothing when CI was never asked.
const ciShown = 8;

function ciText(pr, t) {
  const s = t.checksDir ? readJson(path.join(t.checksDir, 'ci-status.json')) : null;
  if (!s) return null;
  const at = `\`${short(s.sha)}\``;
  if (s.state === 'success') return [`- ${pr} ${at}: CI zielone`];
  if (s.state === 'pending') return [`- ${pr} ${at}: CI nadal trwa (${(s.pending || []).join(', ') || 'start'})`];
  if (s.state === 'none') return [`- ${pr} ${at}: CI nie zgłosiło żadnego statusu`];
  if (s.state === 'error') return [`- ${pr} ${at}: CI nieodczytane: ${s.error || 'błąd'}`];
  const out = [];
  for (const f of s.failed || [{ name: 'CI' }]) {
    out.push(`- ${pr} ${at}: CI czerwone — ${f.name}${f.description ? ` (${f.description})` : ''}${f.url ? `: ${f.url}` : ''}`);
    const lines = f.lines || [];
    for (const line of lines.slice(0, ciShown)) out.push(`  - \`${line.replace(/`/g, "'")}\``);
    if (lines.length > ciShown) out.push(`  - … ${lines.length - ciShown} więcej${f.log ? ` w ${f.log}` : ''}`);
    if (f.logError) out.push(`  - log niedostępny: ${f.logError}`);
  }
  return out;
}

function render(options, deps = {}) {
  const run = deps.run || runScript;
  const data = JSON.parse(fs.readFileSync(options.run, 'utf8'));
  const targets = data.targets || [];
  const lines = ['## fixPr — podsumowanie', '', '| PR | Commit | Lądowanie | Push | Naprawione / odrzucone / bez akcji |', '|---|---|---|---|---|'];
  const rejected = [];
  const answered = [];
  const look = [];
  const impact = [];
  const visual = [];
  const gate = [];
  const ci = [];
  const checks = [];
  const review = [];
  const notes = [];
  const local = [];
  // The main checkout's node_modules lost during a worktree's removal (fixpr-after.cjs), or found
  // broken by a launch (worktree.cjs mainBroken): the user's to repair before anything else runs.
  const modules = [];
  for (const t of targets) {
    const r = readJson(`${t.reportPath}.result.json`) || {};
    const o = t.outcome || {};
    const pr = `#${t.pr.number}`;
    lines.push(`| ${pr} ${t.pr.title || t.branch} | ${o.commit ? `\`${short(o.commit)}\` ${o.commitMessage || ''}` : 'brak'} | ${landingText(t)} | ${o.pushed ? 'tak' : 'nie'} | ${r.fixed || 0} / ${r.rejected || 0} / ${r.answered || 0} |`);
    for (const v of r.verdicts || []) {
      if (v.verdict === 'rejected') rejected.push(`- ${pr} ${v.item} — ${v.ground || 'bez uzasadnienia'}`);
      if (v.verdict === 'answered' && v.ground) answered.push(`- ${pr} ${v.item} — ${v.ground}`);
    }
    if (t.local) {
      const fixed = new Set(r.fixedFindingIds || []);
      const all = (r.verdicts || []).filter((v) => String(v.item).startsWith('finding:')).map((v) => v.item.slice(8));
      local.push(`- ${pr}: naprawione ${fixed.size}${all.filter((id) => !fixed.has(id)).length ? `; nie naprawione: ${all.filter((id) => !fixed.has(id)).join(', ')}` : ''}`);
    }
    for (const u of r.uiUnverified || []) look.push(`- ${pr} \`${u.path}\` (${u.item})`);
    for (const s of r.stackImpact || []) impact.push({ pr, resultFile: `${t.reportPath}.result.json`, ...s });
    for (const v of r.visualChecks || []) visual.push(`- ${pr} ${v.item}: ${v.result}${v.reason ? ` (${v.reason})` : ''}${v.mocked ? ', dane z fixture' : ''}${v.screenshot ? ` — ${v.screenshot}` : ''}`);
    const red = (r.verification || []).filter((v) => v.result === 'failed');
    // `green-no-tests`: committed on a gate that ran no unit test - said here, never read as green.
    const untested = r.gate === 'green-no-tests' || (t.landingResult && t.landingResult.gate === 'green-no-tests');
    gate.push(`- ${pr}: naprawione: ${(r.checksFixed || []).join(', ') || '—'}${red.length ? `; czerwone: ${red.map((v) => `${v.label} (${v.logPath || 'brak logu'})`).join(', ')}` : ''}${untested ? '; testy jednostkowe NIE uruchomione (gate nie zna komendy testów: `.claude/doh/checks.json`)' : ''}`);
    const ciLine = ciText(pr, t);
    if (ciLine) ci.push(...ciLine);
    if (o.verify) {
      checks.push(o.verify.ok
        ? `- ${pr}: wszystkie ${o.verify.total || ''} komentarze obsłużone`.replace('  ', ' ')
        : `- ${pr}: kontrola niepełna — luki: ${Object.entries(o.verify.gaps || {}).map(([k, n]) => `${k} ${n}`).join(', ') || o.verify.missing || 'brak wyniku'}`);
    }
    if (o.resolve && o.resolve.resolved !== undefined) {
      const rs = o.resolve;
      // Grouped by fixpr-after.cjs: one `{ error, count, ids }` per distinct error; each error is said
      // once. A resolve run again (fixpr-after.cjs --resolve-only) says so: the state is the final one.
      const failed = failureCount(rs.failed);
      const replies = failureCount(rs.replyFailed);
      const errors = [...new Set([...(rs.failed || []), ...(rs.replyFailed || [])].map((f) => f && f.error).filter(Boolean))];
      checks.push(`- ${pr}: rozwiązane wątki ${rs.resolved}${rs.alreadyResolved ? ` (w tym wcześniej: ${rs.alreadyResolved})` : ''}${(rs.unverified || []).length ? `, otwarte (commit nie zmienia ich plików): ${rs.unverified.length}` : ''}${failed ? `, nieudane: ${failed}` : ''}${replies ? `, odpowiedzi nieudane: ${replies}` : ''}${errors.length ? ` — ${errors.join('; ')}` : ''}${rs.resolveOnly ? `; ponowione ${String(rs.resolveOnly).slice(0, 16).replace('T', ' ')}` : ''}`);
    } else if (o.resolve && o.resolve.skipped && /^not pushed/.test(o.resolve.skipped)) checks.push(`- ${pr}: wątki nie rozwiązane - commit nie jest na origin`);
    if (r.reviewReport || (o.keptReports || []).length) review.push(`- ${pr}: ${(o.keptReports || [])[0] || r.reviewReport} — naprawione ${r.reviewFindingsFixed || 0}, pozostawione ${r.reviewFindingsLeft || 0}`);
    if (t.heldBy) notes.push(`- ${pr}: gałąź była wybrana w \`${t.heldBy}\` — uruchom tam \`git pull --rebase\`.`);
    if (o.mainModulesLost) modules.push(`- ${pr}: ${o.mainModulesLost}`);
    else if (t.launch && t.launch.mainBroken) modules.push(`- ${pr}: ${typeof t.launch.mainBroken === 'string' ? t.launch.mainBroken : 'node_modules głównego checkoutu jest niekompletne lub go brak'}`);
    // A fix agent spawned again (--resume) built on the stopped agent's commit: both are on the branch.
    if ((r.priorCommits || []).length) {
      const named = r.priorCommits.map((c) => String(c).match(/^(\S+)\s*(.*)$/) || [c, String(c), '']).map(([, sha, message]) => `\`${short(sha)}\`${message ? ` ${message}` : ''}`);
      notes.push(`- ${pr}: zbudowane na commicie przerwanego agenta: ${named.join(', ')}`);
    }
    if (o.keptWorktree) notes.push(`- ${pr}: worktree zostało: \`${o.keptWorktree.path}\` (${o.keptWorktree.reason}).`);
  }
  const section = (title, items) => (items.length ? ['', `### ${title}`, ...items] : []);
  lines.push(...section('node_modules głównego checkoutu — napraw przed kolejnym uruchomieniem', modules));
  lines.push(...section('Odrzucone (do decyzji)', rejected));
  lines.push(...section('Bez akcji', answered));
  lines.push(...section('Findingi --local', local));
  lines.push(...section('Kontrola komentarzy i wątków', checks));
  lines.push(...section('Self-review (codeReview staged)', review));
  const grouped = impactLines(impact);
  lines.push(...section(`Zmiany używane przez wyższe części${grouped.prefix ? ` (gałęzie ${grouped.prefix}…)` : ''}`, grouped.lines));
  lines.push(...section('Do obejrzenia ręcznie', look));
  lines.push(...section('Sprawdzenie wizualne', visual));
  lines.push(...section('Gate', gate));
  lines.push(...section('CI', ci));
  const stacks = (data.stacks || []).filter((s) => s.length > 1).map((s) => `- ${s.join(' ← ')}`);
  if (options.verify === 'yes' && stacks.length) {
    const verified = run(path.join(__dirname, 'restack.cjs'), ['--action=verify', `--run=${options.run}`]) || {};
    for (const b of verified.broken || []) stacks.push(`- ${b.child} nie siedzi na ${b.parent}: \`${b.command}\` — albo \`/doh:restack ${b.child}\``);
  }
  lines.push(...section('Stos', stacks));
  lines.push(...section('Uwagi', notes));
  return `${lines.join('\n')}\n`;
}

function main() {
  try {
    process.stdout.write(render(parseArgs(process.argv.slice(2))));
    process.exit(0);
  } catch (err) {
    process.stdout.write(`fixpr-summary: ${(err && err.message) || err}\n`);
    process.exit(1);
  }
}

module.exports = { parseArgs, render, impactLines, distinctTails, sharedPrefix, partRanges };

if (require.main === module) main();
