#!/usr/bin/env node
'use strict';

// Posts the findings of a rendered codeReview HTML report as a PR review.
// The report page cannot talk to GitHub itself (a file:// page has no
// credentials), so the button there only assembles the command that runs this
// script - which reads the very same payload the page renders from.

const fs = require('node:fs');
const path = require('node:path');

const github = require('./github.cjs');
const { parseLineRanges } = require('./render-report.cjs');

const maxCommentsPerReview = 50;

function parseArgs(argv) {
  const args = { report: '', project: '', pr: '', exclude: [], dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'report') args.report = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'pr') args.pr = m[2];
    else if (m[1] === 'exclude') args.exclude = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!args.report) throw new Error('No report given (expected --report="path/to/report.html").');
  return args;
}

function parsePayload(html) {
  const match = String(html).match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('The file carries no report payload - is it a rendered codeReview HTML report?');
  return JSON.parse(match[1]);
}

// GitHub only accepts an inline comment on a line the diff actually shows, so
// the RIGHT side of every hunk (added and context lines) is what can be
// commented on. Everything else has to travel in the review body.
function commentableLines(diffText) {
  const byPath = new Map();
  let current = null;
  let cursor = 0;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    const header = line.match(/^\+\+\+ (.*)$/);
    if (header) {
      // A deleted file has no right side (`+++ /dev/null`); leaving `current`
      // pointing at the previous file would file its lines under that path.
      const name = header[1].trim();
      current = name.startsWith('b/') ? new Set() : null;
      if (current) byPath.set(name.slice(2), current);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      cursor = Number(hunk[1]);
      continue;
    }
    if (!current || line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('+') || line.startsWith(' ')) {
      current.add(cursor);
      cursor++;
    }
  }
  return byPath;
}

function renderBody(finding, severityLabel) {
  return [
    `${severityLabel} — ${finding.problem}`,
    '',
    `**Reguła:** ${finding.rule}`,
    '',
    `**Oczekiwany stan:** ${finding.expected}`,
  ].join('\n');
}

// An inline comment needs a concrete anchor: the whole first cited range when
// every one of its lines is in the diff, otherwise the first line that is.
function anchorFor(finding, lines) {
  const ranges = parseLineRanges(finding.lines);
  if (!ranges.length || !lines) return null;
  const first = ranges[0];
  const whole = [];
  for (let n = first.start; n <= first.end; n++) whole.push(n);
  if (whole.length > 1 && whole.every((n) => lines.has(n))) {
    return { start_line: first.start, line: first.end };
  }
  for (const range of ranges) {
    for (let n = range.start; n <= range.end; n++) if (lines.has(n)) return { line: n };
  }
  return null;
}

function buildComments(findings, commentable, severityLabels) {
  const comments = [];
  const leftovers = [];
  for (const finding of findings) {
    const anchor = anchorFor(finding, commentable.get(finding.path));
    const body = renderBody(finding, severityLabels[finding.severity] || finding.severity);
    if (!anchor) {
      leftovers.push(finding);
      continue;
    }
    comments.push(Object.assign({ path: finding.path, side: 'RIGHT', body }, anchor));
  }
  return { comments, leftovers };
}

function summaryBody(payload, comments, leftovers, severityLabels) {
  const head = [
    `## Code review — ${payload.title}`,
    '',
    `Komentarzy w kodzie: **${comments.length}**.`,
  ];
  if (!leftovers.length) return head.join('\n');
  head.push(
    '',
    `Poniższe znaleziska dotyczą linii spoza diffu PR-a, więc nie dało się ich przypiąć do kodu (**${leftovers.length}**):`,
    '',
  );
  let lastPath = '';
  for (const finding of leftovers) {
    if (finding.path !== lastPath) {
      head.push('', `**${finding.path}**`);
      lastPath = finding.path;
    }
    head.push(`- \`${finding.lines}\` ${severityLabels[finding.severity] || finding.severity} — ${finding.problem}`);
  }
  return head.join('\n');
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// `api` is the GitHub client, injectable so the tests can drive the whole flow
// without a network.
function main(argv, api = github) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    return 1;
  }
  const project = path.resolve(args.project || path.dirname(args.report));
  let payload;
  try {
    payload = parsePayload(fs.readFileSync(args.report, 'utf8'));
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    return 1;
  }

  const severityLabels = {};
  (payload.severities || []).forEach((s) => { severityLabels[s.key] = `${s.emoji} **${s.label}**`; });
  const excluded = new Set(args.exclude);
  const findings = [];
  for (const file of payload.files || []) {
    for (const finding of file.findings || []) {
      if (excluded.has(finding.id)) continue;
      findings.push(Object.assign({ path: file.path }, finding));
    }
  }
  if (!findings.length) {
    process.stderr.write('Brak znalezisk do wysłania (wszystkie ukryte?).\n');
    return 1;
  }

  const number = args.pr || (payload.pr && payload.pr.number);
  if (!number) {
    process.stderr.write('Nie znam numeru PR-a (podaj --pr=<numer>).\n');
    return 1;
  }

  const slug = api.repoSlug(project);
  if (!slug) {
    process.stderr.write(`Nie znalazłem remote'a GitHuba w ${project}.\n`);
    return 1;
  }
  const repo = `${slug.owner}/${slug.repo}`;
  const { diff, error } = api.pullRequestDiff(project, slug, number);
  if (diff === null) {
    process.stderr.write(`Nie udało się pobrać diffa PR-a #${number} z API GitHuba: ${error}\n`);
    return 1;
  }

  const { comments, leftovers } = buildComments(findings, commentableLines(diff), severityLabels);
  const batches = chunk(comments, maxCommentsPerReview);
  const bodies = batches.length ? batches.map((_, i) => (i === 0
    ? summaryBody(payload, comments, leftovers, severityLabels)
    : `Code review — ciąg dalszy (${i + 1}/${batches.length}).`))
    : [summaryBody(payload, comments, leftovers, severityLabels)];

  if (args.dryRun) {
    process.stdout.write(`${repo} PR #${number}: ${comments.length} komentarzy w kodzie, ${leftovers.length} w podsumowaniu, ${batches.length || 1} review.\n`);
    return 0;
  }

  for (let i = 0; i < Math.max(batches.length, 1); i++) {
    const review = { event: 'COMMENT', body: bodies[i], comments: batches[i] || [] };
    const posted = api.postReview(project, slug, number, review);
    if (posted.error) {
      process.stderr.write(`Nie udało się wysłać review (partia ${i + 1}): ${posted.error}\n`);
      return 1;
    }
  }
  process.stdout.write(`Wysłano do ${repo} PR #${number}: ${comments.length} komentarzy w kodzie, ${leftovers.length} w podsumowaniu.\n`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  parseArgs, parsePayload, commentableLines, anchorFor, renderBody, buildComments, summaryBody, chunk, main,
};
