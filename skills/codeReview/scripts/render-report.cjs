#!/usr/bin/env node
'use strict';

// Renders an assembled codeReview Markdown report into a self-contained,
// interactive HTML page. The Markdown produced by SKILL.md Steps 3-4 stays the
// intermediate representation; this script parses it and is the only place that
// knows about the HTML output.

const fs = require('node:fs');
const path = require('node:path');

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
const fields = { 'Linia': 'lines', 'Problem': 'problem', 'Reguła': 'rule', 'Expected Result': 'expected' };

// The severity lead line is accepted with and without a leading `- `: the
// no-dash form is the current Step 4 rule, the dashed form is what every report
// written before it looks like.
const reHeader = /^#\s+(.+?)\s+\|\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*$/;
const reSection = /^##\s+(.+?)\s*$/;
const reSeverity = /^(?:-\s+)?(⚪|🟡|🔴|🟤|🔵)\uFE0F?\s*\*\*(.+?)\*\*\s*$/;
const reField = /^-\s+\*\*(Linia|Problem|Reguła|Expected Result):\*\*\s?(.*)$/;

function parseArgs(argv) {
  const args = { report: '', out: '', keepSource: false };
  for (const arg of argv) {
    if (arg === '--keep-source') {
      args.keepSource = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'report') args.report = m[2];
    else if (m[1] === 'out') args.out = m[2];
  }
  if (!args.report) throw new Error('No report given (expected --report="path/to/report.md").');
  if (!args.out) args.out = args.report.replace(/\.md$/i, '') + '.html';
  return args;
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
    const explicit = left.match(/[A-Za-z0-9._-]+\.md/g);
    const names = explicit || splitInstructionNames(left);
    for (const file of names.length ? names : [noFileLabel]) tags.push({ file, rule });
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

function parseReport(markdown) {
  const report = { title: '', datetime: '', skipped: [], emptyState: null, files: [], warnings: [] };
  const lines = String(markdown).split(/\r?\n/);
  let section = null;
  let finding = null;
  let field = null;
  let headerSeen = false;

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
        lines: '', problem: '', rule: '', expected: '',
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
    severities: severities
      .filter((s) => allFindings.some((f) => f.severity === s.key))
      .map(({ key, label, emoji }) => ({ key, label, emoji })),
    ruleGroups,
    files: report.files.map((file) => ({
      path: file.path,
      findings: file.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        lines: finding.lines,
        problem: finding.problem,
        rule: finding.rule,
        expected: finding.expected,
        tagKeys: finding.tags.map((tag) => keyOf.get(`${tag.file}\n${tag.rule}`)),
      })),
    })),
  };
}

const pageCss = `
*,*::before,*::after{box-sizing:border-box}
:root{color-scheme:light dark;
  --bg:#f5f6f8;--panel:#fff;--panel-2:#fafbfc;--text:#1b1e23;--muted:#68707c;--border:#dee2e7;
  --accent:#2563eb;--code-bg:#eceff3;--shadow:0 1px 2px rgba(16,22,32,.06);
  --sev-critical:#8a5a2b;--sev-high:#c0392b;--sev-medium:#b0761a;--sev-low:#78808d;--sev-missing-unit-test:#2563eb}
@media (prefers-color-scheme:dark){:root{
  --bg:#141619;--panel:#1c1f24;--panel-2:#22262c;--text:#e5e8ec;--muted:#98a1ac;--border:#2f343b;
  --accent:#6ea8fe;--code-bg:#282d34;--shadow:none;
  --sev-critical:#c58f59;--sev-high:#f0736a;--sev-medium:#e0b341;--sev-low:#98a2b0;--sev-missing-unit-test:#6ea8fe}}
body{margin:0;background:var(--bg);color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px 72px}
code{font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;font-size:.88em;
  background:var(--code-bg);border-radius:4px;padding:.1em .35em;overflow-wrap:anywhere}
button{font:inherit;color:inherit}

.head{padding:26px 0 14px}
.head h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere}
.head .meta{margin-top:6px;color:var(--muted);font-size:13.5px}
.head .skipped{margin-top:8px;color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}

.toolbar{position:sticky;top:0;z-index:5;background:var(--panel);border:1px solid var(--border);
  border-radius:10px;padding:12px 14px;box-shadow:var(--shadow);margin-bottom:18px}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.row+.row{margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
/* The rule tree grows tall when expanded; keeping this row top-aligned stops
   its labels and the grouping control from floating to the middle. */
.row-top{align-items:flex-start}
.row-top .row-label,.row-top .segmented{margin-top:4px}
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
.tree{max-height:340px;overflow:auto;border-top:1px solid var(--border);padding:6px}
.grp{padding:1px 0}
.grp-head{display:flex;align-items:center;gap:7px;padding:3px 4px;border-radius:6px}
.grp-head:hover{background:var(--panel)}
.twisty{width:20px;flex:0 0 auto;border:0;background:none;cursor:pointer;color:var(--muted);padding:0}
.grp-name{flex:1 1 auto;cursor:pointer;overflow-wrap:anywhere;font-size:13.5px}
.n{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;flex:0 0 auto}
.kids{margin:2px 0 6px 27px;display:flex;flex-direction:column;gap:2px}
.kid{display:flex;align-items:flex-start;gap:7px;font-size:13px;color:var(--muted)}
.kid label{cursor:pointer;overflow-wrap:anywhere}
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

.filesec{margin-bottom:16px}
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
.f-hide{margin-left:auto}
.f-problem{margin-top:8px;overflow-wrap:anywhere}
.f-grid{margin-top:9px;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;
  font-size:13.5px;color:var(--muted)}
.f-grid dt{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding-top:2px}
.f-grid dd{margin:0;color:var(--text);overflow-wrap:anywhere}
@media (max-width:620px){.f-grid{grid-template-columns:minmax(0,1fr);gap:1px}
  .f-grid dd{margin-bottom:7px}.row-label{width:auto}}

.note{background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:22px;
  text-align:center;color:var(--muted)}
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

  var state = {
    selectedSeverities: new Set(reportData.severities.map(function (s) { return s.key; })),
    selectedRules: new Set(),
    group: 'files',
    ignored: loadIgnored()
  };
  reportData.ruleGroups.forEach(function (g) { g.rules.forEach(function (r) { state.selectedRules.add(r.key); }); });

  function visible(f) {
    if (state.ignored.has(f.id)) return false;
    if (!state.selectedSeverities.has(f.severity)) return false;
    if (!f.tagKeys.length) return true;
    for (var i = 0; i < f.tagKeys.length; i++) if (state.selectedRules.has(f.tagKeys[i])) return true;
    return false;
  }

  // Counts are totals over everything not ignored: they react to hiding a
  // finding but stay put while filters are being adjusted.
  function tally() {
    var sev = {}, rule = {}, active = 0;
    allFindings.forEach(function (f) {
      if (state.ignored.has(f.id)) return;
      active++;
      sev[f.severity] = (sev[f.severity] || 0) + 1;
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
      chip.setAttribute('aria-pressed', state.selectedSeverities.has(s.key) ? 'true' : 'false');
      renderList();
    });
    chipNodes[s.key] = n;
    byId('sev-filter').appendChild(chip);
  });

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
      box.indeterminate = false;
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
      ruleNodes[r.key] = { box: kbox, n: kn };
    });

    head.appendChild(twisty);
    head.appendChild(box);
    head.appendChild(name);
    head.appendChild(n);
    wrap.appendChild(head);
    wrap.appendChild(kids);
    byId('rule-tree').appendChild(wrap);
    groupNodes.push({ group: g, box: box, n: n });
  });

  function syncGroup(g, box) {
    var on = 0;
    g.rules.forEach(function (r) { if (state.selectedRules.has(r.key)) on++; });
    box.checked = on > 0;
    box.indeterminate = on > 0 && on < g.rules.length;
  }

  byId('group-filter').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-group]');
    if (!button) return;
    state.group = button.getAttribute('data-group');
    Array.prototype.forEach.call(this.querySelectorAll('button[data-group]'), function (b) {
      b.setAttribute('aria-pressed', b === button ? 'true' : 'false');
    });
    renderList();
  });

  byId('restore').addEventListener('click', function () {
    state.ignored.clear();
    saveIgnored();
    refresh();
  });

  byId('clear-filters').addEventListener('click', function () {
    reportData.severities.forEach(function (s) { state.selectedSeverities.add(s.key); });
    Array.prototype.forEach.call(byId('sev-filter').querySelectorAll('.chip'), function (c) {
      c.setAttribute('aria-pressed', 'true');
    });
    reportData.ruleGroups.forEach(function (g) { g.rules.forEach(function (r) { state.selectedRules.add(r.key); }); });
    groupNodes.forEach(function (entry) { entry.box.checked = true; entry.box.indeterminate = false; });
    Object.keys(ruleNodes).forEach(function (key) { ruleNodes[key].box.checked = true; });
    refresh();
  });

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

    var hide = el('button', 'act f-hide');
    hide.type = 'button';
    hide.textContent = 'Ukryj';
    hide.title = 'Ukryj to znalezisko';
    hide.addEventListener('click', function () {
      state.ignored.add(f.id);
      saveIgnored();
      refresh();
    });
    head.appendChild(hide);

    if (withPath) {
      var p = el('span', 'f-path');
      p.textContent = f.filePath;
      head.appendChild(p);
    }
    node.appendChild(head);

    var problem = el('div', 'f-problem');
    problem.appendChild(rich(f.problem));
    node.appendChild(problem);

    var grid = el('dl', 'f-grid');
    [['Reguła', f.rule], ['Oczekiwany stan', f.expected]].forEach(function (pair) {
      var dt = el('dt');
      dt.textContent = pair[0];
      var dd = el('dd');
      dd.appendChild(rich(pair[1]));
      grid.appendChild(dt);
      grid.appendChild(dd);
    });
    node.appendChild(grid);
    return node;
  }

  function renderList(counts) {
    counts = counts || tally();
    var shown = allFindings.filter(visible);
    byId('visible-count').textContent = 'Widoczne: ' + shown.length + ' z ' + counts.active;
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
    reportData.severities.forEach(function (s) { chipNodes[s.key].textContent = counts.sev[s.key] || 0; });
    var selected = 0;
    groupNodes.forEach(function (entry) {
      var total = 0;
      entry.group.rules.forEach(function (r) {
        var value = counts.rule[r.key] || 0;
        ruleNodes[r.key].n.textContent = value;
        total += value;
        if (state.selectedRules.has(r.key)) selected++;
      });
      entry.n.textContent = total;
    });
    var allRules = Object.keys(ruleNodes).length;
    byId('rule-summary').textContent = selected === allRules
      ? 'wszystkie (' + allRules + ')'
      : 'wybrane ' + selected + ' z ' + allRules;
    var ignored = state.ignored.size;
    byId('ignored-count').textContent = 'Zignorowane: ' + ignored;
    byId('restore').disabled = ignored === 0;
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
          <div class="tree" id="rule-tree"></div>
        </details>
        <span class="row-label">Grupowanie</span>
        <div class="segmented" id="group-filter">
          <button type="button" data-group="files" aria-pressed="true">Pliki</button>
          <button type="button" data-group="global" aria-pressed="false">Globalnie</button>
        </div>
      </div>
      <div class="row status">
        <span id="visible-count"></span>
        <span class="grow"></span>
        <span id="ignored-count"></span>
        <button type="button" class="act" id="restore" disabled>Przywróć</button>
        <button type="button" class="act" id="clear-filters">Wyczyść filtry</button>
      </div>
    </section>
`;

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.title || 'Code Review')}</title>
<style>${pageCss}</style>
</head>
<body>
  <div class="wrap">
    <header class="head">
      <h1>${escapeHtml(report.title || 'Code Review')}</h1>
      <p class="meta">${meta}</p>${skipped}
    </header>
${toolbar}    <noscript><div class="note">Ten raport wymaga włączonego JavaScriptu.</div></noscript>
    <main id="findings"></main>
  </div>
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
  try {
    fs.writeFileSync(args.out, renderHtml(report, path.basename(args.out)), 'utf8');
  } catch (err) {
    process.stderr.write(`Nie można zapisać raportu HTML: ${args.out} (${(err && err.message) || err})\n`);
    return 1;
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

module.exports = { parseArgs, parseRuleField, parseReport, findingId, buildPayload, renderHtml, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
