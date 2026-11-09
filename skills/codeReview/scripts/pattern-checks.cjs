'use strict';

// Patterns a script finds for certain, handed to the walker as hints on the lines the diff added:
// each one names the checklist item it may break, and the walker confirms it as a finding or
// drops it after reading the code. Never a finding by itself.
//
// Why: on 2026-11-06 the reviewers of DPXN-11967 raised points the rulebook already held -
// a signal read twice in a template (component-template#2), `as unknown as` in a mock
// (unit-tests#22), a bare `::ng-deep` (component-styles#5), a command cancelled by `switchMap`
// (ngrx-effects#7) - on files the review had walked. A walker reading 20 items of a 300-line
// file passes one by; a regular expression does not. Each check below is narrow on purpose:
// a hint that is wrong most of the time teaches the walker to ignore the section.

const reSignalRead = /(?<![\w$.?!])([a-z][A-Za-z0-9_$]*)\(\)/g;
const templateKeywords = new Set(['if', 'for', 'switch', 'case', 'track', 'let', 'defer', 'when', 'on', 'empty', 'placeholder', 'loading', 'error', 'else']);
const reCommandCall = /\.(post|put|patch|delete)\s*\(|\.(?:create|update|delete|remove|save|write|load|unload|read|run|start|execute|send|submit|retry|import|export)\w*\s*\(/i;

// The lines a unified patch adds, with their numbers in the new file.
function addedLines(patch) {
  const out = [];
  let at = 0;
  let inHunk = false;
  for (const line of String(patch || '').split(/\r?\n/)) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { at = Number(hunk[1]); inHunk = true; continue; }
    if (line.startsWith('diff --git')) { inHunk = false; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) { out.push({ line: at, text: line.slice(1) }); at += 1; } else if (line.startsWith(' ')) at += 1;
  }
  return out;
}

function templateHints(added, content) {
  const hints = [];
  const text = content || added.map((a) => a.text).join('\n');
  const declared = new Set([...text.matchAll(/@let\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]));
  const counts = new Map();
  for (const m of text.matchAll(reSignalRead)) {
    if (templateKeywords.has(m[1]) || declared.has(m[1])) continue;
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  const named = new Set();
  for (const a of added) {
    for (const m of a.text.matchAll(reSignalRead)) {
      const name = m[1];
      if (named.has(name) || (counts.get(name) || 0) < 2) continue;
      named.add(name);
      hints.push({ line: a.line, item: 'component-template#2', note: `\`${name}()\` is read ${counts.get(name)} times in this template - one \`@let\` at the top of its block, if it is a signal or computed` });
    }
  }
  return hints;
}

function effectHints(added, content) {
  const hints = [];
  const lines = content ? content.split(/\r?\n/) : null;
  for (const a of added) {
    if (!/\bswitchMap\s*\(/.test(a.text)) continue;
    const ahead = lines ? lines.slice(a.line - 1, a.line + 7).join('\n') : added.filter((b) => b.line >= a.line && b.line <= a.line + 7).map((b) => b.text).join('\n');
    const call = ahead.match(reCommandCall);
    if (call) hints.push({ line: a.line, item: 'ngrx-effects#7', note: `\`switchMap\` over \`${call[0].replace(/\s*\($/, '').replace(/^\./, '')}\` - a command cancelled by the next action of its type; \`mergeMap\`/\`concatMap\`/\`exhaustMap\` unless it is a read` });
  }
  return hints;
}

function specHints(added) {
  const hints = [];
  for (const a of added) {
    if (/\bas\s+unknown\s+as\b/.test(a.text)) hints.push({ line: a.line, item: 'unit-tests#22', note: '`as unknown as` - type the mock with `Partial<X>` / `satisfies`, or one `as X`' });
    if (/toHaveBeenCalledWith\(\s*\)/.test(a.text)) hints.push({ line: a.line, item: 'unit-tests#30', note: 'an empty `toHaveBeenCalledWith()` - a spy called with no arguments is asserted with `toHaveBeenCalled()`' });
  }
  return hints;
}

function styleHints(added, content) {
  const hints = [];
  const lines = content ? content.split(/\r?\n/) : null;
  for (const a of added) {
    if (/::ng-deep/.test(a.text)) {
      const before = lines ? lines.slice(0, a.line - 1).join('\n') : '';
      const open = (before.match(/:host\s*\{/g) || []).length > 0 && depthAfter(before, ':host') > 0;
      if (!open) hints.push({ line: a.line, item: 'component-styles#5', note: '`::ng-deep` outside `:host { ... }`' });
    }
    const repeated = a.text.match(/\.([A-Za-z][\w-]*)\.\1(?![\w-])/);
    if (repeated) hints.push({ line: a.line, item: 'component-styles#5', note: `\`.${repeated[1]}.${repeated[1]}\` raises specificity by repeating a class - select by the component's own structure` });
  }
  return hints;
}

// How many braces the text leaves open after the last `marker`.
function depthAfter(text, marker) {
  const at = text.lastIndexOf(marker);
  if (at < 0) return 0;
  let depth = 0;
  for (const ch of text.slice(at)) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth;
}

function componentHints(added) {
  const hints = [];
  for (const a of added) {
    const m = a.text.match(/^\s*(?:readonly\s+|public\s+|protected\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*inject\s*(?:<[^>]*>)?\s*\(\s*MAT_DIALOG_DATA\b/);
    if (m && !/\bprivate\b/.test(a.text)) hints.push({ line: a.line, item: 'feature-component#17', note: `dialog data in a non-private field \`${m[1]}\` - \`private readonly _dialogData\`, the template reads only the fields it needs` });
  }
  return hints;
}

// Hints for one reviewed file: `patch` its own diff, `content` its text at the reviewed revision
// (optional - the added lines stand in for it).
function hintsFor({ path, patch, content = null }) {
  const added = addedLines(patch);
  if (added.length === 0) return [];
  const p = String(path || '');
  if (/\.html?$/i.test(p)) return templateHints(added, content);
  if (/\.(s?css|less)$/i.test(p)) return styleHints(added, content);
  if (/\.spec\.[cm]?[jt]sx?$/i.test(p)) return specHints(added);
  if (/\.effects\.[cm]?ts$/i.test(p)) return [...effectHints(added, content), ...componentHints(added)];
  if (/\.[cm]?ts$/i.test(p)) return componentHints(added);
  return [];
}

module.exports = { addedLines, hintsFor };
