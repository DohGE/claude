'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const bundle = require('./review-bundle.cjs');

// The Workflow script (skills/codeReview/workflows/review-windows.js) is plain JavaScript run by
// the Workflow tool with agent/parallel/phase/log/args in scope; here it runs with stubs.
const source = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'review-windows.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const body = source.replace('export const meta =', 'const meta =');

async function runWorkflow(args, reply) {
  const calls = [];
  let running = 0;
  let most = 0;
  const agent = async (prompt, options) => {
    calls.push({ prompt, options });
    running++;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return reply(prompt, calls.filter((c) => c.prompt === prompt).length);
  };
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk().catch(() => null)));
  const result = await new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', body)(agent, parallel, () => {}, () => {}, args);
  return { result, calls, most };
}

test('the workflow script declares its meta as a pure literal', () => {
  const meta = source.match(/^export const meta = (\{[\s\S]*?\n\})\n/);
  assert.ok(meta, 'export const meta = {...} opens the script');
  assert.doesNotMatch(meta[1], /\$\{|\.\.\./, 'no interpolation or spread');
  assert.match(meta[1], /title: 'Windows'/);
  assert.match(meta[1], /title: 'Cross-file'/);
});

test('the workflow walks the windows side by side, each with its own setting, then the cross-file pass', async () => {
  const args = { dir: 'w', lanes: 2, windows: [['1-4', '', ''], ['5-8', 'sonnet', 'medium'], ['9-9', '', '']], cross: { model: '', effort: 'high' } };
  const { result, calls, most } = await runWorkflow(args, (prompt) => (prompt.includes('cross-file') ? 'CROSS DONE' : `WINDOW DONE ${prompt}`));
  assert.strictEqual(most, 2, 'two lanes');
  const prompts = calls.map((c) => c.prompt);
  assert.deepStrictEqual(prompts.slice(0, 3).sort(), [1, 2, 3].map((k) => `Read w/${bundle.windowBriefName(k)} and follow it.`).sort(), 'the briefs review-context.cjs writes');
  assert.strictEqual(prompts[3], `Read w/${bundle.crossBriefName} and follow it.`, 'the cross-file pass comes last');
  const second = calls.find((c) => c.prompt.includes('window02'));
  assert.deepStrictEqual([second.options.agentType, second.options.model, second.options.effort], ['doh:codereview-walker', 'sonnet', 'medium']);
  assert.ok(!('model' in calls.find((c) => c.prompt.includes('window01')).options), 'no setting is inherit');
  assert.strictEqual(calls[3].options.effort, 'high');
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(result.cross, 'CROSS DONE');
});

test('one run walks the windows of every target from one pool of lanes, each cross-file pass right after its own windows', async () => {
  const args = {
    lanes: 2,
    targets: [
      { dir: 'runs/s/a/raport.work', windows: [['1-4', '', ''], ['5-8', '', '']], cross: { model: '', effort: '' } },
      { dir: 'runs/s/b/raport.work', windows: [['1-3', 'sonnet', 'medium']], cross: {} },
    ],
  };
  const { result, calls, most } = await runWorkflow(args, (prompt) => (prompt.includes('cross-file') ? 'CROSS DONE' : 'WINDOW DONE x'));
  assert.strictEqual(most, 2, 'the targets share the lanes');
  assert.deepStrictEqual(result.targets.map((t) => [t.dir, t.failed, t.cross]), [['runs/s/a/raport.work', [], 'CROSS DONE'], ['runs/s/b/raport.work', [], 'CROSS DONE']]);
  const at = (prompt) => calls.findIndex((c) => c.prompt === prompt);
  const read = (dir, name) => `Read ${dir}/${name} and follow it.`;
  assert.ok(at(read('runs/s/a/raport.work', bundle.crossBriefName)) > at(read('runs/s/a/raport.work', bundle.windowBriefName(2))));
  assert.ok(at(read('runs/s/b/raport.work', bundle.crossBriefName)) > at(read('runs/s/b/raport.work', bundle.windowBriefName(1))));
  const sonnet = calls.find((c) => c.prompt === read('runs/s/b/raport.work', bundle.windowBriefName(1)));
  assert.deepStrictEqual([sonnet.options.model, sonnet.options.effort], ['sonnet', 'medium']);
  assert.match(sonnet.options.label, /^b: window 1\/1: files 1-3$/, 'a label names its target');
});

test('a target whose window stops twice holds back its own cross-file pass only', async () => {
  const args = { lanes: 3, targets: [{ dir: 'a', windows: [['1-2', '', '']], cross: {} }, { dir: 'b', windows: [['1-2', '', '']], cross: {} }] };
  const { result, calls } = await runWorkflow(args, (prompt) => (prompt.startsWith('Read a/window') ? 'WINDOW STOPPED 1: refused' : prompt.includes('cross-file') ? 'CROSS DONE' : 'WINDOW DONE x'));
  assert.deepStrictEqual(result.targets.map((t) => [t.failed, t.cross]), [[[1], null], [[], 'CROSS DONE']]);
  assert.ok(!calls.some((c) => c.prompt === `Read a/${bundle.crossBriefName} and follow it.`));
});

test('a stopped window is started once more; one that stops twice holds the cross-file pass back', async () => {
  const args = { dir: 'w', lanes: 3, windows: [['1-2', '', ''], ['3-4', '', '']], cross: {} };
  const flaky = await runWorkflow(args, (prompt, attempt) => (prompt.includes('window01') && attempt === 1 ? 'WINDOW STOPPED 1: refused' : 'WINDOW DONE x'));
  assert.deepStrictEqual(flaky.result.failed, []);
  assert.strictEqual(flaky.calls.filter((c) => c.prompt.includes('window01')).length, 2);
  const broken = await runWorkflow(args, (prompt) => (prompt.includes('window02') ? 'WINDOW STOPPED 3: refused' : 'WINDOW DONE x'));
  assert.deepStrictEqual(broken.result.failed, [2]);
  assert.strictEqual(broken.result.cross, null);
  assert.ok(!broken.calls.some((c) => c.prompt.includes('cross-file')));
});
