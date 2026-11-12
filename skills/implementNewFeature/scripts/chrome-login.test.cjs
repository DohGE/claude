'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { parseArgs, snippet, chromeLogin } = require('./chrome-login.cjs');
const { createApp } = require('./server.cjs');

// A page with a login form, as far as the snippet touches one: fields with a native value
// setter, the events a framework listens for, and a submit control.
function fakePage({ fields, fetch }) {
  class Element {
    constructor(name) { this.name = name; this.events = []; this.clicked = 0; this.stored = ''; }
    dispatchEvent(event) { this.events.push(event.type); return true; }
    click() { this.clicked++; }
  }
  class HTMLInputElement extends Element {}
  class HTMLTextAreaElement extends Element {}
  for (const klass of [HTMLInputElement, HTMLTextAreaElement]) {
    Object.defineProperty(klass.prototype, 'value', { get() { return this.stored; }, set(v) { this.stored = v; }, configurable: true });
  }
  const form = { submitted: 0, requestSubmit() { this.submitted++; } };
  const nodes = {};
  for (const [selector, kind] of Object.entries(fields)) {
    nodes[selector] = kind === 'button' ? new Element(selector) : new HTMLInputElement(selector);
    if (kind === 'input-in-form') nodes[selector].form = form;
  }
  const context = { fetch, HTMLInputElement, HTMLTextAreaElement, Event: class { constructor(type) { this.type = type; } },
    document: { querySelector: (s) => nodes[s] || null } };
  return { context, nodes, form };
}

const answering = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });
const run = (code, context) => vm.runInNewContext(code, context);

test('the snippet fills both fields through the native setter, fires the events and clicks submit', async () => {
  const page = fakePage({ fields: { '#user': 'input', '#pass': 'input', 'button[type=submit]': 'button' },
    fetch: answering({ login: 'qa', password: 's3cret' }) });
  const code = snippet({ url: 'http://127.0.0.1:9999/api/e2e-login?taskId=t1&ticket=abc', login: '#user', password: '#pass', submit: 'button[type=submit]' });
  assert.strictEqual(await run(code, page.context), 'LOGIN_SUBMITTED');
  assert.strictEqual(page.nodes['#user'].value, 'qa');
  assert.strictEqual(page.nodes['#pass'].value, 's3cret');
  assert.deepStrictEqual(page.nodes['#pass'].events, ['input', 'change', 'blur']);
  assert.strictEqual(page.nodes['button[type=submit]'].clicked, 1);
  // What the agent pastes into its tool call holds the ticket, never a credential.
  assert.ok(!code.includes('s3cret') && !code.includes('"qa"'));
  assert.ok(!/\n/.test(code), 'one line, so it is passed on verbatim');
});

test('without a submit control it submits the form, and says so when there is none to submit', async () => {
  const withForm = fakePage({ fields: { '#user': 'input', '#pass': 'input-in-form' }, fetch: answering({ login: 'qa', password: 'p' }) });
  assert.strictEqual(await run(snippet({ url: 'u', login: '#user', password: '#pass', submit: '' }), withForm.context), 'LOGIN_SUBMITTED');
  assert.strictEqual(withForm.form.submitted, 1);
  const bare = fakePage({ fields: { '#user': 'input' }, fetch: answering({ login: 'qa', password: 'p' }) });
  assert.strictEqual(await run(snippet({ url: 'u', login: '#user', password: '', submit: '' }), bare.context), 'LOGIN_FILLED',
    'the first page of a two-page login: the agent presses Next itself');
  assert.strictEqual(bare.nodes['#user'].value, 'qa');
});

test('a missing field, a refused ticket and a dead stepper each come back as their own word', async () => {
  const page = fakePage({ fields: { '#user': 'input' }, fetch: answering({ login: 'qa', password: 'p' }) });
  assert.strictEqual(await run(snippet({ url: 'u', login: '#user', password: '#nope', submit: '' }), page.context), 'LOGIN_FIELD_NOT_FOUND password');
  assert.strictEqual(await run(snippet({ url: 'u', login: '#user', password: '', submit: '#go' }), page.context), 'LOGIN_FIELD_NOT_FOUND submit');
  const refused = fakePage({ fields: { '#user': 'input' }, fetch: answering({ error: 'bad or expired ticket' }, 403) });
  assert.strictEqual(await run(snippet({ url: 'u', login: '#user', password: '', submit: '' }), refused.context), 'LOGIN_TICKET_REFUSED 403');
  assert.strictEqual(refused.nodes['#user'].value, '', 'nothing is typed without the credentials');
  const dead = fakePage({ fields: { '#user': 'input' }, fetch: async () => { throw new Error('Failed to fetch'); } });
  assert.strictEqual(await run(snippet({ url: 'u', login: '#user', password: '', submit: '' }), dead.context), 'LOGIN_FETCH_FAILED Failed to fetch');
});

test('a selector with quotes cannot break out of the snippet', async () => {
  const selector = 'input[name="user\'s \\"login\\""]';
  const page = fakePage({ fields: { [selector]: 'input' }, fetch: answering({ login: 'qa', password: 'p' }) });
  assert.strictEqual(await run(snippet({ url: 'u', login: selector, password: '', submit: '' }), page.context), 'LOGIN_FILLED');
  assert.strictEqual(page.nodes[selector].value, 'qa');
});

test('against the stepper: a ticket for the task\'s own dev server, and a reason when there is none to give', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-login-'));
  const app = createApp(dir);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => { app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = app.server.address().port;
  const args = { port, task: 't1', appPort: 4317, login: '#user', password: '#pass', submit: '' };

  assert.deepStrictEqual(await chromeLogin(args), ['LOGIN_UNAVAILABLE no credentials saved for this task']);
  await fetch(`http://127.0.0.1:${port}/api/auth`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 't1', login: 'qa', password: 's3cret' }) });
  assert.match((await chromeLogin(args))[0], /^LOGIN_UNAVAILABLE port 4317 is not a process this task started/);
  fs.writeFileSync(path.join(dir, 'tasks', 't1', 'processes.json'), JSON.stringify([{ port: 4317 }]));

  const [head, code] = await chromeLogin(args);
  assert.strictEqual(head, 'LOGIN_SNIPPET');
  // The snippet's own fetch, as the page at the dev server's origin would send it.
  const page = fakePage({ fields: { '#user': 'input', '#pass': 'input-in-form' },
    fetch: (url, init) => fetch(url, { ...init, headers: { origin: 'http://localhost:4317' } }) });
  assert.strictEqual(await run(code, page.context), 'LOGIN_SUBMITTED');
  assert.strictEqual(page.nodes['#pass'].value, 's3cret');
  assert.strictEqual(await run(code, page.context), 'LOGIN_TICKET_REFUSED 403', 'the same snippet a second time: its ticket is spent');
  assert.deepStrictEqual(await chromeLogin({ ...args, port: 1 }).then((l) => l[0].slice(0, 17)), 'LOGIN_UNAVAILABLE');
});

test('parseArgs needs the stepper, the task, the dev server and a field', () => {
  const ok = parseArgs(['--port=9999', '--task=t1', '--app-port=4317', '--password-selector=#p']);
  assert.deepStrictEqual([ok.port, ok.task, ok.appPort, ok.password], [9999, 't1', 4317, '#p']);
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--app-port=4317']), /name the field to fill/);
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--password-selector=#p']), /--app-port/);
  assert.throws(() => parseArgs(['--port=9999', '--task=t1', '--app-port=4317', '--pasword-selector=#p']), /Unknown argument/);
});
