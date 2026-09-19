#!/usr/bin/env node
'use strict';

// Deterministic rulebook lookup for the implementNewFeature implementation agent:
// given project-relative file paths, prints which doh:codeReview instruction files
// (global + matching local) the code must comply with. The instruction tree is
// loaded and matched by the codeReview skill itself, so what the agent follows
// while writing code is exactly what step 5 later reviews against.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_INSTRUCTIONS_DIR = path.resolve(__dirname, '..', '..', 'codeReview', 'instructions');

let reviewContext = null;
try {
  reviewContext = require('../../codeReview/scripts/review-context.cjs');
} catch {
  // reported as a JSON error in buildOutput
}

function parseArgs(argv) {
  const args = { files: [], instructionsDir: DEFAULT_INSTRUCTIONS_DIR, project: process.cwd() };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    // Refused, not skipped: a mistyped flag would otherwise fall back to a default
    // (the whole rulebook instead of the file's own rules, or the wrong project)
    // and the agent would follow the wrong instructions without noticing.
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'files') {
      args.files = [...new Set(m[2].split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
    } else if (m[1] === 'instructions-dir') {
      args.instructionsDir = m[2];
    } else if (m[1] === 'project') {
      args.project = m[2];
    } else {
      unknown.push(arg);
    }
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --files, --project, --instructions-dir)`);
  }
  return args;
}

// Output stays minimal because the implementation agent runs this before every
// task: with --files only the per-file matches are printed; without --files
// (the one-time first run) only the global instruction list is printed.
function buildOutput(options) {
  const out = { instructionsDir: null, warnings: [], errors: [] };
  if (!reviewContext) {
    out.errors.push(`codeReview skill not found (expected its scripts next to this skill): ${DEFAULT_INSTRUCTIONS_DIR}`);
    return out;
  }
  const dir = path.resolve(options.instructionsDir || DEFAULT_INSTRUCTIONS_DIR);
  out.instructionsDir = dir;
  if (!fs.existsSync(dir)) {
    out.errors.push(`Instructions directory not found: ${dir}`);
    return out;
  }

  // The reviewed project may carry its own rules in `.claude/doh/instructions/`;
  // the review in step 6 layers them the same way, so the code written in step 4
  // must follow them too.
  const projectInstructionsDir = path.join(
    path.resolve(options.project || process.cwd()), '.claude', 'doh', 'instructions');
  // A plain existsSync is not enough: `loadInstructions` walks the path with
  // readdirSync, so a non-directory here would crash the matcher with a stack
  // trace instead of the JSON every caller parses.
  const hasProjectInstructions = fs.existsSync(projectInstructionsDir)
    && fs.statSync(projectInstructionsDir).isDirectory();
  out.projectInstructionsDir = hasProjectInstructions ? projectInstructionsDir : null;
  const { globals, locals, warnings, scopes } = reviewContext.loadInstructions(
    hasProjectInstructions ? [dir, projectInstructionsDir] : dir, 'implement');
  out.warnings = warnings;
  if (globals.length === 0 && locals.length === 0) {
    out.warnings.push('instructions/global and instructions/local are empty - nothing to follow beyond the plan and project conventions.');
  }
  const files = options.files || [];
  if (files.length > 0) {
    // Globals are matched per file, exactly as `buildContext` matches them at
    // review time. Six of the eight shipped ones declare `applies-to`, so
    // "every global binds every file" was never true of the review: a
    // stylesheet was written against test-coverage.md and a file under
    // `models/` against security.md, and step 6 then checked neither. The whole
    // point of this script is that what the code is written against is what it
    // is later reviewed against, and until now that held for locals only.
    out.files = files.map((p) => ({
      path: p,
      globalInstructions: reviewContext.matchGlobalInstructions(globals, scopes || {}, p),
      localInstructions: reviewContext.matchLocalInstructions(locals, p),
    }));
  } else {
    out.globals = globals;
  }
  return out;
}

function main() {
  let out;
  try {
    out = buildOutput(parseArgs(process.argv.slice(2)));
  } catch (err) {
    out = { instructionsDir: null, warnings: [], errors: [String((err && err.message) || err)] };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(out.errors.length > 0 ? 1 : 0);
}

module.exports = { parseArgs, buildOutput, DEFAULT_INSTRUCTIONS_DIR };

if (require.main === module) main();
