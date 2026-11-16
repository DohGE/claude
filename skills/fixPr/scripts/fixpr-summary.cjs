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
  if (t.outcome && t.outcome.landedBy === 'landing') return `przeniesiona przez agenta (${l.mode || l.status})`;
  return `zatrzymana: ${l.status}`;
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
  const checks = [];
  const review = [];
  const notes = [];
  const local = [];
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
    for (const s of r.stackImpact || []) impact.push(`- ${pr} \`${s.symbol}\`: ${s.change} — używane w: ${(s.usedIn || []).join(', ')}`);
    for (const v of r.visualChecks || []) visual.push(`- ${pr} ${v.item}: ${v.result}${v.reason ? ` (${v.reason})` : ''}${v.mocked ? ', dane z fixture' : ''}${v.screenshot ? ` — ${v.screenshot}` : ''}`);
    const red = (r.verification || []).filter((v) => v.result === 'failed');
    gate.push(`- ${pr}: naprawione: ${(r.checksFixed || []).join(', ') || '—'}${red.length ? `; czerwone: ${red.map((v) => `${v.label} (${v.logPath || 'brak logu'})`).join(', ')}` : ''}`);
    if (o.verify) {
      checks.push(o.verify.ok
        ? `- ${pr}: wszystkie ${o.verify.total || ''} komentarze obsłużone`.replace('  ', ' ')
        : `- ${pr}: kontrola niepełna — luki: ${Object.entries(o.verify.gaps || {}).map(([k, n]) => `${k} ${n}`).join(', ') || o.verify.missing || 'brak wyniku'}`);
    }
    if (o.resolve && o.resolve.resolved !== undefined) checks.push(`- ${pr}: rozwiązane wątki ${o.resolve.resolved}${(o.resolve.unverified || []).length ? `, otwarte (commit nie zmienia ich plików): ${o.resolve.unverified.length}` : ''}${(o.resolve.failed || []).length ? `, nieudane: ${o.resolve.failed.length}` : ''}`);
    if (r.reviewReport || (o.keptReports || []).length) review.push(`- ${pr}: ${(o.keptReports || [])[0] || r.reviewReport} — naprawione ${r.reviewFindingsFixed || 0}, pozostawione ${r.reviewFindingsLeft || 0}`);
    if (t.heldBy) notes.push(`- ${pr}: gałąź była wybrana w \`${t.heldBy}\` — uruchom tam \`git pull --rebase\`.`);
    if (o.keptWorktree) notes.push(`- ${pr}: worktree zostało: \`${o.keptWorktree.path}\` (${o.keptWorktree.reason}).`);
  }
  const section = (title, items) => (items.length ? ['', `### ${title}`, ...items] : []);
  lines.push(...section('Odrzucone (do decyzji)', rejected));
  lines.push(...section('Bez akcji', answered));
  lines.push(...section('Findingi --local', local));
  lines.push(...section('Kontrola komentarzy i wątków', checks));
  lines.push(...section('Self-review (codeReview staged)', review));
  lines.push(...section('Zmiany używane przez wyższe części', impact));
  lines.push(...section('Do obejrzenia ręcznie', look));
  lines.push(...section('Sprawdzenie wizualne', visual));
  lines.push(...section('Gate', gate));
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

module.exports = { parseArgs, render };

if (require.main === module) main();
