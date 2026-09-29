#!/usr/bin/env node
'use strict';

// Deterministic rulebook lookup for the implementNewFeature agents (and fixPr's fix
// agent): given project-relative file paths, prints which doh:codeReview file kind
// each one is and hands over that kind's checklist as one Markdown file to read. The
// rulebook is loaded and matched by the codeReview skill's own code, so what an agent
// follows while writing a file is exactly what the review later walks it against.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_INSTRUCTIONS_DIR = path.resolve(__dirname, '..', '..', 'codeReview', 'instructions');
// The skill's own git-ignored folder, never the project: an agent working in a
// worktree would otherwise commit the copies together with its code.
const DEFAULT_RULES_DIR = path.resolve(__dirname, '..', '.implementNewFeature', 'rules');

let rulebook = null;
try {
  rulebook = require('../../codeReview/scripts/rulebook.cjs');
} catch {
  // reported as a JSON error in buildOutput
}

function parseArgs(argv) {
  const args = { files: [], instructionsDir: DEFAULT_INSTRUCTIONS_DIR, project: process.cwd(), rulesDir: DEFAULT_RULES_DIR };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    // Refused, not skipped: a mistyped flag would otherwise fall back to a default
    // (the kinds catalog instead of the file's own rules, or the wrong project)
    // and the agent would follow the wrong instructions without noticing.
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'files') {
      args.files = [...new Set(m[2].split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
    } else if (m[1] === 'instructions-dir') {
      args.instructionsDir = m[2];
    } else if (m[1] === 'project') {
      args.project = m[2];
    } else if (m[1] === 'rules-dir') {
      args.rulesDir = m[2];
    } else {
      unknown.push(arg);
    }
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --files, --project, --instructions-dir, --rules-dir)`);
  }
  return args;
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// What an agent reads before writing a file of this kind: the kind's whole plan, with
// the item texts the layered rulebook settled on - a project restating one item in any
// of its kinds changes it here too, which the kind's own JSON file would not show.
// `projectOnly` renders the part of the plan the project's own rulebook defines.
function renderKind(kind, instructions, plan = kind.plan, projectOnly = false) {
  const lines = [`# \`${kind.name}\` - ${kind.role}`, ''];
  const whose = projectOnly
    ? `The part of the checklist the code review walks a \`${kind.name}\` file against that the project's own rulebook (\`.claude/doh/instructions/\`) defines`
    : `The checklist the code review walks a \`${kind.name}\` file against`;
  lines.push(`${whose}: write the file so that every item holds. Each item keeps its rulebook address \`<id>#<n>\`, so a gap in the numbers is expected.`, '');
  if (kind.notes.length > 0) {
    for (const note of kind.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  for (const step of plan) {
    const instruction = instructions.get(step.id);
    lines.push(`## ${instruction.name} (\`${instruction.id}\`)`, '');
    if (instruction.gate) lines.push(`Walked only when ${instruction.gate.replace(/\.$/, '')}.`, '');
    for (const paragraph of instruction.preamble) lines.push(paragraph, '');
    for (const n of step.numbers) lines.push(`- ${instruction.id}#${n}: ${instruction.items.get(n)}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// Named by its content: two agents writing one kind at once write the same bytes, and
// a project that restates a rule gets a file of its own instead of overwriting the copy
// another project's agent is reading.
function writeCopy(rulesDir, stem, text) {
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
  const file = path.join(rulesDir, `${stem}.${hash}.md`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(rulesDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    // The same name holds the same bytes, so a copy another run put there first is this one.
    if (!fs.existsSync(file)) throw err;
  }
  return file;
}

// Output stays minimal because the agents run this before every task: with --files
// only the per-file matches are printed; without --files (the one-time first run) only
// the catalog of file kinds, so a plan places its files where the rulebook expects them.
function buildOutput(options) {
  const out = { instructionsDir: null, projectInstructionsDir: null, warnings: [], errors: [] };
  if (!rulebook) {
    out.errors.push(`codeReview skill not found (expected its scripts next to this skill): ${DEFAULT_INSTRUCTIONS_DIR}`);
    return out;
  }
  const dir = path.resolve(options.instructionsDir || DEFAULT_INSTRUCTIONS_DIR);
  out.instructionsDir = dir;
  if (!isDirectory(dir)) {
    out.errors.push(`Instructions directory not found: ${dir}`);
    return out;
  }

  // The reviewed project may carry its own file kinds in `.claude/doh/instructions/`;
  // the review layers them the same way, so the code written here must follow them too.
  // A non-directory there is no rulebook, not a crash.
  const projectInstructionsDir = path.join(
    path.resolve(options.project || process.cwd()), '.claude', 'doh', 'instructions');
  out.projectInstructionsDir = isDirectory(projectInstructionsDir) ? projectInstructionsDir : null;
  const rules = rulebook.loadRulebook([dir, out.projectInstructionsDir]);
  out.warnings.push(...rules.warnings);
  if (rules.kinds.length === 0) {
    out.warnings.push('instructions/ holds no file kind - nothing to follow beyond the plan, the project CLAUDE.md and its conventions.');
  }

  const files = options.files || [];
  if (files.length === 0) {
    out.kinds = rules.kinds
      .map((kind) => ({ kind: kind.name, pattern: kind.pattern, role: kind.role }))
      .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return out;
  }

  // The items the project's own rulebook defines, read without the skill's under it:
  // every item of a project kind, and each skill item a project kind restates. fixPr
  // applies only these - the rest is the doh review checklist, not the project's rules.
  const projectDefined = out.projectInstructionsDir
    ? rulebook.loadRulebook([null, out.projectInstructionsDir]).instructions
    : new Map();

  // Matched by the review's own `matchKind`, so a file follows the one kind its review
  // walks - ties included, which the review settles the same deterministic way.
  const rulesDir = path.resolve(options.rulesDir || DEFAULT_RULES_DIR);
  const copies = new Map();
  const unmatched = [];
  out.files = files.map((p) => {
    const { kind, tied } = rulebook.matchKind(rules, p);
    if (!kind) {
      unmatched.push(p);
      return { path: p, kind: null, rules: null, projectRules: null, checklist: [] };
    }
    if (tied.length > 0) {
      out.warnings.push(`${p} matches file kinds ${tied.join(' = ')} equally well - it follows "${kind.name}", the one its review walks.`);
    }
    if (!copies.has(kind.name)) {
      const own = kind.plan
        .map((step) => ({
          id: step.id,
          numbers: step.numbers.filter((n) => projectDefined.has(step.id) && projectDefined.get(step.id).items.has(n)),
        }))
        .filter((step) => step.numbers.length > 0);
      try {
        copies.set(kind.name, {
          rules: writeCopy(rulesDir, kind.name, renderKind(kind, rules.instructions)),
          projectRules: own.length > 0
            ? writeCopy(rulesDir, `${kind.name}.project`, renderKind(kind, rules.instructions, own, true))
            : null,
        });
      } catch (err) {
        out.errors.push(`Could not write the rules of kind "${kind.name}" to ${rulesDir} (${(err && err.message) || err}).`);
        copies.set(kind.name, { rules: null, projectRules: null });
      }
    }
    return {
      path: p,
      kind: kind.name,
      ...copies.get(kind.name),
      checklist: kind.plan.map((step) => `${step.id}:${rulebook.formatItemSpec(step.numbers)}`),
    };
  });
  if (unmatched.length > 0 && rules.kinds.length > 0) {
    out.warnings.push(`${unmatched.length} file(s) match no file kind - no rulebook checklist binds them, only the plan, the project CLAUDE.md and its conventions: ${unmatched.join(', ')}`);
  }
  return out;
}

function main() {
  let out;
  try {
    out = buildOutput(parseArgs(process.argv.slice(2)));
  } catch (err) {
    out = { instructionsDir: null, projectInstructionsDir: null, warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(out.errors.length > 0 ? 1 : 0);
}

module.exports = { parseArgs, buildOutput, renderKind, DEFAULT_INSTRUCTIONS_DIR, DEFAULT_RULES_DIR };

if (require.main === module) main();
