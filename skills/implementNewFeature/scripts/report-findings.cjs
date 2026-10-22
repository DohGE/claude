#!/usr/bin/env node
'use strict';

// Lists the findings of one doh:codeReview run for the review step, from whichever
// report that run left behind.
//
// The step used to pin every run to `--only-md` and Read the Markdown whole. The form
// now sets each run's flags, and without `--only-md` the skill renders an HTML page and
// deletes the Markdown it rendered from - keeping it only when its parser warned. The
// page is the wrong thing to Read: beside the findings it carries the code snippets,
// the whole-file views and its own script. Its findings sit as JSON in one element, so
// this prints those alone, in the shape a Markdown report gives too - one short list
// whatever the user ticked, `--with-checklist` included.

const fs = require('node:fs');

const { parseReport } = require('../../codeReview/scripts/render-report.cjs');

// The element render-report.cjs writes the page's payload into.
const reportData = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/;

function parseArgs(argv) {
  const args = { report: '', html: '' };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'report') args.report = m[2];
    else if (m[1] === 'html') args.html = m[2];
    else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --report, --html).`);
  }
  // The context JSON's htmlReportPath is null on an `--only-md` run, and an agent
  // passing it through hands over the word.
  if (args.html === 'null') args.html = '';
  if (!args.report && !args.html) throw new Error('No report given (expected --report=<reportPath> and --html=<htmlReportPath>).');
  return args;
}

const exists = (p) => Boolean(p) && fs.existsSync(p);

function findingsOf(options) {
  const result = { source: null, emptyState: null, skipped: [], count: 0, findings: [], errors: [] };
  let report;
  // The Markdown first: when both exist the renderer kept it because its parser
  // warned, and the page it rendered then may have lost a finding.
  if (exists(options.report)) {
    report = parseReport(fs.readFileSync(options.report, 'utf8'));
    result.source = options.report;
  } else if (exists(options.html)) {
    const match = fs.readFileSync(options.html, 'utf8').match(reportData);
    if (!match) {
      result.errors.push(`${options.html} carries no report payload - is it a rendered codeReview report?`);
      return result;
    }
    report = JSON.parse(match[1]);
    result.source = options.html;
  } else {
    result.errors.push(`Neither report exists: ${[options.report, options.html].filter(Boolean).join(', ')}.`);
    return result;
  }
  result.emptyState = report.emptyState || null;
  result.skipped = report.skipped || [];
  for (const file of report.files || []) {
    for (const f of file.findings || []) {
      result.findings.push({
        file: file.path, severity: f.severity, lines: f.lines, problem: f.problem, rule: f.rule, expected: f.expected,
      });
    }
  }
  result.count = result.findings.length;
  return result;
}

function main() {
  let result;
  try {
    result = findingsOf(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { count: 0, findings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, findingsOf };

if (require.main === module) main();
