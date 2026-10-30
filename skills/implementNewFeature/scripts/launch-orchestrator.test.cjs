'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { attachPrompt, manualCommand, sessionEnv, launchSpec, launchOrchestrator } = require('./launch-orchestrator.cjs');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inf launch-'));

// A spawn that records what it was asked and then does what `then` says on the next tick.
function fakeSpawn(then = 'spawn') {
  const calls = [];
  const impl = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    process.nextTick(() => (then === 'spawn' ? child.emit('spawn') : child.emit('error', new Error(then))));
    calls[calls.length - 1].child = child;
    return child;
  };
  return { impl, calls };
}

test('sesja taska dostaje tylko swój task i port, komendą z DOH_CLAUDE_COMMAND albo claude', () => {
  assert.equal(attachPrompt('t2', 9999), '/doh:implementNewFeature --attach t2 --port 9999');
  assert.equal(manualCommand('t2', 9999, {}), 'claude "/doh:implementNewFeature --attach t2 --port 9999"');
  assert.equal(manualCommand('t3', 9999, { DOH_CLAUDE_COMMAND: ' claude --permission-mode acceptEdits ' }),
    'claude --permission-mode acceptEdits "/doh:implementNewFeature --attach t3 --port 9999"');
  assert.equal(manualCommand('t3', 9999, { DOH_CLAUDE_COMMAND: '   ' }),
    'claude "/doh:implementNewFeature --attach t3 --port 9999"');
});

test('DOH_ORCHESTRATOR_MODEL dodaje --model, chyba że komenda już go ma albo wartość nie jest nazwą modelu', () => {
  assert.equal(manualCommand('t2', 9999, { DOH_ORCHESTRATOR_MODEL: ' sonnet ' }),
    'claude --model sonnet "/doh:implementNewFeature --attach t2 --port 9999"');
  assert.equal(manualCommand('t2', 9999, { DOH_CLAUDE_COMMAND: 'claude --permission-mode acceptEdits', DOH_ORCHESTRATOR_MODEL: 'claude-sonnet-5-5' }),
    'claude --permission-mode acceptEdits --model claude-sonnet-5-5 "/doh:implementNewFeature --attach t2 --port 9999"');
  assert.equal(manualCommand('t2', 9999, { DOH_CLAUDE_COMMAND: 'claude --model=opus', DOH_ORCHESTRATOR_MODEL: 'sonnet' }),
    'claude --model=opus "/doh:implementNewFeature --attach t2 --port 9999"');
  assert.equal(manualCommand('t2', 9999, { DOH_ORCHESTRATOR_MODEL: 'sonnet & calc' }),
    'claude "/doh:implementNewFeature --attach t2 --port 9999"');
});

test('nowy terminal nie dziedziczy tożsamości sesji, która uruchomiła serwer', () => {
  const env = sessionEnv({
    PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', claude_pid: '7', CLAUDE_EFFORT: 'max',
    CLAUDE_CODE_MESSAGING_TOKEN: 'x', CLAUDE_CODE_CHILD_SESSION: '1',
    // The user's own configuration stays.
    CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
  });
  assert.deepEqual(Object.keys(env).sort(),
    ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CONFIG_DIR', 'PATH']);
});

test('Windows: start otwiera okno z cmd /k, a katalog projektu nie trafia do linii poleceń', () => {
  const spec = launchSpec('win32', { project: 'D:/100% done/app', taskId: 't2', port: 9999, env: {} });
  assert.equal(spec.file, 'cmd.exe');
  assert.equal(spec.verbatim, true);
  assert.deepEqual(spec.args, ['/d', '/s', '/c',
    '"start "implementNewFeature t2" cmd /s /k "claude "/doh:implementNewFeature --attach t2 --port 9999"""']);
  assert.ok(!spec.args.join(' ').includes('100%'));
});

test('macOS: Terminal dostaje cd do projektu, z apostrofem w ścieżce', () => {
  const spec = launchSpec('darwin', { project: "/Users/o'neil/app", taskId: 't4', port: 9999, env: {} });
  assert.equal(spec.file, 'osascript');
  assert.equal(spec.args.at(-1),
    "cd '/Users/o'\\''neil/app' && claude '/doh:implementNewFeature --attach t4 --port 9999'");
  assert.ok(spec.args.includes('tell application "Terminal" to do script (item 1 of argv)'));
});

test('Linux: pierwszy terminal z listy, który jest na PATH; bez żadnego - null', () => {
  const bin = tmpDir();
  for (const name of ['xterm', 'konsole']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const spec = launchSpec('linux', { project: '/p', taskId: 't2', port: 9999, env: { PATH: bin } });
  assert.equal(spec.file, 'konsole');
  assert.deepEqual(spec.args, ['-e', 'sh', '-c',
    'claude \'/doh:implementNewFeature --attach t2 --port 9999\'; exec "${SHELL:-sh}"']);
  assert.equal(launchSpec('linux', { project: '/p', taskId: 't2', port: 9999, env: { PATH: tmpDir() } }), null);
});

test('launchOrchestrator: okno odpięte od serwera, w katalogu projektu, bez zmiennych sesji', async () => {
  const { impl, calls } = fakeSpawn();
  const r = await launchOrchestrator({ project: '/p', taskId: 't2', port: 9999, platform: 'win32',
    env: { PATH: 'x', CLAUDECODE: '1' }, spawnImpl: impl });
  assert.deepEqual(r, { launched: true, command: 'claude "/doh:implementNewFeature --attach t2 --port 9999"', cwd: '/p' });
  assert.equal(calls.length, 1);
  const { opts, child } = calls[0];
  assert.equal(opts.cwd, '/p');
  assert.deepEqual(opts.env, { PATH: 'x' });
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, 'ignore');
  assert.equal(opts.windowsVerbatimArguments, true);
  assert.equal(child.unrefed, true);
});

test('launchOrchestrator: błąd uruchomienia wraca z komendą do ręcznego wpisania', async () => {
  const failing = fakeSpawn('spawn osascript ENOENT');
  const r = await launchOrchestrator({ project: '/p', taskId: 't2', port: 9999, platform: 'darwin', env: {},
    spawnImpl: failing.impl });
  assert.equal(r.launched, false);
  assert.equal(r.error, 'spawn osascript ENOENT');
  assert.equal(r.command, 'claude "/doh:implementNewFeature --attach t2 --port 9999"');

  const throwing = await launchOrchestrator({ project: '/p', taskId: 't2', port: 9999, platform: 'win32', env: {},
    spawnImpl: () => { throw new Error('EPERM'); } });
  assert.deepEqual([throwing.launched, throwing.error], [false, 'EPERM']);

  const none = fakeSpawn();
  const noTerminal = await launchOrchestrator({ project: '/p', taskId: 't2', port: 9999, platform: 'linux',
    env: { PATH: tmpDir() }, spawnImpl: none.impl });
  assert.deepEqual([noTerminal.launched, noTerminal.error], [false, 'no terminal to open on this system']);
  const badTask = await launchOrchestrator({ project: '/p', taskId: 't2 & calc', port: 9999, platform: 'win32',
    env: {}, spawnImpl: none.impl });
  assert.equal(badTask.launched, false);
  assert.equal(none.calls.length, 0);
});

// Everything but `start` itself, which would open a window: the outer cmd, the inner one with
// its /s, and a command whose path has a space in it and is quoted, as DOH_CLAUDE_COMMAND may be.
test('Windows: przez oba cmd prompt dociera jako jeden argument, a katalogiem jest projekt',
  { skip: process.platform !== 'win32' }, () => {
    const dir = tmpDir();
    const script = path.join(dir, 'argv.cjs');
    const out = path.join(dir, 'argv.json');
    fs.writeFileSync(script, 'require("fs").writeFileSync(process.env.ARGV_OUT, '
      + 'JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n');
    const env = { ...process.env, DOH_CLAUDE_COMMAND: `"${process.execPath}" "${script}"` };
    const spec = launchSpec('win32', { project: dir, taskId: 't2', port: 4321, env });
    const line = spec.args[3].replace(/^"start "[^"]*" cmd \/s \/k /, '"cmd /s /c ');
    assert.notEqual(line, spec.args[3]);
    const r = spawnSync(spec.file, [...spec.args.slice(0, 3), line],
      { cwd: dir, env: { ...sessionEnv(env), ARGV_OUT: out }, windowsVerbatimArguments: true, timeout: 20000 });
    assert.equal(r.status, 0, String(r.stderr));
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(seen.argv, ['/doh:implementNewFeature --attach t2 --port 4321']);
    assert.equal(path.resolve(seen.cwd).toLowerCase(), path.resolve(dir).toLowerCase());
  });
