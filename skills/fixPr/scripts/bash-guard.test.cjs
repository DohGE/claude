'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const guard = require('./bash-guard.cjs');

const W = 'C:/p/dpx-services-webgui-worktrees/fixpr-DPXN-1';

// 2026-11-16: 330 Bash calls in nine agents, 23 shell reads in one of them (9 min), a recursive
// grep that hung two minutes and left 4 MB behind, and 4 of 5 worktree folders the orchestrator
// could not remove because a shell stood in them.
test('a shell read of a fix worktree is refused, with the tool to use instead', () => {
  for (const command of [
    `cat "${W}/src/a.ts"`,
    `W="${W}"; grep -rln "Announcement" "$W/projects" | grep -v i18n`,
    `W="${W}"; sed -n 25,40p "$W/x.ts"`,
    `wc -l "${W}/a.ts"`,
    `ls "${W}/.claude/doh"`,
  ]) {
    const reason = guard.decide(command);
    assert.ok(reason, command);
    assert.match(reason, /Read|Grep|Glob/);
  }
});

test('a cd into a fix worktree that outlives the command is refused; a subshell and a cd away are fine', () => {
  assert.match(guard.decide(`cd "${W}" && npx jest a.spec.ts`), /subshell/);
  assert.strictEqual(guard.decide(`(cd "${W}" && npx jest a.spec.ts)`), null);
  assert.strictEqual(guard.decide(`cd /c; S="${W}"; git -C "$S" status`), null);
});

test('what reads a pipe, writes a tree or runs a script is no shell read', () => {
  for (const command of [
    `git -C "${W}" diff | grep foo`,
    `git -C "${W}" status --short | head -5`,
    `node "C:/k/checks.cjs" --root="${W}" --out-dir="C:/c"`,
    `(cd "${W}" && npx prettier --write a.ts)`,
    'cat /tmp/other.txt',
    `node -e "const s='cat ${W}/a.ts; grep x'"`,
  ]) assert.strictEqual(guard.decide(command), null, command);
});

test('the hook refuses with exit 2 and its reason, and lets anything else through', () => {
  const run = (input) => spawnSync(process.execPath, [path.join(__dirname, 'bash-guard.cjs')], { input: JSON.stringify(input), encoding: 'utf8' });
  const refused = run({ tool_name: 'Bash', tool_input: { command: `cat "${W}/a.ts"` } });
  assert.strictEqual(refused.status, 2);
  assert.match(refused.stderr, /Read/);
  assert.strictEqual(run({ tool_name: 'Bash', tool_input: { command: 'git status' } }).status, 0);
  assert.strictEqual(run({ tool_name: 'Write', tool_input: { file_path: 'x' } }).status, 0);
  assert.strictEqual(spawnSync(process.execPath, [path.join(__dirname, 'bash-guard.cjs')], { input: 'not json', encoding: 'utf8' }).status, 0);
});

// The fix worktree's node_modules is a link to the main checkout's. Measured with npm 10 on
// Windows: `npm ci` through it emptied the main checkout's folder, `npm install` pruned it. On
// 2026-11-18 every worktree of a run showed an install's traces, and the main node_modules was gone.
test('an install or an rm of node_modules/ in a fix worktree is refused; scripts and an rmdir of the link are not', () => {
  for (const command of [
    `(cd "${W}" && npm ci)`,
    `npm --prefix "${W}" install`,
    `(cd "${W}" && npm i -D jest)`,
    `(cd "${W}" && yarn)`,
    `(cd "${W}" && pnpm install --frozen-lockfile)`,
    `rm -rf "${W}/node_modules/"`,
    `rm -rf ${W}/node_modules/*`,
  ]) {
    const reason = guard.decide(command);
    assert.ok(reason, command);
    assert.match(reason, /main checkout/, command);
  }
  for (const command of [
    `(cd "${W}" && npm run build)`,
    `(cd "${W}" && npm test)`,
    `(cd "${W}" && npx jest a.spec.ts)`,
    `yarn --cwd "${W}" lint`,
    `rmdir "${W}/node_modules"`,
    `rm -f "${W}/src/a.ts"`,
    'npm ci',
  ]) assert.strictEqual(guard.decide(command), null, command);
});
