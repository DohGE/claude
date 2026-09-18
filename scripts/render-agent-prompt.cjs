#!/usr/bin/env node
'use strict';

// Renders a sub-agent prompt template to a file, with every `{{PLACEHOLDER}}`
// resolved, and prints the PATH of the result.
//
// Why this exists at all: an orchestrator that builds a sub-agent prompt by
// hand has to read the template into its own context and then write the whole
// substituted text back out as the Agent call's argument - so a 29 KB agent
// file costs roughly 15 000 tokens of context PER SPAWN, and a pipeline that
// spawns six of them pays it six times before a single line of code is written.
// Rendering here costs one Bash call, and the spawn prompt shrinks to a pointer
// plus whatever the orchestrator wants to add for this particular run.
//
// It is also stricter than substituting by hand: a placeholder nobody supplied
// is a REFUSAL with the missing names, not a `{{ROOT}}` that travels into the
// agent's instructions and is read there as a literal path.
//
// Placeholders are UPPER_SNAKE inside double braces. Anything else in double
// braces is template text and is left exactly as written - the mockup agent's
// own instructions talk about `{{paramName}}` placeholders in generated markup,
// and those belong to the mockup, not to this script.
//
// This lives at the plugin root rather than inside one skill because
// implementNewFeature and fixPrComments both spawn sub-agents from reference
// files, and a second copy of the substitution rules would drift from the first.

const fs = require('node:fs');
const path = require('node:path');

const placeholder = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

// `--set=NAME=value`: the FIRST `=` after the name ends it, so a value may hold
// as many as it likes - a Windows path with a query-ish tail, a commit message,
// a directive sentence.
function parseArgs(argv) {
  const args = { template: '', out: '', values: {} };
  const unknown = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=([\s\S]*)$/);
    // A mistyped flag stops the run rather than rendering a prompt that is
    // missing the value it was meant to carry: the agent would then be handed a
    // refusal-worthy template and start working from a placeholder.
    if (!m) { unknown.push(arg); continue; }
    if (m[1] === 'template') args.template = m[2];
    else if (m[1] === 'out') args.out = m[2];
    else if (m[1] === 'set') {
      const at = m[2].indexOf('=');
      if (at === -1) throw new Error(`--set=${m[2]} has no value (expected --set=NAME=value).`);
      const name = m[2].slice(0, at).trim();
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        throw new Error(`--set name ${JSON.stringify(name)} is not UPPER_SNAKE; placeholders are written {{LIKE_THIS}}.`);
      }
      args.values[name] = m[2].slice(at + 1);
    } else unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')} (expected --template, --out, --set).`);
  }
  if (!args.template) throw new Error('No template given (expected --template=<path>).');
  if (!args.out) throw new Error('No output path given (expected --out=<path>).');
  return args;
}

// One pass over the template, never over the result: a value that itself
// contains `{{SOMETHING}}` is written through untouched instead of being
// substituted a second time or reported as missing. Replacement is by function,
// so `$&` and `$1` inside a value stay the characters the caller passed.
function render(template, values) {
  const used = new Set();
  const missing = new Set();
  const text = String(template).replace(placeholder, (full, name) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      used.add(name);
      return values[name];
    }
    missing.add(name);
    return full;
  });
  const unused = Object.keys(values).filter((name) => !used.has(name)).sort();
  return { text, missing: [...missing].sort(), unused };
}

function renderFile(options) {
  const template = path.resolve(options.template);
  const out = path.resolve(options.out);
  const result = {
    template, out, bytes: 0, substituted: [], unused: [], warnings: [], errors: [],
  };
  let source;
  try {
    source = fs.readFileSync(template, 'utf8');
  } catch (err) {
    result.errors.push(`Could not read the template ${template}: ${(err && err.message) || err}`);
    return result;
  }
  const { text, missing, unused } = render(source, options.values || {});
  if (missing.length) {
    result.errors.push(`The template still holds ${missing.length} unresolved placeholder(s): ${missing.map((n) => `{{${n}}}`).join(', ')}. Pass each one as --set=NAME=value; an empty value is written as --set=NAME=.`);
    return result;
  }
  result.substituted = Object.keys(options.values || {}).filter((n) => !unused.includes(n)).sort();
  result.unused = unused;
  if (unused.length) {
    // Not fatal - a caller that passes one table of values for several templates
    // is doing the sensible thing - but a value nobody used is also what a
    // renamed placeholder looks like from here.
    result.warnings.push(`Nothing in the template used: ${unused.join(', ')}.`);
  }
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Write-then-rename: the agent is told to read this path, and a prompt
    // caught half-written is an agent working from half a brief.
    const tmp = `${out}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, out);
  } catch (err) {
    result.errors.push(`Could not write ${out}: ${(err && err.message) || err}`);
    return result;
  }
  result.bytes = Buffer.byteLength(text, 'utf8');
  return result;
}

function main() {
  let result;
  try {
    result = renderFile(parseArgs(process.argv.slice(2)));
  } catch (err) {
    result = { errors: [String((err && err.message) || err)], warnings: [] };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.errors && result.errors.length ? 1 : 0);
}

module.exports = { parseArgs, render, renderFile, placeholder };

if (require.main === module) main();
