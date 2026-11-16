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

test('the cross-file pass goes to its own agent, and the run folder\'s copy walks with the args written into it', async () => {
  const baked = { dir: 'w', lanes: 1, windows: [['1-2', '', '']], cross: { model: '', effort: '' } };
  const copy = body.replace(/^const baked = null$/m, `const baked = ${JSON.stringify(baked)}`);
  assert.notStrictEqual(copy, body, 'the script has the line review-context.cjs writes the args into');
  const calls = [];
  const agent = async (prompt, options) => {
    calls.push({ prompt, options });
    return prompt.includes('cross-file') ? 'CROSS DONE' : 'WINDOW DONE 1-2';
  };
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk()));
  const result = await new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', copy)(agent, parallel, () => {}, () => {}, undefined);
  assert.deepStrictEqual(calls.map((c) => [c.prompt, c.options.agentType]), [
    ['Read w/window01.md and follow it.', 'doh:codereview-walker'],
    ['Read w/cross-file.brief.md and follow it.', 'doh:codereview-cross'],
  ]);
  assert.strictEqual(result.cross, 'CROSS DONE');
});

test('a window carrying verdicts from an earlier part of the stack starts after the window that walks them', async () => {
  const args = {
    lanes: 3,
    targets: [
      { dir: 'a', windows: [['1-2', '', ''], ['3-4', '', '']], cross: {} },
      { dir: 'b', windows: [['1-2', '', '', ['1:2']]], cross: {} },
    ],
  };
  const order = [];
  const { result, most } = await runWorkflow(args, (prompt) => {
    order.push(prompt);
    return prompt.includes('cross-file') ? 'CROSS DONE' : 'WINDOW DONE x';
  });
  assert.deepStrictEqual(result.targets.map((t) => t.failed), [[], []]);
  assert.ok(order.indexOf('Read b/window01.md and follow it.') > order.indexOf('Read a/window02.md and follow it.'), 'the reply of a/window02 comes first');
  assert.strictEqual(most, 2, 'three lanes, but b/window01 waits for a/window02');
});

test('the lanes start the ready window with the most ahead of it first, of whichever target', async () => {
  const args = {
    lanes: 1,
    targets: [
      { dir: 'a', windows: [['1-2', '', ''], ['3-4', '', '']], costs: [10, 20], cross: {} },
      { dir: 'b', windows: [['1-2', '', ''], ['3-4', '', '', ['1:1']]], costs: [30, 90], cross: {} },
      { dir: 'c', windows: [['1-2', '', '']], cross: {} },
    ],
  };
  const { calls } = await runWorkflow(args, (prompt) => (prompt.includes('cross-file') ? 'CROSS DONE' : 'WINDOW DONE x'));
  const windows = calls.map((c) => c.prompt).filter((p) => p.includes('/window')).map((p) => p.slice('Read '.length, -' and follow it.'.length));
  assert.deepStrictEqual(windows, ['a/window01.md', 'b/window02.md', 'b/window01.md', 'a/window02.md', 'c/window01.md'],
    'a/window01 is the cheapest but the costliest window waits for it; without costs a window counts as 0 and keeps its order');
});

test('the windows of the target with the longer cross-file pass go first, so the pass runs beside the other windows', async () => {
  const args = {
    lanes: 1,
    targets: [
      { dir: 'a', windows: [['1-2', '', '']], costs: [50], cross: { cost: 10 } },
      { dir: 'b', windows: [['1-2', '', '']], costs: [20], cross: { cost: 100 } },
    ],
  };
  const { calls } = await runWorkflow(args, (prompt) => (prompt.includes('cross-file') ? 'CROSS DONE' : 'WINDOW DONE x'));
  assert.deepStrictEqual(calls.map((c) => c.prompt.slice('Read '.length, -' and follow it.'.length)), ['b/window01.md', 'b/cross-file.brief.md', 'a/window01.md', 'a/cross-file.brief.md']);
  assert.ok(!('cost' in calls[1].options), 'a cost is no spawn option');
});

test('the first batch of a window rides in the message that reads its brief; a walker started again reads the brief alone', async () => {
  const first = ['w/01-a.ts.bundle.md (Read: offset 1, limit 10; offset 11)', 'w/01-a.ts'];
  const args = { dir: 'w', lanes: 1, windows: [['1-2', '', '']], firsts: [first], cross: {} };
  const { result, calls } = await runWorkflow(args, (prompt) => (prompt.includes('cross-file') ? 'CROSS DONE' : prompt.includes('first batch') ? 'WINDOW STOPPED 1: refused' : 'WINDOW DONE 1-2'));
  assert.deepStrictEqual(calls.map((c) => c.prompt), [
    `Read w/window01.md and follow it. In the same message Read its first batch too:\n- ${first[0]}\n- ${first[1]}`,
    'Read w/window01.md and follow it.',
    'Read w/cross-file.brief.md and follow it.',
  ]);
  assert.deepStrictEqual([result.walked, result.windows, result.failed], [1, [], []]);
});

test('the run hands back the command that assembles it and, of its windows, only the ones that are not done', async () => {
  const args = { lanes: 2, next: 'node check-part.cjs --assemble-all', targets: [{ dir: 'a', windows: [['1-2', '', ''], ['3-4', '', '']], cross: {} }] };
  const { result } = await runWorkflow(args, (prompt) => (prompt.includes('window02') ? 'WINDOW STOPPED 3: refused' : 'WINDOW DONE 1-2'));
  assert.deepStrictEqual(result, {
    targets: [{ dir: 'a', walked: 1, windows: [{ window: 2, files: '3-4', reply: 'WINDOW STOPPED 3: refused' }], failed: [2], cross: null }],
    next: 'node check-part.cjs --assemble-all',
  });
  const plain = await runWorkflow({ dir: 'w', lanes: 1, windows: [['1-2', '', '']], cross: {} }, (prompt) => (prompt.includes('cross-file') ? 'CROSS DONE' : 'WINDOW DONE 1-2'));
  assert.deepStrictEqual(plain.result, { walked: 1, windows: [], failed: [], cross: 'CROSS DONE' }, 'no command given, none handed back');
});

test('a target with a gaps step closes its open items before its cross-file pass', async () => {
  const args = { lanes: 1, targets: [{ dir: 'a', windows: [['1-2', '', '']], cross: {}, gaps: { model: 'sonnet', effort: 'medium' } }] };
  const none = await runWorkflow(args, (prompt) => (prompt.includes('cross-file') ? 'CROSS DONE' : 'WINDOW DONE 1-2'));
  assert.ok(!none.calls.some((c) => c.prompt.includes('gaps')), 'no window left an item open: no agent');
  assert.strictEqual(none.result.targets[0].gaps, null);
  const { result, calls } = await runWorkflow(args, (prompt) => (prompt.includes('gaps') ? 'GAPS DONE' : prompt.includes('cross-file') ? 'CROSS DONE' : 'WINDOW DONE 1-2 GAPS'));
  assert.deepStrictEqual(calls.map((c) => c.prompt), ['Read a/window01.md and follow it.', `Read a/${bundle.gapsBriefName} and follow it.`, `Read a/${bundle.crossBriefName} and follow it.`]);
  assert.deepStrictEqual([calls[1].options.agentType, calls[1].options.model, calls[1].options.effort], ['doh:codereview-walker', 'sonnet', 'medium']);
  assert.deepStrictEqual([result.targets[0].gaps, result.targets[0].cross], ['GAPS DONE', 'CROSS DONE']);
});
