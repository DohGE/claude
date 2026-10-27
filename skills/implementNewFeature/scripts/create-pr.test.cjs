'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, createPr, branchName } = require('./create-pr.cjs');

const slugOf = () => ({ owner: 'acme', repo: 'app' });

test('a pull request is opened with the title, the body and the base it was started from', () => {
  const body = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'create-pr-')), 'body.md');
  fs.writeFileSync(body, 'Adds the hosts inventory.');
  const sent = [];
  const send = (root, req) => {
    sent.push(req);
    return { ok: true, status: 201, json: { html_url: 'https://github.com/acme/app/pull/7' } };
  };
  const line = createPr({ root: '.', head: 'refs/heads/feature/x', base: 'origin/master', title: ' feat: hosts ', bodyFile: body },
    { send, findPr: () => ({ pr: null }), slugOf });
  assert.strictEqual(line, 'PR_CREATED https://github.com/acme/app/pull/7');
  assert.deepStrictEqual(sent, [{ path: '/repos/acme/app/pulls', method: 'POST',
    body: { title: 'feat: hosts', head: 'feature/x', base: 'master', body: 'Adds the hosts inventory.' } }]);
});

test('an open pull request of the branch is returned, never a second one opened', () => {
  const send = () => assert.fail('no request when one is open');
  assert.strictEqual(createPr({ root: '.', head: 'feature/x', base: 'master', title: 't' },
    { send, findPr: () => ({ pr: { url: 'https://github.com/acme/app/pull/3' } }), slugOf }), 'PR_EXISTS https://github.com/acme/app/pull/3');
  let calls = 0;
  const raced = createPr({ root: '.', head: 'feature/x', base: 'master', title: 't' }, {
    send: () => ({ ok: false, status: 422, json: { errors: [{ message: 'A pull request already exists' }] }, error: 'Validation Failed' }),
    findPr: () => (calls++ ? { pr: { url: 'https://github.com/acme/app/pull/4' } } : { pr: null }), slugOf });
  assert.strictEqual(raced, 'PR_EXISTS https://github.com/acme/app/pull/4');
});

test('a refusal says why, and a repository off GitHub is said plainly', () => {
  assert.strictEqual(createPr({ root: '.', head: 'x', base: 'master', title: 't' },
    { send: () => ({ ok: false, status: 422, json: { errors: [{ message: 'No commits between master and x' }] }, error: 'Validation Failed' }),
      findPr: () => ({ pr: null }), slugOf }), 'PR_FAILED Validation Failed: No commits between master and x');
  assert.match(createPr({ root: '.', head: 'x', base: 'master', title: 't' }, { slugOf: () => null }), /^PR_FAILED .* has no github\.com remote$/);
  assert.match(createPr({ root: '.', head: 'master', base: 'origin/master', title: 't' }, { slugOf }), /its own base/);
  assert.throws(() => parseArgs(['--root=.', '--head=x', '--base=master']), /--title is required/);
  assert.strictEqual(branchName('refs/remotes/origin/develop'), 'develop');
});
