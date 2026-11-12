#!/usr/bin/env node
'use strict';

// Signs the validation agent's Chrome tab in without the password ever reaching the agent.
//
// The agent may not read auth.json, and whatever it types with a browser tool lands in its
// transcript - so it could not sign in, and asked the user to: once per dev server, each time a
// wait until somebody came back to the keyboard (31 minutes on one run, and a second time after
// the run was resumed). Here the PAGE fetches the credentials. This script asks the stepper for
// a single-use ticket bound to the task's own dev-server origin (server.cjs, /api/e2e-login) and
// prints a snippet for `mcp__claude-in-chrome__javascript_tool`: run in the tab, it redeems the
// ticket, fills the login form and submits it. The agent sees the ticket - spent by its first
// use, dead after two minutes, useless from any other origin - and one word back.
//
// Usage: node chrome-login.cjs --port=<stepper port> --task=<id> --app-port=<the dev server's port>
//          [--login-selector=<css>] [--password-selector=<css>] [--submit-selector=<css>]
// At least one of the two field selectors. A form that asks for the login and the password on
// two pages takes two calls, one selector each - every call is a ticket of its own.
// Prints `LOGIN_SNIPPET` and, on the next line, the snippet to pass to javascript_tool verbatim -
// or `LOGIN_UNAVAILABLE <reason>` (exit 1): no credentials saved, or the port is not this task's.
// The snippet answers (FIXED IDENTIFIERS): `LOGIN_SUBMITTED`, `LOGIN_FILLED` (no submit control
// was named and the form has none to trigger), `LOGIN_FIELD_NOT_FOUND <which>`,
// `LOGIN_TICKET_REFUSED <status>` or `LOGIN_FETCH_FAILED <message>`.

const http = require('node:http');

function parseArgs(argv) {
  const args = { port: 0, task: '', appPort: 0, login: '', password: '', submit: '' };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=([\s\S]*)$/);
    if (!m) throw new Error(`Unknown argument ${arg}`);
    if (m[1] === 'port') args.port = Number(m[2]);
    else if (m[1] === 'task') args.task = m[2];
    else if (m[1] === 'app-port') args.appPort = Number(m[2]);
    else if (m[1] === 'login-selector') args.login = m[2];
    else if (m[1] === 'password-selector') args.password = m[2];
    else if (m[1] === 'submit-selector') args.submit = m[2];
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!(args.port > 0)) throw new Error('--port=<stepper port> is required');
  if (!/^[A-Za-z0-9_-]+$/.test(args.task)) throw new Error('--task=<id> is required');
  if (!(args.appPort > 0 && args.appPort < 65536)) throw new Error('--app-port=<the dev server\'s port> is required');
  if (!args.login.trim() && !args.password.trim()) throw new Error('name the field to fill: --login-selector and/or --password-selector');
  return args;
}

// The page sets a value the way a user's typing does: through the element's native setter, then
// the events a framework listens for - Angular and React both ignore a bare `el.value = x`.
// Nothing the server sends is returned or logged: the snippet answers with one identifier.
function snippet({ url, login, password, submit }) {
  const q = (v) => JSON.stringify(String(v || ''));
  return '(async()=>{try{'
    + `const r=await fetch(${q(url)},{cache:"no-store"});`
    + 'if(!r.ok)return"LOGIN_TICKET_REFUSED "+r.status;'
    + 'const c=await r.json();'
    + 'const put=(s,v)=>{const e=document.querySelector(s);if(!e)return false;'
    + 'const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;'
    + 'Object.getOwnPropertyDescriptor(p,"value").set.call(e,v);'
    + 'for(const n of["input","change","blur"])e.dispatchEvent(new Event(n,{bubbles:true}));return true};'
    + `const L=${q(login)},P=${q(password)},S=${q(submit)};`
    + 'if(L&&!put(L,c.login))return"LOGIN_FIELD_NOT_FOUND login";'
    + 'if(P&&!put(P,c.password))return"LOGIN_FIELD_NOT_FOUND password";'
    + 'if(S){const b=document.querySelector(S);if(!b)return"LOGIN_FIELD_NOT_FOUND submit";b.click();return"LOGIN_SUBMITTED"}'
    + 'const f=document.querySelector(P||L).form;'
    + 'if(f&&f.requestSubmit){f.requestSubmit();return"LOGIN_SUBMITTED"}'
    + 'return"LOGIN_FILLED"'
    + '}catch(e){return"LOGIN_FETCH_FAILED "+(e&&e.message)}})()';
}

function requestTicket({ port, task, appPort }) {
  const data = Buffer.from(JSON.stringify({ taskId: task, port: appPort }), 'utf8');
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/e2e-login/ticket', method: 'POST', timeout: 15000,
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(text); } catch { /* not JSON: reported below */ }
        resolve(res.statusCode === 200 && body.ticket ? { ticket: body.ticket }
          : { error: body.error || `the stepper answered ${res.statusCode}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ error: `the stepper on port ${port} did not answer (${err.message})` }));
    req.end(data);
  });
}

async function chromeLogin(args, seams = {}) {
  const got = await (seams.requestTicket || requestTicket)(args);
  if (got.error) return [`LOGIN_UNAVAILABLE ${got.error}`];
  const url = `http://127.0.0.1:${args.port}/api/e2e-login?taskId=${encodeURIComponent(args.task)}&ticket=${got.ticket}`;
  return ['LOGIN_SNIPPET', snippet({ url, login: args.login, password: args.password, submit: args.submit })];
}

if (require.main === module) {
  (async () => {
    let lines;
    try {
      lines = await chromeLogin(parseArgs(process.argv.slice(2)));
    } catch (err) {
      lines = [`LOGIN_UNAVAILABLE ${(err && err.message) || err}`];
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = lines[0] === 'LOGIN_SNIPPET' ? 0 : 1;
  })();
}

module.exports = { parseArgs, snippet, requestTicket, chromeLogin };
