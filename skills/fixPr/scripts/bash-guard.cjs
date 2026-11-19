#!/usr/bin/env node
'use strict';

// PreToolUse hook on Bash (hooks/hooks.json): inside a fixPr or restack worktree, a shell that
// reads files, or stays standing in the folder, is refused with the tool to use instead - and so is
// a package-manager install or an `rm` of `node_modules/`, which go through the worktree's linked
// node_modules into the main checkout's packages (`installs` below).
//
// The fix and conflict agents' briefs already say both, and the run of 2026-11-16 shows what the
// words were worth: 330 Bash calls in nine agents, 23 shell reads in one of them (9 minutes, a
// recursive grep that hung for two and left 4 MB of output behind, Edits refused for files only
// `cat` had seen), and 4 of 5 worktree folders the orchestrator could not remove because a shell
// still stood in them. Read, Grep (ripgrep, which skips the linked node_modules) and Glob answer
// the same questions in a fraction of the time; `git -C` and a subshell `(cd … && …)` leave the
// folder free.
//
// Only a command that names a fix worktree (`…-worktrees/fixpr-…`) is looked at; a reader fed by
// a pipe (`git diff | grep x`) reads no file. Exit 2 with the reason refuses the call; anything
// else, a command it cannot parse and a failure of its own, exits 0 - a guard never stops a session.

const worktreePath = /-worktrees[\\/]fixpr-/i;
const readers = new Set(['cat', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'ls', 'wc', 'nl', 'od', 'xxd', 'strings', 'type']);

// The command's segments, each with the separator before it, split outside quotes.
function segments(command) {
  const out = [];
  let current = '';
  let quote = null;
  let before = '';
  const push = (sep) => {
    out.push({ text: current.trim(), before });
    current = '';
    before = sep;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') { current += c + (command[i + 1] || ''); i += 1; continue; }
      current += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { push(two); i += 1; continue; }
    if (c === ';' || c === '\n') { push(';'); continue; }
    if (c === '|') { push('|'); continue; }
    current += c;
  }
  push('');
  return out.filter((s) => s.text);
}

// The command word of a segment, past `(`, variable assignments and `env`.
function commandWord(text) {
  let rest = text.replace(/^\(+\s*/, '');
  for (let guard = 0; guard < 20; guard += 1) {
    const m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s*/);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  const word = (rest.match(/^\S+/) || [''])[0];
  return { word: word.replace(/^.*[\\/]/, ''), rest };
}

// Package-manager subcommands that rewrite or delete node_modules. In a fix worktree that folder is
// a link to the main checkout's (worktree.cjs links it whenever the lockfile is the same), and an
// install through it rewrites the main checkout's packages: measured with npm 10 on Windows, `npm ci`
// emptied the main checkout's node_modules entry by entry and `npm install` pruned what it did not
// know. On 2026-11-18 every worktree of a run showed an install's traces (husky's rewritten helpers),
// and the main checkout's node_modules was gone by the end.
const installs = {
  npm: /^(ci|clean-install|ic|install-clean|isntall-clean|install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|uninstall|un|unlink|remove|rm|r|update|up|upgrade|udpate|prune|dedupe|ddp|link|ln|rebuild|rb)$/,
  pnpm: /^(install|i|add|remove|rm|uninstall|un|update|up|upgrade|prune|link|ln|rebuild|rb)$/,
  yarn: /^(install|add|remove|upgrade|up|link)?$/,
};
// Flags of a package manager that take the next word as their value.
const valueFlags = new Set(['--prefix', '-C', '--dir', '--cwd', '--workspace', '-w', '--filter', '-F']);

// The subcommand of a package-manager call: the first word after the command that is no flag.
function subcommand(rest) {
  const words = rest.trim().split(/\s+/).slice(1);
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (valueFlags.has(w)) { i += 1; continue; }
    if (w.startsWith('-')) continue;
    return w.replace(/^["')]+|["')]+$/g, '');
  }
  return '';
}

function decide(command) {
  const text = String(command || '');
  if (!worktreePath.test(text)) return null;
  for (const segment of segments(text)) {
    const subshell = segment.text.startsWith('(');
    const { word, rest } = commandWord(segment.text);
    if (word === 'cd' && !subshell) {
      const target = rest.replace(/^cd\s*/, '').trim();
      if (worktreePath.test(target) || /^"?\$\{?[A-Za-z_]/.test(target)) {
        return 'Blocked by doh (fixPr): a `cd` into the worktree leaves this shell standing in the folder, and its removal then fails ("Permission denied", 4 of 5 folders on 2026-11-16). Use `git -C "<worktree>"`, absolute paths, or a subshell: `(cd "<worktree>" && <command>)`.';
      }
      continue;
    }
    const manager = word.replace(/\)+$/, '');
    if (Object.prototype.hasOwnProperty.call(installs, manager) && installs[manager].test(subcommand(rest))) {
      return `Blocked by doh (fixPr): \`${manager} ${subcommand(rest) || 'install'}\` in a fix worktree goes through its node_modules - a link to the main checkout's - and rewrites or empties the main checkout's packages (npm 10 deletes them through the link). The worktree's dependencies come from worktree.cjs; a package missing there is missing in the main checkout: name it in your result for the user, who runs the install in their own checkout.`;
    }
    // `rm -rf node_modules/` (a trailing slash or a glob) deletes what the link points at; `rmdir` of
    // the link, without /s, removes the link alone.
    if (word === 'rm' && /node_modules[\\/]\*?["']?(\s|\)|$)/.test(segment.text)) {
      return 'Blocked by doh (fixPr): `rm` of `node_modules/` (a trailing slash or a glob) follows the link into the main checkout\'s packages and deletes them. Leave node_modules alone - `worktree.cjs --action=remove` unlinks it when the worktree goes.';
    }
    if (readers.has(word) && segment.before !== '|') {
      return `Blocked by doh (fixPr): \`${word}\` reads files of the worktree through the shell. Use the Read tool (a range with offset and limit), Grep (ripgrep: it skips the linked node_modules) or Glob instead - a shell read costs seconds, can walk node_modules for minutes, and leaves Edit refusing a file only the shell has seen. A filter on a pipe (\`git diff | grep x\`) stays allowed.`;
    }
  }
  return null;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let reason = null;
    try {
      const input = JSON.parse(raw || '{}');
      if (input && input.tool_name === 'Bash') reason = decide(input.tool_input && input.tool_input.command);
    } catch {
      reason = null;
    }
    if (reason) {
      process.stderr.write(`${reason}\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}

module.exports = { decide, segments };

if (require.main === module) main();
