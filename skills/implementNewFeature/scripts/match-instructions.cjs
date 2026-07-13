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
  const args = { files: [], instructionsDir: DEFAULT_INSTRUCTIONS_DIR };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'files') {
      args.files = [...new Set(m[2].split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
    } else if (m[1] === 'instructions-dir') {
      args.instructionsDir = m[2];
    }
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

  const { globals, locals, warnings } = reviewContext.loadInstructions(dir, 'implement');
  out.warnings = warnings;
  if (globals.length === 0 && locals.length === 0) {
    out.warnings.push('instructions/global and instructions/local are empty - nothing to follow beyond the plan and project conventions.');
  }
  const files = options.files || [];
  if (files.length > 0) {
    out.files = files.map((p) => ({
      path: p,
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
