'use strict';

// Scores a markdown review of `test-environment/` against `test-key/answer-key.json`,
// so the dev loop learns what a review found and missed without anyone reading the
// key: the orchestrator that ran the review never opens it, and this script prints a
// summary short enough for its context.
//
// The match is heuristic - the key has no line numbers, and the report is written in
// another language - so it rests on what both sides must share: the file, the
// instruction, and the code identifiers the key names in backticks. A finding counts
// toward the one entry it scores best against; an entry is found when any finding
// counts toward it. Findings under a different instruction are still matched when
// they share two identifiers, and reported separately as a wrong rule.
//
// Usage: node score-review.cjs --report <review.md> [--key <answer-key.json>] [--limit N] [--json]

const fs = require('node:fs');
const path = require('node:path');
const { parseReport } = require('./render-report.cjs');

const defaultKey = path.join(__dirname, '..', 'test-key', 'answer-key.json');

// Words every entry of this environment shares - matching on them would pair
// anything with anything.
const genericWords = new Set([
  'user', 'users', 'panel', 'component', 'components', 'spec', 'specs', 'state', 'test', 'tests',
  'html', 'scss', 'json', 'true', 'false', 'null', 'undefined', 'this', 'const', 'string', 'number',
  'void', 'return', 'import', 'export', 'from', 'feature', 'shared', 'models', 'index', 'service',
]);

function wordsOf(text) {
  const words = new Set();
  for (const word of String(text).toLowerCase().match(/[a-z_$][\w$]*/g) || []) {
    if (word.length >= 4 && !genericWords.has(word)) words.add(word);
  }
  return words;
}

// The key side is narrow on purpose: only what it quotes as code.
function keyIdentifiers(text) {
  const words = new Set();
  for (const [, token] of String(text).matchAll(/`([^`]+)`/g)) {
    for (const word of wordsOf(token)) words.add(word);
  }
  return words;
}

function sameFile(reportPath, keyFile) {
  const normalized = reportPath.replace(/\\/g, '/');
  return normalized === keyFile || normalized.endsWith(`/${keyFile}`);
}

function instructionsOf(finding) {
  const ids = new Set();
  for (const tag of finding.tags || []) {
    if (tag.address) ids.add(tag.address.id);
    else if (/\.md$/.test(tag.file)) ids.add(path.basename(tag.file, '.md'));
  }
  return ids;
}

// Score of one report finding against one key entry, or null when they are not the
// same defect. `wrongRule` marks a match that rests on identifiers alone.
function scoreAgainst(finding, entry) {
  const shared = [...entry.identifiers].filter((word) => finding.words.has(word)).length;
  const ruled = entry.instructions.some((id) => finding.instructions.has(id));
  if (ruled && (shared > 0 || entry.identifiers.size === 0)) return { score: 2 + shared, wrongRule: false };
  if (!ruled && shared >= 2) return { score: shared, wrongRule: true };
  return null;
}

function score(report, key) {
  const findings = [];
  for (const section of report.files) {
    for (const finding of section.findings) {
      findings.push({
        file: section.path,
        lines: finding.lines,
        severity: finding.severity,
        rule: finding.rule,
        problem: finding.problem,
        instructions: instructionsOf(finding),
        words: wordsOf([finding.problem, finding.expected, finding.rule, finding.prProblem].join(' ')),
      });
    }
  }
  const entries = [
    ...key.findings.map((entry) => ({ ...entry, kind: 'violation' })),
    ...key.crossFile.map((entry) => ({ ...entry, kind: 'cross-file', files: null, instructions: [] })),
  ].map((entry) => ({ ...entry, identifiers: keyIdentifiers(entry.text), hits: [] }));
  const baits = key.bait.map((entry) => ({ ...entry, identifiers: keyIdentifiers(entry.text), hits: [] }));

  const unmatched = [];
  const wrongRule = [];
  const severityMismatches = [];
  for (const finding of findings) {
    let best = null;
    for (const entry of entries) {
      if (entry.files && !entry.files.some((file) => sameFile(finding.file, file))) continue;
      // A cross-file entry has no instruction and no file: identifiers only, and more of them.
      const result = entry.kind === 'cross-file'
        ? ((n) => (n >= 2 ? { score: n, wrongRule: false } : null))([...entry.identifiers].filter((w) => finding.words.has(w)).length)
        : scoreAgainst(finding, entry);
      if (result && (!best || result.score > best.score)) best = { entry, ...result };
    }
    if (!best) {
      unmatched.push(finding);
      continue;
    }
    best.entry.hits.push(finding);
    if (best.wrongRule) wrongRule.push({ finding, entry: best.entry });
    if (best.entry.severity && best.entry.severity !== finding.severity) {
      severityMismatches.push({ finding, entry: best.entry });
    }
  }

  // A finding no entry claims but that names what a bait entry says is compliant.
  const baitHits = [];
  for (const finding of unmatched) {
    for (const bait of baits) {
      if (bait.file && !sameFile(finding.file, bait.file)) continue;
      const shared = [...bait.identifiers].filter((word) => finding.words.has(word)).length;
      if (shared >= (bait.file ? 1 : 2)) {
        baitHits.push({ finding, bait });
        break;
      }
    }
  }

  const violations = entries.filter((entry) => entry.kind === 'violation');
  const crossFile = entries.filter((entry) => entry.kind === 'cross-file');
  const byInstruction = new Map();
  for (const entry of violations) {
    for (const id of entry.instructions) {
      const row = byInstruction.get(id) || { found: 0, total: 0 };
      row.total += 1;
      if (entry.hits.length) row.found += 1;
      byInstruction.set(id, row);
    }
  }
  return {
    findings: findings.length,
    matched: findings.length - unmatched.length,
    violations: { found: violations.filter((entry) => entry.hits.length).length, total: violations.length },
    crossFile: { found: crossFile.filter((entry) => entry.hits.length).length, total: crossFile.length },
    byInstruction,
    misses: violations.filter((entry) => !entry.hits.length),
    unmatched,
    wrongRule,
    severityMismatches,
    baitHits,
    reportWarnings: report.warnings.length,
  };
}

const percent = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '-');
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const where = (finding) => `${finding.file.replace(/^.*?test-environment\//, '')}:${finding.lines || '?'}`;

function formatScore(result, limit) {
  const out = [];
  out.push(`recall: ${result.violations.found}/${result.violations.total} violations (${percent(result.violations.found, result.violations.total)}), cross-file ${result.crossFile.found}/${result.crossFile.total}`);
  out.push(`precision: ${result.matched}/${result.findings} findings matched a key entry (${percent(result.matched, result.findings)}); ${result.wrongRule.length} under a different instruction`);
  out.push(`bait hits: ${result.baitHits.length}`);
  for (const { finding, bait } of result.baitHits.slice(0, limit)) {
    out.push(`  ${bait.id} ${where(finding)} ${clip(finding.problem, 90)}`);
  }
  out.push(`severity mismatches: ${result.severityMismatches.length}`);
  for (const { finding, entry } of result.severityMismatches.slice(0, limit)) {
    out.push(`  ${entry.id} expected ${entry.severity}, got ${finding.severity} at ${where(finding)}`);
  }
  const weakest = [...result.byInstruction.entries()]
    .map(([id, row]) => ({ id, ...row }))
    .sort((a, b) => a.found / a.total - b.found / b.total || b.total - a.total)
    .slice(0, limit);
  out.push(`weakest instructions: ${weakest.map((row) => `${row.id} ${row.found}/${row.total}`).join(', ')}`);
  out.push(`misses (first ${Math.min(limit, result.misses.length)} of ${result.misses.length}):`);
  for (const entry of result.misses.slice(0, limit)) {
    out.push(`  ${entry.id} ${entry.files[0]} [${entry.instructions.join('+')}] ${clip(entry.text, 90)}`);
  }
  out.push(`unmatched findings (first ${Math.min(limit, result.unmatched.length)} of ${result.unmatched.length}):`);
  for (const finding of result.unmatched.slice(0, limit)) {
    out.push(`  ${where(finding)} [${[...finding.instructions].join('+') || clip(finding.rule, 30)}] ${clip(finding.problem, 90)}`);
  }
  if (result.reportWarnings) out.push(`report parser warnings: ${result.reportWarnings}`);
  return out.join('\n');
}

function main(argv) {
  const args = { key: defaultKey, limit: 15, json: false, report: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--report') args.report = argv[++i];
    else if (arg === '--key') args.key = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--json') args.json = true;
  }
  if (!args.report) {
    process.stderr.write('usage: node score-review.cjs --report <review.md> [--key <answer-key.json>] [--limit N] [--json]\n');
    return 2;
  }
  const report = parseReport(fs.readFileSync(args.report, 'utf8'));
  const key = JSON.parse(fs.readFileSync(args.key, 'utf8'));
  const result = score(report, key);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ...result,
      byInstruction: Object.fromEntries(result.byInstruction),
      misses: result.misses.map((entry) => entry.id),
      unmatched: result.unmatched.map((finding) => `${where(finding)} ${finding.problem}`),
      wrongRule: result.wrongRule.map(({ finding, entry }) => `${entry.id} ${where(finding)}`),
      severityMismatches: result.severityMismatches.map(({ finding, entry }) => `${entry.id} ${entry.severity}->${finding.severity}`),
      baitHits: result.baitHits.map(({ finding, bait }) => `${bait.id} ${where(finding)}`),
    })}\n`);
  } else {
    process.stdout.write(`${formatScore(result, args.limit)}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { score, formatScore, keyIdentifiers, wordsOf };
