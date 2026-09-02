#!/usr/bin/env node
'use strict';

// Renders an assembled codeReview Markdown report into a self-contained,
// interactive HTML page. The Markdown produced by SKILL.md Steps 3-4 stays the
// intermediate representation; this script parses it and is the only place that
// knows about the HTML output.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const github = require('./github.cjs');

// Order is the display order and the sort rank of the flat global list.
// `missing-unit-test` sorts last: it is orthogonal to the severity ladder, and
// Step 4 already lists it last within a file.
const severities = [
  { emoji: '🟤', key: 'critical', label: 'Critical' },
  { emoji: '🔴', key: 'high', label: 'High' },
  { emoji: '🟡', key: 'medium', label: 'Medium' },
  { emoji: '⚪', key: 'low', label: 'Low' },
  { emoji: '🔵', key: 'missing-unit-test', label: 'Missing Unit Test' },
];
const severityByEmoji = new Map(severities.map((s) => [s.emoji, s]));

const emptyBodies = ['Nie wykryto problemów.', 'Nie wykryto zmian do analizy.'];
const skippedPrefix = 'Pominięto pliki wygenerowane/binarne:';
const noFileLabel = '(bez pliku)';
const fields = {
  'Linia': 'lines', 'Problem': 'problem', 'Reguła': 'rule', 'Expected Result': 'expected',
  // English wording used only for the PR comment - the report itself stays Polish.
  'PR Problem': 'prProblem', 'PR Expected': 'prExpected', 'PR Locations': 'prLocations',
};

// The severity lead line is accepted with and without a leading `- `: the
// no-dash form is the current Step 4 rule, the dashed form is what every report
// written before it looks like.
const reHeader = /^#\s+(.+?)\s+\|\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*$/;
const reSection = /^##\s+(.+?)\s*$/;
const reSeverity = /^(?:-\s+)?(⚪|🟡|🔴|🟤|🔵)\uFE0F?\s*\*\*(.+?)\*\*\s*$/;
const reField = /^-\s+\*\*(Linia|Problem|Reguła|Expected Result|PR Problem|PR Expected|PR Locations):\*\*\s?(.*)$/;
// Per-file coverage proof written by the reviewer: how many checklist items of
// that file's rulebook actually got a verdict, against how many exist - or
// `mechanical` for a file the mechanical-change gate narrowed to its two
// questions, which by design never walks the full checklist.
const reCoverage = /^<!--\s*coverage:\s*(\S+)\s+(mechanical|\d+\s*\/\s*\d+)\s*-->$/;
// The ticked checklist behind that marker: one multi-line comment per analyzed
// file, opened by `<!-- checklist: <path>`, one item line each, closed by `-->`.
// `[x]` is an item the reviewer reached a verdict on, `[ ]` one it could not
// verify; the verdict word is what separates a clean item from a reported one.
const reChecklistOpen = /^<!--\s*checklist:\s*(\S+)\s*$/;
const reChecklistItem = /^\[([ xX])\]\s+([a-z0-9][a-z0-9-]*)#(\d+)\s+(.+)$/;
const reViolationVerdict = /(^|[^\p{L}])NARUSZENIE([^\p{L}]|$)/u;
// What a bare instruction reference - or the violated point's name, which Step 4
// allows instead - may consist of. Quotes, backticks and brackets, or anything
// longer than a name, mean the arrow belongs to quoted rule text.
const reInstructionName = /^[\p{L}\p{N} ,._/-]{1,40}$/u;

function parseArgs(argv) {
  const args = { report: '', out: '', project: '', mode: '', base: '', branch: '', keepSource: false };
  for (const arg of argv) {
    if (arg === '--keep-source') {
      args.keepSource = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'report') args.report = m[2];
    else if (m[1] === 'out') args.out = m[2];
    else if (m[1] === 'project') args.project = m[2];
    else if (m[1] === 'mode') args.mode = m[2];
    else if (m[1] === 'base') args.base = m[2];
    else if (m[1] === 'branch') args.branch = m[2];
  }
  if (!args.report) throw new Error('No report given (expected --report="path/to/report.md").');
  if (!args.out) args.out = args.report.replace(/\.md$/i, '') + '.html';
  return args;
}

// Code snippets are read from the working tree, so the renderer needs the root
// the report's paths are relative to. Reports live in `<project>/.claude/doh/
// <branch>/`, which makes the root recoverable when `--project` is absent.
function projectRootFor(reportPath, explicit) {
  if (explicit) return path.resolve(explicit);
  const parts = path.resolve(path.dirname(reportPath)).split(path.sep);
  const at = parts.lastIndexOf('.claude');
  if (at > 0 && parts[at + 1] === 'doh') return parts.slice(0, at).join(path.sep);
  return process.cwd();
}

// A bare left side may name several instructions (`component/performance`), but
// it may just as well be prose that happens to contain a slash (`Kroki 3/4`).
// Only a split whose every piece is a single word is a real list of names.
function splitInstructionNames(left) {
  const whole = left.trim();
  const pieces = whole.split(/[/,]/).map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length > 1 && pieces.every((piece) => !/\s/.test(piece))) return pieces;
  return whole ? [whole] : [];
}

// `**Reguła:**` carries one or more `<instruction files> → <rule text>` segments
// separated by `;`. Each instruction file named on the left becomes its own tag
// sharing the segment's rule text, which is what feeds the two-level filter.
function parseRuleField(value) {
  const tags = [];
  const segments = String(value || '').split(';').map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const arrow = segment.match(/\s*(?:→|->)\s*/);
    if (!arrow) {
      // A `;` inside the rule text itself: fold the fragment back into the
      // previous rule instead of inventing a tag. Only a leading segment
      // without an arrow is a genuinely file-less rule.
      if (tags.length) tags[tags.length - 1].rule += `; ${segment}`;
      else tags.push({ file: noFileLabel, rule: segment });
      continue;
    }
    const left = segment.slice(0, arrow.index);
    const rule = segment.slice(arrow.index + arrow[0].length).trim();
    // Reports name the instruction either with its extension (`security.md`)
    // or bare (`state-interface`), and Step 4 also allows the violated point's
    // name instead. Explicit `.md` tokens win - they survive a path prefix and
    // pick several files out of one segment.
    const explicit = left.match(/[A-Za-z0-9._+-]+\.md/g);
    const trimmedLeft = left.trim();
    let names;
    if (explicit) names = explicit;
    else if (!trimmedLeft) names = [noFileLabel];
    else if (reInstructionName.test(trimmedLeft)) names = splitInstructionNames(left);
    else names = [];
    if (!names.length) {
      // The arrow belongs to the rule text: a quoted checklist item may contain
      // one, and a `;` in front of it must not turn that quote into a file.
      if (tags.length) tags[tags.length - 1].rule += `; ${segment}`;
      else tags.push({ file: noFileLabel, rule: segment.trim() });
      continue;
    }
    for (const file of names) tags.push({ file, rule });
  }
  return tags.filter((tag, i) => tags.findIndex((t) => t.file === tag.file && t.rule === tag.rule) === i);
}

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Content-derived so the same report always yields the same ids - that is what
// makes the browser's ignore list survive a re-render of the same file.
function findingId(filePath, finding) {
  return fnv1a(`${filePath}|${finding.severity}|${finding.lines}|${finding.rule}|${finding.problem}`);
}

// The coverage marker is a claim, the ticked checklist is the evidence behind
// it: every number the page shows is recounted from the ticks, and a marker the
// ticks do not back up becomes a warning - which keeps the Markdown next to the
// HTML, exactly like any other format drift.
function reconcileCoverage(report) {
  const blockOf = new Map();
  for (const entry of report.checklists) if (!blockOf.has(entry.path)) blockOf.set(entry.path, entry);
  const covered = new Set();
  for (const entry of report.coverage) {
    covered.add(entry.path);
    const block = blockOf.get(entry.path);
    entry.items = block ? block.items : [];
    entry.ticked = entry.items.filter((item) => item.ok).length;
    if (entry.mechanical) {
      if (block) report.warnings.push(`${entry.path}: plik oznaczony jako mechaniczny nie powinien mieć bloku checklisty.`);
      continue;
    }
    if (!block) {
      report.warnings.push(`${entry.path}: brak bloku checklisty - marker coverage nie ma pokrycia w odchaczonych pozycjach.`);
      continue;
    }
    if (entry.items.length !== entry.total) {
      report.warnings.push(`${entry.path}: checklista ma ${entry.items.length} z ${entry.total} pozycji - brakujące pozycje nie zostały przejrzane.`);
    }
    if (entry.ticked !== entry.checked) {
      report.warnings.push(`${entry.path}: marker coverage mówi o ${entry.checked} sprawdzonych pozycjach, a odchaczono ${entry.ticked}.`);
    }
  }
  for (const block of report.checklists) {
    if (covered.has(block.path)) continue;
    report.warnings.push(`${block.path}: checklista bez markera coverage.`);
    report.coverage.push({
      path: block.path,
      checked: block.items.filter((item) => item.ok).length,
      total: block.items.length,
      mechanical: false,
      items: block.items,
      ticked: block.items.filter((item) => item.ok).length,
    });
  }
}

function parseReport(markdown) {
  const report = { title: '', datetime: '', skipped: [], emptyState: null, files: [], coverage: [], checklists: [], warnings: [] };
  const lines = String(markdown).split(/\r?\n/);
  let section = null;
  let finding = null;
  let field = null;
  let headerSeen = false;
  // The multi-line comment currently being consumed: a checklist block when it
  // has a `path`, any other multi-line comment when it does not.
  let block = null;

  const openSection = (sectionPath) => {
    section = { path: sectionPath, findings: [] };
    report.files.push(section);
  };
  const closeFinding = () => {
    if (!finding) return;
    for (const [label, key] of Object.entries(fields)) {
      if (!finding[key]) report.warnings.push(`${section.path}: znalezisko bez pola "${label}".`);
    }
    finding.tags = parseRuleField(finding.rule);
    section.findings.push(finding);
    finding = null;
    field = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNo = i + 1;

    // Inside a multi-line comment nothing is report content: the block runs to
    // the line carrying `-->`, and only a checklist block keeps what it holds.
    if (block) {
      const end = line.indexOf('-->');
      const content = (end === -1 ? line : line.slice(0, end)).trim();
      if (content && block.path) {
        const item = content.match(reChecklistItem);
        if (item) {
          const text = item[4].trim();
          const ok = item[1] !== ' ';
          block.items.push({
            id: `${item[2]}#${item[3]}`,
            ok,
            text,
            state: !ok ? 'open' : (reViolationVerdict.test(text) ? 'violation' : 'ok'),
          });
        } else {
          report.warnings.push(`${block.path}: nierozpoznana pozycja checklisty w linii ${lineNo}: "${content}".`);
        }
      }
      if (end !== -1) block = null;
      continue;
    }
    if (!line) continue;

    if (!headerSeen) {
      headerSeen = true;
      const m = line.match(reHeader);
      if (m) {
        report.title = m[1];
        report.datetime = `${m[2]} ${m[3]}`;
      } else {
        report.warnings.push(`Linia ${lineNo}: nierozpoznany nagłówek raportu.`);
        report.title = line.replace(/^#\s*/, '');
      }
      continue;
    }

    // Comment lines carry the run's metadata (per-file coverage proof, the
    // since-last note) and never reach the HTML. They are matched before the
    // field/wrapped-value branches below, which would otherwise swallow a
    // marker written right after a finding.
    if (line.startsWith('<!--')) {
      const openMatch = line.match(reChecklistOpen);
      if (openMatch) {
        if (report.checklists.some((c) => c.path === openMatch[1])) {
          report.warnings.push(`${openMatch[1]}: drugi blok checklisty dla tego samego pliku (linia ${lineNo}).`);
        }
        block = { path: openMatch[1], items: [] };
        report.checklists.push(block);
        continue;
      }
      if (/^<!--\s*checklist:/.test(line)) {
        report.warnings.push(`Linia ${lineNo}: nierozpoznany otwierający blok checklisty - oczekiwano "<!-- checklist: <ścieżka>" i pozycji w kolejnych liniach.`);
        if (!line.includes('-->')) block = { path: null, items: [] };
        continue;
      }
      const coverageMatch = line.match(reCoverage);
      if (coverageMatch) {
        if (coverageMatch[2] === 'mechanical') {
          // A narrowed walk is the complete proof for such a file, not a gap.
          report.coverage.push({ path: coverageMatch[1], checked: null, total: null, mechanical: true });
        } else {
          const [checked, total] = coverageMatch[2].split('/').map((n) => Number(n.trim()));
          report.coverage.push({ path: coverageMatch[1], checked, total, mechanical: false });
          if (checked < total) {
            report.warnings.push(`${coverageMatch[1]}: sprawdzono ${checked}/${total} pozycji checklist - plik nie przeszedł pełnego przeglądu.`);
          }
        }
      }
      // Any other multi-line comment is swallowed whole, so its inner lines are
      // never read as findings.
      if (!line.includes('-->')) block = { path: null, items: [] };
      continue;
    }

    if (line.startsWith(skippedPrefix)) {
      report.skipped = line.slice(skippedPrefix.length).split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }

    if (!section && emptyBodies.includes(line)) {
      report.emptyState = line;
      break;
    }

    const sectionMatch = line.match(reSection);
    if (sectionMatch) {
      closeFinding();
      openSection(sectionMatch[1]);
      continue;
    }

    const severityMatch = line.match(reSeverity);
    if (severityMatch) {
      closeFinding();
      if (!section) {
        report.warnings.push(`Linia ${lineNo}: znalezisko poza sekcją pliku.`);
        openSection(noFileLabel);
      }
      finding = {
        severity: severityByEmoji.get(severityMatch[1]).key,
        lines: '', problem: '', rule: '', expected: '', prProblem: '', prExpected: '',
        prLocations: '',
      };
      continue;
    }

    const fieldMatch = line.match(reField);
    if (fieldMatch) {
      if (!finding) {
        report.warnings.push(`Linia ${lineNo}: pole "${fieldMatch[1]}" poza znaleziskiem.`);
        continue;
      }
      field = fields[fieldMatch[1]];
      finding[field] = fieldMatch[2].trim();
      continue;
    }

    // A wrapped field value: keep the text instead of dropping it.
    if (finding && field) {
      finding[field] = `${finding[field]} ${line}`.trim();
      continue;
    }

    report.warnings.push(`Linia ${lineNo}: nierozpoznana treść: ${line.slice(0, 60)}`);
  }
  closeFinding();
  if (block) {
    report.warnings.push(`${block.path || '(blok komentarza)'}: niezamknięty blok checklisty - brakuje linii "-->".`);
  }
  reconcileCoverage(report);

  const seen = new Map();
  for (const file of report.files) {
    for (const entry of file.findings) {
      const base = findingId(file.path, entry);
      const count = (seen.get(base) || 0) + 1;
      seen.set(base, count);
      entry.id = count === 1 ? base : `${base}-${count}`;
    }
  }
  return report;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function plural(n, one, few, many) {
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// The page filters on tag keys rather than on (file, rule) strings, so the
// browser never has to join or split anything. Counts are recomputed there -
// they have to react to ignoring - so only the structure is emitted here.
const snippetContext = 3;
// Full sources ride inside the HTML, so the switch is capped by what a page can
// carry and a browser can lay out as DOM rows - not by the 2 MB read guard,
// which is about what is safe to read at all.
const maxFullViewLines = 3000;
const maxSourceBytes = 2 * 1024 * 1024;

// `**Linia:**` is a comma-separated list of numbers and `start-end` spans; any
// piece that is not one of those (a note, a stray word) is dropped rather than
// guessed at.
function parseLineRanges(value) {
  const ranges = [];
  for (const piece of String(value || '').split(',')) {
    const m = piece.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (start < 1 || end < start) continue;
    ranges.push({ start, end });
  }
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

// The rows of one span of the file: the source lines themselves, each carrying
// its diff kind and - for anything the diff did not add - the number it had in
// the old file. Removed lines have no place in the new file at all, so they are
// emitted in front of the new line they used to precede.
function rowsFor(sourceLines, diff, from, to, hit) {
  const rows = [];
  const removedBefore = (n) => (diff && diff.removed.get(n)) || [];
  const removedRow = ({ n, text }) => ({ n: null, oldN: n, text, kind: 'del', hit: false });
  for (let n = from; n <= to; n++) {
    for (const gone of removedBefore(n)) rows.push(removedRow(gone));
    const kind = diff && diff.added.has(n) ? 'add' : 'ctx';
    rows.push({ n, oldN: kind === 'add' ? null : oldLineOf(diff, n), text: sourceLines[n - 1], kind, hit: hit ? hit.has(n) : false });
  }
  // Lines dropped at the very end of the file are anchored past the last one,
  // where the loop above can no longer reach them.
  if (to === sourceLines.length) {
    for (const gone of removedBefore(sourceLines.length + 1)) rows.push(removedRow(gone));
  }
  return rows;
}

// One hunk per cited place: the lines themselves plus a few lines of context,
// merged when the windows touch so the view never hides less than the gap
// marker announcing it. With a diff in hand the rows also carry their diff
// kind, which is what turns the view into a real +/- diff.
function buildSnippet(sourceLines, linesField, diff) {
  const ranges = parseLineRanges(linesField).filter((range) => range.start <= sourceLines.length);
  if (!ranges.length) return null;
  const hit = new Set();
  const windows = [];
  for (const range of ranges) {
    const end = Math.min(range.end, sourceLines.length);
    for (let n = range.start; n <= end; n++) hit.add(n);
    const from = Math.max(1, range.start - snippetContext);
    const to = Math.min(sourceLines.length, end + snippetContext);
    const last = windows[windows.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else windows.push({ from, to });
  }
  // A cited range is shown whole, however long: a finding that spans a file is
  // exactly the one whose code the reader needs in full.
  const hunks = windows.map((window) => ({ lines: rowsFor(sourceLines, diff, window.from, window.to, hit) }));
  // The full view highlights the same lines, and it renders from the file's
  // rows rather than from these, so it needs the numbers, not the marked rows.
  return hunks.length ? { hunks, hits: [...hit].sort((a, b) => a - b) } : null;
}

// The whole file as one continuous run of rows - no windows, so no gap markers.
// Highlighting is left to the client, because one file serves every finding in
// it and each of them marks different lines.
function buildFullView(sourceLines, diff) {
  if (!sourceLines.length || sourceLines.length > maxFullViewLines) return null;
  return { rows: rowsFor(sourceLines, diff, 1, sourceLines.length, null) };
}

// A trailing newline ends the last line, it does not start another one, and
// `cat -n` - the numbering every report cites - counts it exactly that way.
function withoutTrailingBlank(lines) {
  return lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

function gitText(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: maxSourceBytes, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    return null;
  }
}

// Same fallback as the context script: a branch reviewed from a remote-only ref
// is still named without the `origin/` prefix in the report.
function resolveRef(root, name) {
  if (!name) return '';
  if (gitText(root, ['rev-parse', '--verify', '--quiet', name]) !== null) return name;
  if (gitText(root, ['rev-parse', '--verify', '--quiet', `origin/${name}`]) !== null) return `origin/${name}`;
  return name;
}

// `git diff -U0` states the change exactly: `@@ -a,b +c,d @@` removed old lines
// a..a+b-1 and added new lines c..c+d-1, with no context lines in between. The
// report cites new-file numbers, so additions are keyed by their new number and
// removals are anchored to the new line they sit in front of, carrying the old
// number they had. `shifts` is what the untouched lines in between need: from
// the named new line on, the old file's numbering runs `delta` ahead.
function parseDiff(diffText) {
  if (!diffText) return null;
  const added = new Set();
  const removed = new Map();
  const shifts = [{ from: 1, delta: 0 }];
  let cursor = 0;
  let anchor = 0;
  let oldCursor = 0;
  for (const line of String(diffText).split(/\r?\n/)) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const start = Number(hunk[3]);
      const count = hunk[4] === undefined ? 1 : Number(hunk[4]);
      cursor = start;
      oldCursor = oldStart;
      // A hunk that adds or removes nothing on one side names the line it
      // happened *after*, so that side continues one line further on.
      anchor = count === 0 ? start + 1 : start;
      const afterNew = count === 0 ? start + 1 : start + count;
      shifts.push({ from: afterNew, delta: (oldCount === 0 ? oldStart + 1 : oldStart + oldCount) - afterNew });
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      added.add(cursor);
      cursor++;
    } else if (line.startsWith('-')) {
      if (!removed.has(anchor)) removed.set(anchor, []);
      removed.get(anchor).push({ n: oldCursor, text: line.slice(1) });
      oldCursor++;
    }
  }
  return added.size || removed.size ? { added, removed, shifts } : null;
}

// The old-file number of a line the diff left untouched - what the left side of
// the split view prints next to it. An added line has no old counterpart.
function oldLineOf(diff, n) {
  if (!diff || !diff.shifts) return null;
  let delta = 0;
  for (const shift of diff.shifts) {
    if (shift.from > n) break;
    delta = shift.delta;
  }
  return n + delta > 0 ? n + delta : null;
}

// Branch and staged reviews are written against the reviewed revision, not the
// working tree, so a snippet reads the very content the review saw.
function sourceReader(projectRoot, source) {
  const root = path.resolve(projectRoot);
  const mode = source && source.mode;
  const ref = mode === 'branch' ? resolveRef(root, source.branch) : '';
  const cache = new Map();
  const fromGit = (filePath) => {
    if (mode === 'branch' && ref) return gitText(root, ['show', `${ref}:${filePath}`]);
    if (mode === 'staged') return gitText(root, ['show', `:${filePath}`]);
    return null;
  };
  const fromDisk = (filePath) => {
    const full = path.resolve(root, filePath);
    // Section headers are report text, so a path is only read once it is proven
    // to stay inside the reviewed project.
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > maxSourceBytes) return null;
    return fs.readFileSync(full, 'utf8');
  };
  return (filePath) => {
    if (cache.has(filePath)) return cache.get(filePath);
    let lines = null;
    try {
      const text = fromGit(filePath) ?? fromDisk(filePath);
      if (text !== null && text.indexOf(String.fromCharCode(0)) === -1) lines = withoutTrailingBlank(text.split(/\r?\n/));
    } catch (err) {
      lines = null;
    }
    cache.set(filePath, lines);
    return lines;
  };
}

// A file:// page has no credentials, so GitHub is asked here, once: the page
// only learns whether a PR exists and what command posts the comments to it.
// A lookup that could not run comes back as a warning, because a button missing
// because the API refused looks exactly like a button missing because no PR is
// open. Repos that do not point at GitHub are never asked, so they never warn.
function detectPullRequest(projectRoot, branch, findPr = github.findOpenPr) {
  if (!branch) return { pr: null, warning: null };
  const { pr, error, tokenSource, triedTokenSources } = findPr(projectRoot, branch);
  if (error) {
    const tail = 'Raport nie dostał przycisku dodawania komentarzy do PR.';
    // The two failures need opposite advice, and they are indistinguishable from
    // the HTTP status alone: a private repository answers 404 to an anonymous
    // call exactly as it does to a token that may not see it. Which one it was
    // is settled by whether a token was found at all, so the message says so
    // instead of leaving the reader to guess.
    const warning = tokenSource
      ? `Token z „${tokenSource}” nie pozwolił sprawdzić PR-a w API GitHuba: ${error}. ${tail}`
      : `Nie znaleziono tokena GitHuba - sprawdzono: ${(triedTokenSources || []).join(', ')}. `
        + `Prywatne repozytorium odpowiada na zapytanie bez tokena tak samo jak na brak PR-a (${error}). `
        + `Ustaw GH_TOKEN na token z uprawnieniem \`repo\`. ${tail}`;
    return { pr: null, warning };
  }
  return { pr: pr ? { number: pr.number, url: pr.url } : null, warning: null };
}

function postCommandFor(projectRoot, outPath) {
  const script = path.join(__dirname, 'post-pr-comments.cjs').replace(/\\/g, '/');
  return `node "${script}" --report="${path.resolve(outPath).replace(/\\/g, '/')}" --project="${projectRoot.replace(/\\/g, '/')}"`;
}

function diffReader(projectRoot, source) {
  const root = path.resolve(projectRoot);
  const mode = source && source.mode;
  const ref = mode === 'branch' ? resolveRef(root, source.branch) : '';
  const cache = new Map();
  const argsFor = (filePath) => {
    if (mode === 'branch' && ref && source.base) return ['diff', '-U0', `${source.base}...${ref}`, '--', filePath];
    if (mode === 'staged') return ['diff', '-U0', '--cached', '--', filePath];
    // Folder reviews have no diff at all: their snippets stay a plain file view.
    return null;
  };
  return (filePath) => {
    if (cache.has(filePath)) return cache.get(filePath);
    const args = argsFor(filePath);
    const diff = args ? parseDiff(gitText(root, args)) : null;
    cache.set(filePath, diff);
    return diff;
  };
}

// A file that moved, vanished or is binary simply renders without a snippet -
// the finding itself stays intact.
function attachSnippets(report, projectRoot, source) {
  const read = sourceReader(projectRoot, source);
  const readDiff = diffReader(projectRoot, source);
  for (const file of report.files) {
    const lines = read(file.path);
    const diff = lines ? readDiff(file.path) : null;
    file.full = lines ? buildFullView(lines, diff) : null;
    // Only a file that was read and then turned down for its length gets a
    // count: a missing file has no length to report and no switch to explain.
    file.fullLines = lines && !file.full ? lines.length : null;
    for (const finding of file.findings) {
      finding.snippet = lines ? buildSnippet(lines, finding.lines, diff) : null;
    }
  }
  return report;
}

function buildPayload(report, reportName) {
  const allFindings = report.files.flatMap((file) => file.findings);
  const groups = new Map();
  let nextKey = 0;
  for (const finding of allFindings) {
    for (const tag of finding.tags) {
      if (!groups.has(tag.file)) groups.set(tag.file, { file: tag.file, count: 0, rules: new Map() });
      const group = groups.get(tag.file);
      group.count++;
      if (!group.rules.has(tag.rule)) {
        group.rules.set(tag.rule, { key: `r${nextKey++}`, rule: tag.rule, count: 0 });
      }
      group.rules.get(tag.rule).count++;
    }
  }
  const byCountThenName = (nameOf) => (a, b) => b.count - a.count || nameOf(a).localeCompare(nameOf(b), 'pl');
  const ruleGroups = [...groups.values()]
    .sort(byCountThenName((group) => group.file))
    .map((group) => ({
      file: group.file,
      rules: [...group.rules.values()]
        .sort(byCountThenName((rule) => rule.rule))
        .map((rule) => ({ key: rule.key, rule: rule.rule })),
    }));
  const keyOf = new Map();
  for (const group of groups.values()) {
    for (const rule of group.rules.values()) keyOf.set(`${group.file}\n${rule.rule}`, rule.key);
  }

  return {
    title: report.title,
    datetime: report.datetime,
    skipped: report.skipped,
    emptyState: report.emptyState,
    reportName,
    pr: report.pr || null,
    postCommand: report.postCommand || '',
    severities: severities
      .filter((s) => allFindings.some((f) => f.severity === s.key))
      .map(({ key, label, emoji }) => ({ key, label, emoji })),
    ruleGroups,
    // The walked checklists, in the order the files were analyzed: what the
    // page shows under "Pokrycie checklist".
    coverage: report.coverage.map((entry) => ({
      path: entry.path,
      mechanical: !!entry.mechanical,
      total: entry.total,
      checked: entry.mechanical ? null : (entry.items || []).filter((item) => item.ok).length,
      items: (entry.items || []).map((item) => ({ id: item.id, state: item.state, text: item.text })),
    })),
    files: report.files.map((file) => ({
      path: file.path,
      full: file.full || null,
      fullLines: file.fullLines || null,
      findings: file.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        lines: finding.lines,
        problem: finding.problem,
        rule: finding.rule,
        expected: finding.expected,
        prProblem: finding.prProblem || '',
        prExpected: finding.prExpected || '',
        prLocations: finding.prLocations || '',
        snippet: finding.snippet || null,
        tagKeys: finding.tags.map((tag) => keyOf.get(`${tag.file}\n${tag.rule}`)),
      })),
    })),
  };
}

// One dark palette, used by the media query and by the toggle alike.
const darkTokens = `
  --bg:#141619;--panel:#1c1f24;--panel-2:#22262c;--text:#e5e8ec;--muted:#98a1ac;--border:#2f343b;
  --accent:#6ea8fe;--code-bg:#282d34;--shadow:none;
  --sev-critical:#c58f59;--sev-high:#f0736a;--sev-medium:#e0b341;--sev-low:#98a2b0;--sev-missing-unit-test:#6ea8fe;
  --snip-bg:#181b1f;--snip-gutter:#1f2329;--hit-bg:#3a3320;--hit-gutter:#463c22;
  --add-bg:#12261e;--add-fg:#3fb950;--del-bg:#2d1618;--del-fg:#f85149;
  --accepted-bg:#16241b;--accepted-line:#3fb950`;

const pageCss = `
*,*::before,*::after{box-sizing:border-box}
:root{color-scheme:light dark;
  --bg:#f5f6f8;--panel:#fff;--panel-2:#fafbfc;--text:#1b1e23;--muted:#68707c;--border:#dee2e7;
  --accent:#2563eb;--code-bg:#eceff3;--shadow:0 1px 2px rgba(16,22,32,.06);
  --sev-critical:#8a5a2b;--sev-high:#c0392b;--sev-medium:#b0761a;--sev-low:#78808d;--sev-missing-unit-test:#2563eb;
  --snip-bg:#fbfcfd;--snip-gutter:#f1f3f6;--hit-bg:#fff6d9;--hit-gutter:#ffeeb8;
  --add-bg:#e6ffec;--add-fg:#1a7f37;--del-bg:#ffebe9;--del-fg:#cf222e;
  --accepted-bg:#eef8f0;--accepted-line:#1a7f37}
/* The system preference rules until the reader picks a side; that pick is
   \`data-theme\` on the root and it wins in both directions. */
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${darkTokens}}}
:root[data-theme="dark"]{color-scheme:dark;${darkTokens}}
:root[data-theme="light"]{color-scheme:light}
body{margin:0;background:var(--bg);color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{max-width:1600px;margin:0 auto;padding:0 20px 72px}
.cols{display:grid;grid-template-columns:490px minmax(0,1fr);gap:20px;align-items:start}
.cols-plain{grid-template-columns:minmax(0,1fr)}
code{font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:.88em;
  background:var(--code-bg);border-radius:4px;padding:.1em .35em;overflow-wrap:anywhere}
button{font:inherit;color:inherit}

.head{position:relative;padding:26px 0 14px}
.head h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere;padding-right:150px}
/* Top right of the content column, out of the title's way at any width. */
.theme-toggle{position:absolute;top:24px;right:0;display:inline-flex;align-items:center;gap:6px}

.ctxmenu{position:fixed;z-index:50;min-width:270px;padding:4px;border:1px solid var(--border);
  border-radius:9px;background:var(--panel);box-shadow:var(--shadow)}
.ctxmenu[hidden]{display:none}
.ctxmenu button{display:block;width:100%;padding:7px 10px;border:0;border-radius:6px;
  background:none;text-align:left;font-size:13px;cursor:pointer}
.ctxmenu button:hover:not(:disabled),.ctxmenu button:focus-visible{background:var(--panel-2)}
.ctxmenu button:disabled{color:var(--muted);cursor:default}
.head .meta{margin-top:6px;color:var(--muted);font-size:13.5px}
.head .skipped{margin-top:8px;color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}
/* Louder than .skipped: this one is not a note about the review, it is the
   reason a button the reader expected is not there. */
.head .pr-warning{margin-top:10px;padding:8px 11px;border:1px solid var(--border);border-left:3px solid var(--sev-medium);
  border-radius:8px;background:var(--panel);color:var(--text);font-size:12.5px;overflow-wrap:anywhere}

.toolbar{background:var(--panel);border:1px solid var(--border);
  border-radius:10px;padding:12px 14px;box-shadow:var(--shadow);margin-bottom:18px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.row+.row{margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
/* The rule tree grows tall when expanded; keeping this row top-aligned stops
   its labels and the grouping control from floating to the middle. */
.row-top{align-items:flex-start}
.row-top .row-label{margin-top:4px}
/* Caption and buttons share one centred line, so the caption never rides above
   the segmented control; the left margin keeps it clear of the rule box. */
.group-ctl{display:flex;align-items:center;gap:10px;margin-left:20px}
.row-top .group-ctl .row-label{width:auto;margin-top:0}
.row-label{flex:0 0 auto;width:74px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border:1px solid var(--border);
  border-radius:999px;background:var(--panel-2);cursor:pointer;line-height:1.4;font-size:13.5px}
.chip:hover{border-color:var(--accent)}
.chip[aria-pressed=false]{opacity:.4;border-style:dashed;background:transparent}
.chip .n{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}

.rulebox{flex:1 1 240px;min-width:220px;border:1px solid var(--border);border-radius:8px;background:var(--panel-2)}
.rulebox>summary{cursor:pointer;padding:5px 11px;list-style:none;font-size:13.5px}
.rulebox>summary::-webkit-details-marker{display:none}
.rulebox>summary::after{content:"▾";float:right;color:var(--muted)}
.rulebox[open]>summary::after{content:"▴"}
.tree-actions{display:flex;gap:6px;padding:6px 8px}
.tree{max-height:340px;overflow:auto;border-top:1px solid var(--border);padding:6px}
.grp{padding:1px 0}
/* Same trap as .kids: an author-level display would beat the hidden attribute
   used to drop rules the severity filter left empty. */
.grp[hidden],.kid[hidden]{display:none}
.grp-head{display:flex;align-items:center;gap:7px;padding:3px 4px;border-radius:6px}
.grp-head:hover{background:var(--panel)}
.twisty{width:20px;flex:0 0 auto;border:0;background:none;cursor:pointer;color:var(--muted);padding:0}
.grp-name{flex:1 1 auto;cursor:pointer;overflow-wrap:anywhere;font-size:13.5px}
.n{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;flex:0 0 auto}
.kids{margin:2px 0 6px 27px;display:flex;flex-direction:column;gap:2px}
/* The hidden attribute alone loses to the author-level display above, so the
   twisty would flip the attribute without ever collapsing the group. */
.kids[hidden]{display:none}
.kid{display:flex;align-items:flex-start;gap:7px;font-size:13px;color:var(--muted);
  padding:2px 4px;border-radius:6px}
.kid:hover{background:var(--panel);color:var(--text)}
.kid label{cursor:pointer;overflow-wrap:anywhere}
.kid .n{margin-left:auto;padding-left:10px}
.kid input{margin-top:4px}

.segmented{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.segmented button{border:0;background:var(--panel-2);padding:5px 14px;cursor:pointer;font-size:13.5px}
.segmented button+button{border-left:1px solid var(--border)}
.segmented button[aria-pressed=true]{background:var(--accent);color:#fff}
.status{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.status .grow{flex:1 1 auto}
.act{border:1px solid var(--border);background:var(--panel-2);border-radius:7px;padding:4px 11px;cursor:pointer;font-size:13px}
.act:hover:not(:disabled){border-color:var(--accent)}
.act:disabled{opacity:.4;cursor:default}

/* The tree is the one thing that has to stay in view while reading a long
   report - that is what makes it a map of the review. */
.sidebar{position:sticky;top:12px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;
  border:1px solid var(--border);border-radius:10px;background:var(--panel);box-shadow:var(--shadow);overflow:hidden}
.sidebar-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);
  color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.sidebar-head .grow{flex:1 1 auto}
.filetree{overflow:auto;padding:6px 8px 10px;
  font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:12.5px;line-height:1.6}
.tr-row{display:flex;align-items:center;gap:6px;padding:1px 6px;border-radius:6px;cursor:pointer}
.tr-row:hover{background:var(--panel-2)}
.tr-row[hidden],.tr-kids[hidden]{display:none}
.tr-name{flex:1 1 auto;overflow-wrap:anywhere}
.tr-dir>.tr-name{color:var(--muted)}
.tr-file{padding-left:22px}
.tr-file.active{background:var(--hit-bg);color:var(--text)}
.tr-kids{margin-left:9px;padding-left:5px;border-left:1px solid var(--border)}
.twisty-sm{width:12px;flex:0 0 auto;border:0;background:none;color:var(--muted);cursor:pointer;padding:0;font-size:10px}
@media (max-width:1180px){.cols{grid-template-columns:minmax(0,1fr)}.sidebar{position:static;max-height:420px}}

.cmdbox{margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
.cmdbox[hidden]{display:none}
.cmd-info{margin:0 0 8px;font-size:13px;color:var(--muted)}
.cmd{margin:0 0 8px;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--code-bg);
  font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:12.5px;
  white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
.cmd-actions{display:flex;align-items:center;gap:10px;font-size:13px}

.filesec{margin-bottom:16px}
.filesec.flash>summary{background:var(--hit-bg)}
.filesec>summary{cursor:pointer;display:flex;align-items:center;gap:10px;padding:7px 2px;
  font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:13px;
  border-bottom:1px solid var(--border);list-style:none;overflow-wrap:anywhere}
.filesec>summary::-webkit-details-marker{display:none}
.filesec>summary::before{content:"▾";color:var(--muted);flex:0 0 auto}
.filesec:not([open])>summary::before{content:"▸"}
.filesec>summary .n{margin-left:auto}
.list{padding-top:10px}

.finding{background:var(--panel);border:1px solid var(--border);border-left-width:4px;border-radius:9px;
  padding:11px 14px;margin-bottom:9px;box-shadow:var(--shadow)}
.f-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.f-sev{font-weight:650;font-size:13.5px}
.f-lines{display:flex;flex-wrap:wrap;gap:4px}
.f-path{width:100%;margin-top:2px;color:var(--muted);overflow-wrap:anywhere;
  font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:12px}
.f-hide{margin-left:0}
.f-accept{margin-left:auto}
.f-problem{margin-top:8px;overflow-wrap:anywhere}
/* Accepted = in the pool that goes to the PR: collapsed to its head line and
   marked well enough to be spotted while scrolling past the rest. */
.finding.accepted{background:var(--accepted-bg);border-color:var(--accepted-line);box-shadow:none}
.finding.accepted .f-body{display:none}
.accepted-count{font-weight:650;color:var(--accepted-line)}
.f-accepted-tag{font-size:12px;font-weight:650;color:var(--accepted-line)}
.finding.accepted .f-accept{border-color:var(--accepted-line);color:var(--accepted-line)}

.snipbox{margin-top:10px;border:1px solid var(--border);border-radius:8px;background:var(--snip-bg);overflow:hidden}
.snipbox>summary{cursor:pointer;list-style:none;padding:5px 11px;font-size:12.5px;color:var(--muted);
  display:flex;align-items:center;gap:10px}
.snip-title{flex:1 1 auto;overflow-wrap:anywhere}
/* Small enough to sit in the summary line without stretching it, otherwise the
   same segmented control the toolbar uses. */
.snip-modes{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;flex:0 0 auto}
.snip-modes button{border:0;background:var(--panel-2);padding:2px 9px;cursor:pointer;font-size:11.5px;color:var(--muted)}
.snip-modes button+button{border-left:1px solid var(--border)}
.snip-modes button[aria-pressed=true]{background:var(--accent);color:#fff}
.snip-modes button:disabled{opacity:.4;cursor:default}
.snipbox>summary::-webkit-details-marker{display:none}
.snipbox>summary::before{content:"▸ "}
.snipbox[open]>summary::before{content:"▾ "}
.snipbox>summary:hover{color:var(--text)}
.snip{border-top:1px solid var(--border);overflow-x:auto;
  font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:12.5px;line-height:1.6}
/* Rows are as wide as the widest line so the highlight spans the whole scroll
   width instead of stopping at the viewport edge. */
.snip-row{display:flex;align-items:flex-start;white-space:pre;min-width:max-content;min-height:1.6em}
.snip-n{flex:0 0 auto;width:56px;padding:0 10px 0 6px;text-align:right;color:var(--muted);
  background:var(--snip-gutter);border-right:1px solid var(--border);
  position:sticky;left:0;user-select:none;font-variant-numeric:tabular-nums}
.snip-mark{flex:0 0 auto;width:14px;text-align:center;user-select:none;color:var(--muted)}
.snip-code{flex:1 1 auto;padding:0 14px 0 2px}
.snip-add{background:var(--add-bg)}
.snip-add .snip-mark{color:var(--add-fg);font-weight:650}
.snip-del{background:var(--del-bg);color:var(--del-fg)}
.snip-del .snip-mark{color:var(--del-fg);font-weight:650}
/* The highlight wins the row background so a finding stays findable inside a
   long hunk; the marker column keeps carrying the +/- meaning. */
.snip-hit{background:var(--hit-bg)}
.snip-hit .snip-n{background:var(--hit-gutter);color:var(--text);font-weight:650;
  box-shadow:inset 3px 0 0 var(--hit-mark,var(--accent))}
.snip-gap{color:var(--muted)}
.snip-gap .snip-n{color:var(--muted)}
/* Split view: the file before the change on the left, after it on the right.
   Each side scrolls horizontally on its own, so one long line never pushes the
   other side out of view; the rows stay aligned because every row is exactly one
   line high and both sides get the same number of them. The single-column grid
   inside a side stretches every row to the widest line, which is what lets a
   blank counterpart cell keep its background across the whole scroll width. */
.snip-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);overflow-x:hidden}
.snip-side{overflow-x:auto;min-width:0;display:grid;grid-template-columns:minmax(100%,max-content)}
.snip-side+.snip-side{border-left:1px solid var(--border)}
.snip-blank{background:var(--snip-gutter)}
/* A whole file would push the next finding off the page, so the full view keeps
   its own scrollbar and the card its size. Both columns of a split view sit
   inside this box, which is what keeps them scrolling together. */
.snip-full{max-height:70vh;overflow-y:auto}
.f-grid{margin-top:9px;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;
  font-size:13.5px;color:var(--muted)}
.f-grid dt{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding-top:2px}
.f-grid dd{margin:0;color:var(--text);overflow-wrap:anywhere}
@media (max-width:620px){.f-grid{grid-template-columns:minmax(0,1fr);gap:1px}
  .f-grid dd{margin-bottom:7px}.row-label{width:auto}}

.note{background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:22px;
  text-align:center;color:var(--muted)}

/* Pokrycie checklist: the proof of what was walked, one collapsed row per file.
   It sits below the findings and opens on demand, so it never competes with
   them for the first screen. */
.coverage[hidden]{display:none}
.coverage{margin-top:26px;background:var(--panel);border:1px solid var(--border);
  border-radius:10px;box-shadow:var(--shadow)}
.coverage>summary{cursor:pointer;display:flex;align-items:baseline;gap:10px;padding:11px 14px;
  list-style:none;font-size:14px;font-weight:600}
.coverage>summary::-webkit-details-marker{display:none}
.coverage>summary::before{content:"▸";color:var(--muted);font-weight:400}
.coverage[open]>summary::before{content:"▾"}
.coverage>summary .cov-meta{margin-left:auto;color:var(--muted);font-size:12.5px;font-weight:400;
  font-variant-numeric:tabular-nums}
.cov-body{padding:0 14px 12px}
.cov-file{border-top:1px solid var(--border)}
.cov-file>summary{cursor:pointer;display:flex;align-items:center;gap:10px;padding:7px 2px;list-style:none;
  font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
.cov-file>summary::-webkit-details-marker{display:none}
.cov-file>summary::before{content:"▸";color:var(--muted);flex:0 0 auto}
.cov-file[open]>summary::before{content:"▾"}
.cov-file>summary .n{margin-left:auto;flex:0 0 auto;color:var(--muted);font-variant-numeric:tabular-nums}
/* A file that did not finish its walk is the one thing this section has to make
   impossible to miss. */
.cov-file.short>summary .n{color:var(--sev-high);font-weight:600}
.cov-items{margin:2px 0 10px;padding:0 0 0 18px;list-style:none;font-size:12.5px}
.cov-item{display:flex;gap:8px;padding:1.5px 0;overflow-wrap:anywhere}
.cov-item::before{content:"✓";flex:0 0 auto;color:var(--add-fg);font-family:ui-monospace,monospace}
.cov-item.violation::before{content:"✗";color:var(--sev-high)}
.cov-item.open::before{content:"○";color:var(--sev-medium)}
.cov-item.open{color:var(--sev-medium)}
.cov-id{flex:0 0 auto;font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;
  color:var(--muted)}
`;

const pageJs = `
(function () {
  var el = function (tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; };
  var byId = function (id) { return document.getElementById(id); };
  var reportData = JSON.parse(byId('report-data').textContent);
  var host = byId('findings');

  function note(text) { var n = el('div', 'note'); n.textContent = text; return n; }

  // Backtick spans become real <code> elements and every other value goes in as
  // a text node, so no report text is ever treated as markup.
  function rich(text) {
    var frag = document.createDocumentFragment();
    var parts = String(text).split('\\u0060');
    if (parts.length % 2 === 0) { frag.appendChild(document.createTextNode(String(text))); return frag; }
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1) { var c = el('code'); c.textContent = parts[i]; frag.appendChild(c); }
      else frag.appendChild(document.createTextNode(parts[i]));
    }
    return frag;
  }

  // The theme is one attribute on the root element. The pick is remembered for
  // every report, not just this one, and it is wired up before the empty-state
  // exit below so the toggle works on a report with no findings too.
  var themeKey = 'doh-code-review:theme';
  var themeToggle = byId('theme-toggle');
  function storedTheme() {
    try { var v = localStorage.getItem(themeKey); return v === 'dark' || v === 'light' ? v : ''; } catch (e) { return ''; }
  }
  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
  }
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || storedTheme() || systemTheme();
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.textContent = theme === 'dark' ? '☀️ Tryb jasny' : '🌙 Tryb ciemny';
    themeToggle.title = theme === 'dark' ? 'Przełącz na tryb jasny' : 'Przełącz na tryb ciemny';
  }
  applyTheme(currentTheme());
  themeToggle.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    // Private mode refuses storage; the switch still works for this session.
    try { localStorage.setItem(themeKey, next); } catch (e) {}
    applyTheme(next);
  });

  // "Pokrycie checklist" - the ticked checklist of every analyzed file, which is
  // what the coverage numbers in the header of each row are counted from. No
  // filter reaches it, so it is built once and never touched by refresh().
  (function coverageSection() {
    var data = reportData.coverage || [];
    var box = byId('coverage');
    if (!box || !data.length) return;
    var body = byId('cov-body');
    data.forEach(function (file) {
      var short = !file.mechanical && file.checked < file.total;
      var sec = el('details', short ? 'cov-file short' : 'cov-file');
      var summary = el('summary');
      var label = el('span');
      label.textContent = file.path;
      var n = el('span', 'n');
      n.textContent = file.mechanical ? 'zmiana mechaniczna' : file.checked + '/' + file.total;
      summary.appendChild(label);
      summary.appendChild(n);
      sec.appendChild(summary);
      if (file.items.length) {
        var list = el('ul', 'cov-items');
        file.items.forEach(function (item) {
          var row = el('li', item.state === 'ok' ? 'cov-item' : 'cov-item ' + item.state);
          var id = el('span', 'cov-id');
          id.textContent = item.id;
          var text = el('span');
          text.appendChild(rich(item.text));
          row.appendChild(id);
          row.appendChild(text);
          list.appendChild(row);
        });
        sec.appendChild(list);
      } else {
        var empty = el('ul', 'cov-items');
        var only = el('li', 'cov-item open');
        only.appendChild(document.createTextNode(file.mechanical
          ? 'Zmiana mechaniczna: przejście zawężone do dwóch pytań bramki.'
          : 'Brak odchaczonych pozycji.'));
        empty.appendChild(only);
        sec.appendChild(empty);
      }
      body.appendChild(sec);
    });
    box.hidden = false;
  }());

  if (reportData.emptyState) { host.appendChild(note(reportData.emptyState)); return; }

  var severityByKey = {};
  reportData.severities.forEach(function (s, i) { severityByKey[s.key] = { label: s.label, emoji: s.emoji, rank: i }; });

  var allFindings = [];
  reportData.files.forEach(function (file, fileIndex) {
    file.findings.forEach(function (finding, order) {
      finding.filePath = file.path;
      finding.fileIndex = fileIndex;
      finding.order = order;
      finding.rank = severityByKey[finding.severity].rank;
      allFindings.push(finding);
    });
  });

  var storeKey = 'doh-code-review:' + reportData.reportName;
  // Private mode rejects storage access outright, and a hand-edited entry can
  // be anything: either way ignoring degrades to the current session.
  function loadIgnored() {
    try { return new Set(JSON.parse(localStorage.getItem(storeKey)) || []); } catch (e) { return new Set(); }
  }
  function saveIgnored() {
    try { localStorage.setItem(storeKey, JSON.stringify(Array.from(state.ignored))); } catch (e) {}
  }
  // The accepted pool - the findings that, and only those, become PR comments.
  var acceptedKey = storeKey + ':accepted';
  function loadAccepted() {
    try { return new Set(JSON.parse(localStorage.getItem(acceptedKey)) || []); } catch (e) { return new Set(); }
  }
  function saveAccepted() {
    try { localStorage.setItem(acceptedKey, JSON.stringify(Array.from(state.accepted))); } catch (e) {}
  }

  var state = {
    // Severity chips include instead of exclude: an empty set means "no severity
    // filter", picking Critical narrows the list down to Critical alone.
    selectedSeverities: new Set(),
    selectedRules: new Set(),
    group: 'files',
    ignored: loadIgnored(),
    accepted: loadAccepted()
  };
  reportData.ruleGroups.forEach(function (g) { g.rules.forEach(function (r) { state.selectedRules.add(r.key); }); });

  function visible(f) {
    if (state.ignored.has(f.id)) return false;
    if (state.selectedSeverities.size && !state.selectedSeverities.has(f.severity)) return false;
    if (!f.tagKeys.length) return true;
    for (var i = 0; i < f.tagKeys.length; i++) if (state.selectedRules.has(f.tagKeys[i])) return true;
    return false;
  }

  // Counts are totals over everything not ignored: they react to hiding a
  // finding but stay put while filters are being adjusted.
  function tally() {
    var sev = {}, rule = {}, active = 0;
    var narrowed = state.selectedSeverities.size > 0;
    allFindings.forEach(function (f) {
      if (state.ignored.has(f.id)) return;
      active++;
      sev[f.severity] = (sev[f.severity] || 0) + 1;
      // Rule counts follow the severity chips, so picking a severity also
      // narrows the rule tree to the rules that severity actually broke.
      if (narrowed && !state.selectedSeverities.has(f.severity)) return;
      f.tagKeys.forEach(function (k) { rule[k] = (rule[k] || 0) + 1; });
    });
    return { sev: sev, rule: rule, active: active };
  }

  var chipNodes = {}, groupNodes = [], ruleNodes = {};

  reportData.severities.forEach(function (s) {
    var chip = el('button', 'chip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', 'true');
    chip.style.color = 'var(--sev-' + s.key + ')';
    var name = el('span');
    name.textContent = s.emoji + ' ' + s.label;
    var n = el('span', 'n');
    chip.appendChild(name);
    chip.appendChild(n);
    chip.addEventListener('click', function () {
      if (state.selectedSeverities.has(s.key)) state.selectedSeverities['delete'](s.key); else state.selectedSeverities.add(s.key);
      syncSeverityChips();
      refresh();
    });
    chipNodes[s.key] = { chip: chip, n: n };
    byId('sev-filter').appendChild(chip);
  });

  // With nothing picked every chip stays lit — dimming them all would advertise
  // a filter that is not actually narrowing anything.
  function syncSeverityChips() {
    var unfiltered = state.selectedSeverities.size === 0;
    reportData.severities.forEach(function (s) {
      var on = unfiltered || state.selectedSeverities.has(s.key);
      chipNodes[s.key].chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  reportData.ruleGroups.forEach(function (g) {
    var wrap = el('div', 'grp');
    var head = el('div', 'grp-head');
    var twisty = el('button', 'twisty');
    twisty.type = 'button';
    twisty.textContent = '▸';
    twisty.setAttribute('aria-expanded', 'false');
    var box = el('input');
    box.type = 'checkbox';
    box.checked = true;
    var name = el('label', 'grp-name');
    name.textContent = g.file;
    var n = el('span', 'n');
    var kids = el('div', 'kids');
    kids.hidden = true;

    name.addEventListener('click', function () { box.click(); });
    box.addEventListener('click', function () {
      // A half-checked section means "some rules are on": clicking it completes
      // the section, instead of the browser's default toggle to unchecked.
      if (box.dataset.partial === '1') box.checked = true;
    });
    twisty.addEventListener('click', function () {
      kids.hidden = !kids.hidden;
      twisty.textContent = kids.hidden ? '▸' : '▾';
      twisty.setAttribute('aria-expanded', kids.hidden ? 'false' : 'true');
    });
    box.addEventListener('change', function () {
      g.rules.forEach(function (r) {
        if (box.checked) state.selectedRules.add(r.key); else state.selectedRules['delete'](r.key);
        ruleNodes[r.key].box.checked = box.checked;
      });
      markGroup(box, box.checked, false);
      refresh();
    });

    g.rules.forEach(function (r) {
      var kid = el('div', 'kid');
      var kbox = el('input');
      kbox.type = 'checkbox';
      kbox.checked = true;
      kbox.id = 'rule-' + r.key;
      var klabel = el('label');
      klabel.htmlFor = kbox.id;
      klabel.textContent = r.rule;
      var kn = el('span', 'n');
      kbox.addEventListener('change', function () {
        if (kbox.checked) state.selectedRules.add(r.key); else state.selectedRules['delete'](r.key);
        syncGroup(g, box);
        refresh();
      });
      kid.appendChild(kbox);
      kid.appendChild(klabel);
      kid.appendChild(kn);
      kids.appendChild(kid);
      ruleNodes[r.key] = { box: kbox, n: kn, row: kid };
    });

    head.appendChild(twisty);
    head.appendChild(box);
    head.appendChild(name);
    head.appendChild(n);
    wrap.appendChild(head);
    wrap.appendChild(kids);
    byId('rule-tree').appendChild(wrap);
    groupNodes.push({ group: g, box: box, n: n, wrap: wrap });
  });

  // Bulk switches: with every rule off the list is empty by definition, which is
  // the point - it is the fastest way to then pick one single rule.
  function setAllRules(on) {
    reportData.ruleGroups.forEach(function (g) {
      g.rules.forEach(function (r) {
        if (on) state.selectedRules.add(r.key); else state.selectedRules['delete'](r.key);
        ruleNodes[r.key].box.checked = on;
      });
    });
    groupNodes.forEach(function (entry) { markGroup(entry.box, on, false); });
    refresh();
  }

  byId('rules-all').addEventListener('click', function () { setAllRules(true); });
  byId('rules-none').addEventListener('click', function () { setAllRules(false); });

  // The browser clears the indeterminate flag before the click event reaches a
  // handler, so the mixed state is mirrored on the element to stay readable there.
  function markGroup(box, checked, partial) {
    box.checked = checked;
    box.indeterminate = partial;
    if (partial) box.dataset.partial = '1'; else delete box.dataset.partial;
  }

  function syncGroup(g, box) {
    var on = 0;
    g.rules.forEach(function (r) { if (state.selectedRules.has(r.key)) on++; });
    markGroup(box, on > 0, on > 0 && on < g.rules.length);
  }

  function setGroup(name) {
    state.group = name;
    Array.prototype.forEach.call(byId('group-filter').querySelectorAll('button[data-group]'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-group') === name ? 'true' : 'false');
    });
  }

  byId('group-filter').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-group]');
    if (!button) return;
    setGroup(button.getAttribute('data-group'));
    renderList();
  });

  // A Set keeps insertion order and so does the stored array, which makes the
  // last entry the last thing hidden - even after a reload.
  function restoreLast() {
    var hidden = Array.from(state.ignored);
    if (!hidden.length) return;
    state.ignored['delete'](hidden[hidden.length - 1]);
    saveIgnored();
    refresh();
  }
  byId('restore').addEventListener('click', restoreLast);

  // Undoing a hide is the one thing worth reaching for far from the toolbar -
  // right-clicking anywhere in the report offers it where the reader is
  // already looking. Shift+right-click still opens the browser's own menu.
  var ctxMenu = byId('ctxmenu');
  var ctxRestore = byId('ctx-restore');
  function closeCtxMenu() { ctxMenu.hidden = true; }
  function openCtxMenu(x, y) {
    ctxRestore.disabled = state.ignored.size === 0;
    ctxMenu.hidden = false;
    // Measured while visible, so a click near an edge cannot push the menu off
    // screen.
    var rect = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
    if (!ctxRestore.disabled) ctxRestore.focus();
  }
  document.addEventListener('contextmenu', function (event) {
    if (event.shiftKey) return;
    event.preventDefault();
    openCtxMenu(event.clientX, event.clientY);
  });
  ctxRestore.addEventListener('click', function () {
    restoreLast();
    closeCtxMenu();
  });
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeCtxMenu(); });
  document.addEventListener('scroll', closeCtxMenu, true);
  window.addEventListener('resize', closeCtxMenu);
  window.addEventListener('blur', closeCtxMenu);

  // The page cannot post to GitHub itself, so the button hands over the exact
  // command that does - carrying the accepted pool as the list of ids to post.
  if (byId('pr-comments')) {
    byId('pr-comments').addEventListener('click', function () {
      var acceptedIds = allFindings.filter(function (f) { return state.accepted.has(f.id); })
        .map(function (f) { return f.id; });
      var command = reportData.postCommand + ' --include="' + acceptedIds.join(',') + '"';
      var box = byId('cmdbox');
      box.textContent = '';
      box.hidden = false;

      var info = el('p', 'cmd-info');
      info.textContent = acceptedIds.length
        ? 'Do PR #' + reportData.pr.number + ' trafi ' + acceptedIds.length + ' z ' + allFindings.length
          + ' znalezisk — dokładnie te zaakceptowane przyciskiem „Akceptuj",'
          + ' filtry widoku nie mają na to wpływu. Uruchom w terminalu:'
        : 'Żadne znalezisko nie zostało zaakceptowane, więc do PR #' + reportData.pr.number
          + ' nie trafi żaden komentarz. Zaakceptuj wybrane znaleziska przyciskiem „Akceptuj".';
      var code = el('pre', 'cmd');
      code.textContent = command;
      var actions = el('div', 'cmd-actions');
      var copy = el('button', 'act');
      copy.type = 'button';
      copy.textContent = 'Kopiuj polecenie';
      copy.addEventListener('click', function () {
        // Clipboard access is refused on file:// in some browsers; the command
        // stays selectable on the page, which is the fallback.
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(command).then(function () { copy.textContent = 'Skopiowano'; }, function () {});
      });
      var link = el('a');
      link.href = reportData.pr.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Otwórz PR #' + reportData.pr.number;
      actions.appendChild(copy);
      actions.appendChild(link);
      box.appendChild(info);
      // With an empty pool there is nothing to run, so the command is not
      // offered at all - only the note saying why.
      if (acceptedIds.length) {
        box.appendChild(code);
        box.appendChild(actions);
      }
    });
  }

  byId('restore-all').addEventListener('click', function () {
    state.ignored.clear();
    saveIgnored();
    refresh();
  });

  byId('clear-filters').addEventListener('click', function () {
    state.selectedSeverities.clear();
    syncSeverityChips();
    setGroup('files');
    setAllRules(true);
  });

  // ---------- file tree ----------
  // One row per reviewed path, nested by directory, counting only what the
  // current filters leave visible - the sidebar is a map of the review, so it
  // has to shrink with it.
  var fileRows = {};
  var dirRows = [];
  var sectionNodes = {};
  var treeCollapsed = false;

  function treeNode(name) { return { name: name, dirs: {}, order: [], files: [] }; }

  function buildTreeModel() {
    var root = treeNode('');
    var seen = {};
    reportData.files.forEach(function (file) {
      if (seen[file.path]) return;
      seen[file.path] = true;
      var parts = String(file.path).split('/');
      var leaf = parts.pop();
      var node = root;
      parts.forEach(function (part) {
        if (!node.dirs[part]) { node.dirs[part] = treeNode(part); node.order.push(part); }
        node = node.dirs[part];
      });
      node.files.push({ name: leaf, path: file.path });
    });
    return root;
  }

  // A chain of single-child directories folds into one row, the way GitHub
  // shows src/app/user-panel instead of three nested rows.
  function squashTree(node) {
    node.order.forEach(function (key) {
      var dir = node.dirs[key];
      while (dir.files.length === 0 && dir.order.length === 1) {
        var only = dir.dirs[dir.order[0]];
        dir.name += '/' + only.name;
        dir.dirs = only.dirs;
        dir.order = only.order;
        dir.files = only.files;
      }
      squashTree(dir);
    });
  }

  function collectPaths(node, into) {
    node.files.forEach(function (file) { into.push(file.path); });
    node.order.forEach(function (key) { collectPaths(node.dirs[key], into); });
    return into;
  }

  function renderTree(node, host) {
    node.order.forEach(function (key) {
      var dir = node.dirs[key];
      var row = el('div', 'tr-row tr-dir');
      var twisty = el('button', 'twisty-sm');
      twisty.type = 'button';
      twisty.textContent = '▾';
      var name = el('span', 'tr-name');
      name.textContent = dir.name + '/';
      var n = el('span', 'n');
      var kids = el('div', 'tr-kids');
      var entry = { row: row, kids: kids, n: n, twisty: twisty, collapsed: false, paths: collectPaths(dir, []) };
      row.appendChild(twisty);
      row.appendChild(name);
      row.appendChild(n);
      row.addEventListener('click', function () { setDirCollapsed(entry, !entry.collapsed); });
      host.appendChild(row);
      host.appendChild(kids);
      dirRows.push(entry);
      renderTree(dir, kids);
    });
    node.files.forEach(function (file) {
      var row = el('div', 'tr-row tr-file');
      var name = el('span', 'tr-name');
      name.textContent = file.name;
      var n = el('span', 'n');
      row.appendChild(name);
      row.appendChild(n);
      row.addEventListener('click', function () { focusFile(file.path); });
      host.appendChild(row);
      fileRows[file.path] = { row: row, n: n };
    });
  }

  function setDirCollapsed(entry, collapsed) {
    entry.collapsed = collapsed;
    entry.kids.hidden = collapsed;
    entry.twisty.textContent = collapsed ? '▸' : '▾';
  }

  function updateTree(counts, worst) {
    Object.keys(fileRows).forEach(function (filePath) {
      var entry = fileRows[filePath];
      var count = counts[filePath] || 0;
      entry.n.textContent = count;
      entry.n.style.color = count ? 'var(--sev-' + worst[filePath] + ')' : '';
      entry.row.hidden = count === 0;
    });
    dirRows.forEach(function (entry) {
      var total = 0;
      entry.paths.forEach(function (filePath) { total += counts[filePath] || 0; });
      entry.n.textContent = total;
      entry.row.hidden = total === 0;
      entry.kids.hidden = total === 0 || entry.collapsed;
    });
  }

  // Sections only exist in the files grouping, so a click from the flat list
  // switches back to it instead of scrolling nowhere.
  function focusFile(filePath) {
    if (state.group !== 'files') {
      setGroup('files');
      renderList();
    }
    var section = sectionNodes[filePath];
    if (!section) return;
    Object.keys(fileRows).forEach(function (key) { fileRows[key].row.classList.remove('active'); });
    if (fileRows[filePath]) fileRows[filePath].row.classList.add('active');
    section.open = true;
    section.scrollIntoView({ block: 'start' });
    section.classList.add('flash');
    setTimeout(function () { section.classList.remove('flash'); }, 1200);
  }

  if (byId('filetree')) {
    var treeModel = buildTreeModel();
    squashTree(treeModel);
    renderTree(treeModel, byId('filetree'));
    byId('tree-toggle').addEventListener('click', function () {
      treeCollapsed = !treeCollapsed;
      this.textContent = treeCollapsed ? 'Rozwiń' : 'Zwiń';
      dirRows.forEach(function (entry) { setDirCollapsed(entry, treeCollapsed); });
    });
  }

  var marks = { add: '+', del: '-', ctx: ' ', gap: ' ' };

  function snipRow(number, kind, text) {
    var row = el('div', 'snip-row snip-' + kind);
    var num = el('span', 'snip-n');
    // A gap row stands for the lines the fragment view skipped, so its gutter
    // carries the marker instead of a number it does not have.
    num.textContent = kind === 'gap' ? '⋯' : (number === null || number === undefined ? '' : number);
    var mark = el('span', 'snip-mark');
    mark.textContent = marks[kind] || ' ';
    var code = el('span', 'snip-code');
    code.textContent = text;
    row.appendChild(num);
    row.appendChild(mark);
    row.appendChild(code);
    return row;
  }

  // Split view, like GitHub: the file before the change on the left, after it on
  // the right. Inside one block of consecutive removals and additions the k-th
  // removal faces the k-th addition; whatever is left over faces a blank cell.
  // An unchanged line is the same line on both sides, printed with each file's
  // own numbering.
  function pairRows(lines) {
    var pairs = [];
    var dels = [];
    var adds = [];
    function flush() {
      for (var i = 0; i < Math.max(dels.length, adds.length); i++) {
        pairs.push([dels[i] || null, adds[i] || null]);
      }
      dels = [];
      adds = [];
    }
    lines.forEach(function (line) {
      if (line.kind === 'del') { dels.push(line); return; }
      if (line.kind === 'add') { adds.push(line); return; }
      flush();
      pairs.push([line, line]);
    });
    flush();
    return pairs;
  }

  // One cell of a pair: the left one is the old file (a removal, or an unchanged
  // line under its old number), the right one the new file. Only a changed line
  // takes its side's colour; context and gap markers keep their own kind.
  function sideRow(line, isOld, hits) {
    if (!line) return snipRow(null, 'blank', '');
    var kind = line.kind === 'add' || line.kind === 'del' ? (isOld ? 'del' : 'add') : line.kind;
    var row = snipRow(isOld ? line.oldN : line.n, kind, line.text);
    if (line.hit || (line.n !== null && hits.indexOf(line.n) !== -1)) row.classList.add('snip-hit');
    return row;
  }

  // Source lines go in as text nodes, exactly like every other report value, and
  // the highlight marker takes the finding's severity colour.
  function snipBody(rows, hits, color) {
    // Two identical columns say nothing, so a run of rows the diff never touched
    // - a folder review, or a finding on a line left alone - stays a plain file
    // view; anything with a +/- in it becomes a real split diff.
    var split = rows.some(function (line) { return line.kind === 'del' || line.kind === 'add'; });
    var body = el('div', split ? 'snip snip-split' : 'snip');
    body.style.setProperty('--hit-mark', color);
    if (!split) {
      rows.forEach(function (line) {
        var row = snipRow(line.n, line.kind || 'ctx', line.text);
        if (line.hit || (line.n !== null && hits.indexOf(line.n) !== -1)) row.classList.add('snip-hit');
        body.appendChild(row);
      });
      return body;
    }
    var sides = [el('div', 'snip-side'), el('div', 'snip-side')];
    pairRows(rows).forEach(function (pair) {
      sides[0].appendChild(sideRow(pair[0], true, hits));
      sides[1].appendChild(sideRow(pair[1], false, hits));
    });
    sides.forEach(function (side) { body.appendChild(side); });
    return body;
  }

  // The gap marker is what tells the reader the fragment view skipped something;
  // one continuous run of rows never needs it, which is why only this path adds
  // the markers between hunks.
  function fragmentRows(hunks) {
    var rows = [];
    hunks.forEach(function (hunk, index) {
      if (index) rows.push({ n: null, oldN: null, text: '', kind: 'gap', hit: false });
      hunk.lines.forEach(function (line) { rows.push(line); });
    });
    return rows;
  }

  // The whole file opens at line 1, which is almost never where the finding is.
  // "First" has to mean highest on the page rather than first in document order,
  // because a split view lays the entire old column out before the new one: a
  // cited line that was added exists only on the right, so the first hit in the
  // DOM can easily be a later line that happens to sit on the left. offsetTop
  // would be measured against whatever the split grid positions, so the offset
  // is taken from the boxes themselves.
  function showFirstHit(body) {
    body.classList.add('snip-full');
    var boxTop = body.getBoundingClientRect().top;
    var top = null;
    [].forEach.call(body.querySelectorAll('.snip-hit'), function (row) {
      var offset = row.getBoundingClientRect().top;
      if (top === null || offset < top) top = offset;
    });
    if (top === null) return;
    body.scrollTop += top - boxTop - 60;
  }

  function snippet(f, color, file) {
    var box = el('details', 'snipbox');
    var summary = el('summary');
    var title = el('span', 'snip-title');
    title.textContent = 'Kod · linie ' + f.lines;
    summary.appendChild(title);

    var hits = f.snippet.hits || [];
    var views = {
      part: function () { return snipBody(fragmentRows(f.snippet.hunks), [], color); },
      full: function () { return snipBody(file.full.rows, hits, color); },
    };
    var body = views.part();

    var modes = el('div', 'snip-modes');
    var buttons = {};
    [['part', 'Fragment'], ['full', 'Cały plik']].forEach(function (pair) {
      var button = el('button');
      button.type = 'button';
      button.textContent = pair[1];
      button.setAttribute('aria-pressed', String(pair[0] === 'part'));
      if (pair[0] === 'full' && !file.full) {
        button.disabled = true;
        button.title = file.fullLines
          ? 'Plik ma ' + file.fullLines + ' linii (limit 3000) - dostępny tylko fragment'
          : 'Nie udało się odczytać pliku - dostępny tylko fragment';
      }
      button.addEventListener('click', function (event) {
        // Inside a <summary> the default action collapses the box, so the switch
        // would close the very view it was asked to change.
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled || button.getAttribute('aria-pressed') === 'true') { box.open = true; return; }
        buttons.part.setAttribute('aria-pressed', String(pair[0] === 'part'));
        buttons.full.setAttribute('aria-pressed', String(pair[0] === 'full'));
        var next = views[pair[0]]();
        box.replaceChild(next, body);
        body = next;
        box.open = true;
        if (pair[0] === 'full') showFirstHit(next);
      });
      buttons[pair[0]] = button;
      modes.appendChild(button);
    });
    summary.appendChild(modes);

    box.appendChild(summary);
    box.appendChild(body);
    return box;
  }

  function card(f, withPath) {
    var node = el('div', 'finding');
    var color = 'var(--sev-' + f.severity + ')';
    node.style.borderLeftColor = color;

    var head = el('div', 'f-head');
    var sev = el('span', 'f-sev');
    sev.style.color = color;
    sev.textContent = (severityByKey[f.severity] ? severityByKey[f.severity].emoji + ' ' + severityByKey[f.severity].label : f.severity);
    head.appendChild(sev);

    var lines = el('span', 'f-lines');
    String(f.lines).split(',').forEach(function (part) {
      var value = part.trim();
      if (!value) return;
      var badge = el('code');
      badge.textContent = value;
      lines.appendChild(badge);
    });
    head.appendChild(lines);

    var isAccepted = state.accepted.has(f.id);
    if (isAccepted) {
      node.classList.add('accepted');
      var tag = el('span', 'f-accepted-tag');
      tag.textContent = '✓ W puli komentarzy PR';
      head.appendChild(tag);
    }

    var accept = el('button', 'act f-accept');
    accept.type = 'button';
    accept.textContent = isAccepted ? 'Cofnij akceptację' : 'Akceptuj';
    accept.title = isAccepted
      ? 'Usuń to znalezisko z puli komentarzy wysyłanych do PR-a'
      : 'Zwiń to znalezisko i dodaj je do puli komentarzy wysyłanych do PR-a';
    accept.setAttribute('aria-pressed', isAccepted ? 'true' : 'false');
    accept.addEventListener('click', function () {
      if (isAccepted) state.accepted['delete'](f.id); else state.accepted.add(f.id);
      saveAccepted();
      refresh();
    });
    head.appendChild(accept);

    var hide = el('button', 'act f-hide');
    hide.type = 'button';
    hide.textContent = 'Ukryj';
    hide.title = 'Ukryj to znalezisko';
    hide.addEventListener('click', function () {
      state.ignored.add(f.id);
      // A hidden finding cannot stay in the pool: nothing on the page would
      // show that it is still on its way to the PR.
      state.accepted['delete'](f.id);
      saveIgnored();
      saveAccepted();
      refresh();
    });
    head.appendChild(hide);

    if (withPath) {
      var p = el('span', 'f-path');
      p.textContent = f.filePath;
      head.appendChild(p);
    }
    node.appendChild(head);

    // Everything below the head line lives in one wrapper, so accepting a
    // finding collapses it to that line with a single class.
    var body = el('div', 'f-body');
    var problem = el('div', 'f-problem');
    problem.appendChild(rich(f.problem));
    body.appendChild(problem);

    var grid = el('dl', 'f-grid');
    [['Reguła', f.rule], ['Oczekiwany stan', f.expected]].forEach(function (pair) {
      var dt = el('dt');
      dt.textContent = pair[0];
      var dd = el('dd');
      dd.appendChild(rich(pair[1]));
      grid.appendChild(dt);
      grid.appendChild(dd);
    });
    body.appendChild(grid);
    if (f.snippet && f.snippet.hunks.length) body.appendChild(snippet(f, color, reportData.files[f.fileIndex]));
    node.appendChild(body);
    return node;
  }

  function renderList(counts) {
    counts = counts || tally();
    var shown = allFindings.filter(visible);
    byId('visible-count').textContent = 'Widoczne: ' + shown.length + ' z ' + counts.active;
    var perPath = {}, worstPerPath = {};
    shown.forEach(function (f) {
      perPath[f.filePath] = (perPath[f.filePath] || 0) + 1;
      var best = worstPerPath[f.filePath];
      if (best === undefined || f.rank < severityByKey[best].rank) worstPerPath[f.filePath] = f.severity;
    });
    updateTree(perPath, worstPerPath);
    sectionNodes = {};
    host.textContent = '';
    if (!shown.length) {
      host.appendChild(note('Brak znalezisk spełniających kryteria.'));
      return;
    }
    if (state.group === 'files') {
      reportData.files.forEach(function (file, fileIndex) {
        var mine = shown.filter(function (f) { return f.fileIndex === fileIndex; });
        if (!mine.length) return;
        var section = el('details', 'filesec');
        section.open = true;
        var summary = el('summary');
        var label = el('span');
        label.textContent = file.path;
        var n = el('span', 'n');
        n.textContent = mine.length;
        summary.appendChild(label);
        summary.appendChild(n);
        var list = el('div', 'list');
        mine.forEach(function (f) { list.appendChild(card(f, false)); });
        section.appendChild(summary);
        section.appendChild(list);
        // The cross-file pass may add a second section for a path; the tree
        // jumps to the first one, where that file's findings start.
        if (!sectionNodes[file.path]) sectionNodes[file.path] = section;
        host.appendChild(section);
      });
      return;
    }
    var flat = el('div', 'list');
    shown.slice().sort(function (a, b) {
      return a.rank - b.rank
        || a.filePath.localeCompare(b.filePath, 'pl')
        || a.order - b.order;
    }).forEach(function (f) { flat.appendChild(card(f, true)); });
    host.appendChild(flat);
  }

  function refresh() {
    var counts = tally();
    reportData.severities.forEach(function (s) { chipNodes[s.key].n.textContent = counts.sev[s.key] || 0; });
    var selected = 0;
    groupNodes.forEach(function (entry) {
      var total = 0;
      entry.group.rules.forEach(function (r) {
        var value = counts.rule[r.key] || 0;
        ruleNodes[r.key].n.textContent = value;
        ruleNodes[r.key].row.hidden = value === 0;
        total += value;
        if (state.selectedRules.has(r.key)) selected++;
      });
      entry.n.textContent = total;
      entry.wrap.hidden = total === 0;
    });
    var allRules = Object.keys(ruleNodes).length;
    byId('rule-summary').textContent = selected === allRules
      ? 'wszystkie (' + allRules + ')'
      : 'wybrane ' + selected + ' z ' + allRules;
    var ignored = state.ignored.size;
    byId('ignored-count').textContent = 'Zignorowane: ' + ignored;
    byId('accepted-count').textContent = 'Zaakceptowane: ' + state.accepted.size;
    byId('restore').disabled = ignored === 0;
    byId('restore-all').disabled = ignored === 0;
    renderList(counts);
  }

  refresh();
}());
`;

function renderHtml(report, reportName) {
  const payload = buildPayload(report, reportName);
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const total = report.files.reduce((sum, file) => sum + file.findings.length, 0);
  // Sections, not files: Step 4 lets the cross-file pass append a second `##`
  // section for a path the per-file pass already reported.
  const fileCount = new Set(report.files.map((file) => file.path)).size;
  const meta = report.emptyState
    ? escapeHtml(report.datetime)
    : `${escapeHtml(report.datetime)} · ${total} ${plural(total, 'znalezisko', 'znaleziska', 'znalezisk')}`
      + ` · ${fileCount} ${plural(fileCount, 'plik', 'pliki', 'plików')}`;
  const skipped = report.skipped.length
    ? `\n      <p class="skipped">${escapeHtml(skippedPrefix)} ${escapeHtml(report.skipped.join(', '))}</p>`
    : '';
  // The missing button is the symptom the reader actually sees, so the reason
  // belongs next to it on the page - stderr scrolls past long before anyone
  // opens the report.
  const prWarning = report.prWarning
    ? `\n      <p class="pr-warning">${escapeHtml(report.prWarning)}</p>`
    : '';
  const prButton = report.pr
    ? `\n        <button type="button" class="act" id="pr-comments">Dodaj komentarze do PR #${escapeHtml(String(report.pr.number))}</button>`
    : '';
  const toolbar = report.emptyState ? '' : `
    <section class="toolbar" id="toolbar">
      <div class="row">
        <span class="row-label">Severity</span>
        <div class="chips" id="sev-filter"></div>
      </div>
      <div class="row row-top">
        <span class="row-label">Reguła</span>
        <details class="rulebox">
          <summary><span id="rule-summary">wszystkie</span></summary>
          <div class="tree-actions">
            <button type="button" class="act" id="rules-all">Zaznacz wszystkie</button>
            <button type="button" class="act" id="rules-none">Odznacz wszystkie</button>
          </div>
          <div class="tree" id="rule-tree"></div>
        </details>
        <div class="group-ctl">
          <span class="row-label">Grupowanie</span>
          <div class="segmented" id="group-filter">
            <button type="button" data-group="files" aria-pressed="true">Pliki</button>
            <button type="button" data-group="global" aria-pressed="false">Globalnie</button>
          </div>
        </div>
      </div>
      <div class="row status">
        <span id="visible-count"></span>
        <span class="grow"></span>
        <span id="accepted-count" class="accepted-count"></span>
        <span id="ignored-count"></span>
        <button type="button" class="act" id="restore" title="Przywróć ostatnio ukryte znalezisko" disabled>Przywróć</button>
        <button type="button" class="act" id="restore-all" disabled>Przywróć wszystkie</button>
        <button type="button" class="act" id="clear-filters">Wyczyść filtry</button>${prButton}
      </div>
      <div class="cmdbox" id="cmdbox" hidden></div>
    </section>
    <div class="ctxmenu" id="ctxmenu" role="menu" hidden>
      <button type="button" role="menuitem" id="ctx-restore">Przywróć ostatnio ukryte znalezisko</button>
    </div>
`;

  // The coverage row of a mechanical file has no items to count, so it is left
  // out of the totals and only counted as one more walked file.
  const walked = payload.coverage.filter((entry) => !entry.mechanical);
  const covChecked = walked.reduce((sum, entry) => sum + entry.checked, 0);
  const covTotal = walked.reduce((sum, entry) => sum + entry.total, 0);
  const covShort = walked.filter((entry) => entry.checked < entry.total).length;
  const covFiles = payload.coverage.length;
  const covMeta = `${covFiles} ${plural(covFiles, 'plik', 'pliki', 'plików')}`
    + ` · ${covChecked}/${covTotal} ${plural(covTotal, 'pozycja', 'pozycje', 'pozycji')}`
    + (covShort ? ` · ${covShort} ${plural(covShort, 'plik bez pełnego przejścia', 'pliki bez pełnego przejścia', 'plików bez pełnego przejścia')}` : '');
  const coverage = covFiles === 0 ? '' : `
    <details class="coverage" id="coverage" hidden>
      <summary><span>Pokrycie checklist</span><span class="cov-meta">${escapeHtml(covMeta)}</span></summary>
      <div class="cov-body" id="cov-body"></div>
    </details>
`;

  const sidebar = report.emptyState ? '' : `
      <aside class="sidebar">
        <div class="sidebar-head">
          <span class="grow">Struktura plików</span>
          <button type="button" class="act" id="tree-toggle">Zwiń</button>
        </div>
        <div class="filetree" id="filetree"></div>
      </aside>`;

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title || 'Code Review')}</title>
<style>${pageCss}</style>
<script>/* Before the first paint, so a remembered theme never flashes the other one. */
try{var t=localStorage.getItem('doh-code-review:theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>
</head>
<body>
  <div class="wrap">
    <header class="head">
      <button type="button" class="act theme-toggle" id="theme-toggle">Tryb ciemny</button>
      <h1>${escapeHtml(report.title || 'Code Review')}</h1>
      <p class="meta">${meta}</p>${skipped}${prWarning}
    </header>
${toolbar}    <noscript><div class="note">Ten raport wymaga włączonego JavaScriptu.</div></noscript>
    <div class="cols${report.emptyState ? ' cols-plain' : ''}">${sidebar}
      <main id="findings"></main>
    </div>
${coverage}  </div>
<script id="report-data" type="application/json">${json}</script>
<script>${pageJs}</script>
</body>
</html>
`;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    return 1;
  }
  let markdown;
  try {
    markdown = fs.readFileSync(args.report, 'utf8');
  } catch (err) {
    process.stderr.write(`Nie można odczytać raportu: ${args.report} (${(err && err.message) || err})\n`);
    return 1;
  }
  const report = parseReport(markdown);
  const projectRoot = projectRootFor(args.report, args.project);
  attachSnippets(report, projectRoot, { mode: args.mode, base: args.base, branch: args.branch });
  const pullRequest = report.emptyState ? { pr: null, warning: null } : detectPullRequest(projectRoot, args.branch);
  report.pr = pullRequest.pr;
  report.prWarning = pullRequest.warning || '';
  report.postCommand = report.pr ? postCommandFor(projectRoot, args.out) : '';
  try {
    fs.writeFileSync(args.out, renderHtml(report, path.basename(args.out)), 'utf8');
  } catch (err) {
    process.stderr.write(`Nie można zapisać raportu HTML: ${args.out} (${(err && err.message) || err})\n`);
    return 1;
  }
  // Not a parser warning: it says nothing about the report format, so it never
  // makes the Markdown below stay behind.
  if (pullRequest.warning) process.stderr.write(`${pullRequest.warning}\n`);
  // Also not a parser warning: an older report simply has no markers, so this
  // says the coverage could not be confirmed - it never keeps the Markdown.
  if (report.coverage.length === 0 && !report.emptyState) {
    process.stderr.write('Raport nie zawiera znaczników coverage - nie potwierdzono pełnego przejścia checklist.\n');
  }
  for (const warning of report.warnings) process.stderr.write(`Ostrzeżenie parsera: ${warning}\n`);
  // The Markdown is only discarded when it was understood completely: a kept
  // source file is the signal that the report format drifted.
  if (report.warnings.length) {
    process.stderr.write(`Zachowano źródłowy Markdown: ${args.report}\n`);
  } else if (!args.keepSource && path.resolve(args.report) !== path.resolve(args.out)) {
    try {
      fs.unlinkSync(args.report);
    } catch (err) {
      // Without this the leftover .md would be indistinguishable from the
      // "parser hit something unexpected" signal above.
      process.stderr.write(`Nie udało się usunąć źródłowego Markdownu: ${args.report} (${(err && err.message) || err})\n`);
    }
  }
  process.stdout.write(`${args.out}\n`);
  return 0;
}

module.exports = {
  parseArgs, parseRuleField, parseReport, findingId, parseLineRanges, parseDiff, buildSnippet, buildFullView,
  projectRootFor, attachSnippets, buildPayload, renderHtml, detectPullRequest, main,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
