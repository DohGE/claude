'use strict';

// One task, one orchestrator. The session that started the run orchestrates its first task;
// every task added from the stepper gets a Claude Code session of its own, in a terminal of
// its own, opened from here the first time its requirements are sent. Each session's context
// then carries one pipeline instead of all of them, and one task's long turn no longer holds
// up the answers of every other.
//
// The new session is told only which task is its own - `/doh:implementNewFeature --attach
// <task> --port <port>` - and finds the rest through the server. Nothing here waits for it:
// the server learns that it is up when its waiter polls for that task.
//
// `claude` is the command; DOH_CLAUDE_COMMAND replaces it - a full path, or `claude
// --permission-mode acceptEdits` for a session that does not stop at every edit.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TASK_ID = /^t\d+$/;

// What Claude Code puts in the environment of the session it runs - the server inherited them
// from the session that started it. A terminal that kept them would start a session that takes
// itself for a part of that one (`CLAUDECODE` is what makes `claude` refuse to start nested),
// so the new one gets the user's environment without them.
const SESSION_VARS = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED']);

const attachPrompt = (taskId, port) => `/doh:implementNewFeature --attach ${taskId} --port ${port}`;

const claudeOf = (env) => (env.DOH_CLAUDE_COMMAND || '').trim() || 'claude';

// What the user pastes into a terminal opened in the project when none could be opened for
// them. Double quotes mean the same in cmd, PowerShell and every POSIX shell for a prompt
// without quotes, `$` or `%`, which this one never has.
const manualCommand = (taskId, port, env = process.env) => `${claudeOf(env)} "${attachPrompt(taskId, port)}"`;

const sessionEnv = (env) => Object.fromEntries(Object.entries(env)
  .filter(([k]) => !SESSION_VARS.has(k.toUpperCase())));

// POSIX single quotes: the one quoting a path of any shape survives.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function onPath(name, env) {
  return String(env.PATH || '').split(path.delimiter).filter(Boolean).some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// The terminals a Linux desktop is likely to have, each with the way it takes a command.
const LINUX_TERMINALS = [
  ['x-terminal-emulator', (cmd) => ['-e', 'sh', '-c', cmd]],
  ['gnome-terminal', (cmd) => ['--', 'sh', '-c', cmd]],
  ['konsole', (cmd) => ['-e', 'sh', '-c', cmd]],
  ['xfce4-terminal', (cmd) => ['-x', 'sh', '-c', cmd]],
  ['xterm', (cmd) => ['-e', 'sh', '-c', cmd]],
];

// How to open a terminal running the task's session in the project, or null where no terminal
// can be found. The window stays open once the session ends, so its last words can be read.
function launchSpec(platform, { project, taskId, port, env = process.env }) {
  const claude = claudeOf(env);
  const prompt = attachPrompt(taskId, port);
  if (platform === 'win32') {
    // `start` opens the new console window; the outer cmd only runs it and exits. /s on both
    // takes the outermost pair of quotes off and leaves everything between as written, which is
    // what keeps a quoted path in DOH_CLAUDE_COMMAND whole. The project is the spawn's working
    // directory rather than a `/D` argument: on the command line it would go through cmd's
    // `%` expansion. Verbatim, because Node's own quoting would escape the quotes cmd reads.
    const line = `"start "implementNewFeature ${taskId}" cmd /s /k "${claude} "${prompt}"""`;
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', line], verbatim: true };
  }
  if (platform === 'darwin') {
    // Terminal opens the script's shell in the home directory, so the `cd` is part of it.
    return {
      file: 'osascript',
      args: ['-e', 'on run argv', '-e', 'tell application "Terminal" to do script (item 1 of argv)',
        '-e', 'tell application "Terminal" to activate', '-e', 'end run',
        `cd ${shQuote(project)} && ${claude} ${shQuote(prompt)}`],
    };
  }
  const found = LINUX_TERMINALS.find(([name]) => onPath(name, env));
  if (!found) return null;
  return { file: found[0], args: found[1](`${claude} ${shQuote(prompt)}; exec "\${SHELL:-sh}"`) };
}

// Resolves to { launched, command, cwd, error? }; never rejects. `command` and `cwd` are what
// the page offers the user to run by hand when `launched` is false.
function launchOrchestrator({ project, taskId, port, platform = process.platform, env = process.env,
  spawnImpl = spawn }) {
  const result = { launched: false, command: manualCommand(taskId, port, env), cwd: project };
  if (!TASK_ID.test(String(taskId)) || !Number.isInteger(port) || port <= 0) {
    return Promise.resolve({ ...result, error: 'bad task or port' });
  }
  const spec = launchSpec(platform, { project, taskId, port, env });
  if (!spec) return Promise.resolve({ ...result, error: 'no terminal to open on this system' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(spec.file, spec.args, { cwd: project, env: sessionEnv(env), detached: true,
        stdio: 'ignore', windowsVerbatimArguments: !!spec.verbatim });
    } catch (e) {
      resolve({ ...result, error: e.message });
      return;
    }
    // A missing program is reported here, after the spawn returned, not thrown by it.
    child.once('error', (e) => resolve({ ...result, error: e.message }));
    child.once('spawn', () => {
      child.unref();
      resolve({ ...result, launched: true });
    });
  });
}

module.exports = { attachPrompt, manualCommand, sessionEnv, launchSpec, launchOrchestrator, SESSION_VARS };
