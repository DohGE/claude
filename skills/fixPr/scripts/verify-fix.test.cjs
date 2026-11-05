'use strict';

const test = require('node:test');
const assert = require('node:assert');

const vf = require('./verify-fix.cjs');

const comments = {
  pr: { number: 7 },
  threads: [
    { id: 'T1', path: 'a.ts', comments: [{ author: 'ann', url: 'u1', body: 'x' }] },
    { id: 'T2', path: 'b.ts', comments: [{ author: 'ann', url: 'u2', body: 'y', media: [{ kind: 'image', path: '/m/1.png' }] }] },
  ],
  conversation: [{ id: 9, author: 'scanner', isBot: true, url: 'c9', body: 'CVE' }],
  reviews: [{ id: 3, author: 'kr', url: 'r3', body: '1- padding\n2- keep the row lit', media: [{ kind: 'video', path: '/m/2.mp4', frames: ['/m/f1.png'] }] }],
};

test('a run that gave every item a grounded verdict, saw the pictures and closed its threads passes', () => {
  const result = {
    committed: true, pushed: true, fixedThreadIds: ['T1', 'T2'],
    verdicts: [
      { item: 'thread:T1', verdict: 'fixed' },
      { item: 'thread:T2', verdict: 'fixed', sawMedia: true },
      { item: 'conversation:9', verdict: 'answered' },
      { item: 'review:3', verdict: 'fixed', sawMedia: true },
    ],
  };
  const out = vf.verify({ comments, result, openThreads: [] });
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.deepStrictEqual([out.total, out.accounted, out.fixed, out.answered], [4, 4, 3, 1]);
});

test('every gap comes back by name: unaccounted, groundless, unseen media, mismatched ids, still open, new', () => {
  const result = {
    committed: true, pushed: true, fixedThreadIds: ['T1', 'T9'],
    verdicts: [
      { item: 'thread:T1', verdict: 'fixed' },
      { item: 'thread:T2', verdict: 'rejected' },
      { item: 'review:3', verdict: 'fixed' },
      { item: 'review:4', verdict: 'fixed' },
    ],
  };
  const out = vf.verify({ comments, result, openThreads: [{ id: 'T1' }, { id: 'T5', path: 'c.ts', comments: [{ author: 'jm', url: 'u5' }] }] });
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.unaccounted.map((u) => u.item), ['conversation:9']);
  assert.deepStrictEqual(out.noGround.map((u) => u.item), ['thread:T2']);
  assert.deepStrictEqual(out.mediaNotSeen.map((u) => u.item), ['thread:T2', 'review:3']);
  assert.deepStrictEqual(out.inconsistent.map((u) => u.item), ['thread:T9']);
  assert.deepStrictEqual(out.unknownItems, ['review:4']);
  assert.deepStrictEqual(out.stillOpen.map((u) => u.item), ['thread:T1']);
  assert.deepStrictEqual(out.newSinceRun, [{ item: 'thread:T5', author: 'jm', url: 'u5', path: 'c.ts' }]);
});

test('a result with no verdicts at all is an error, not a pass', () => {
  const out = vf.verify({ comments, result: { fixedThreadIds: [] } });
  assert.strictEqual(out.ok, false);
  assert.match(out.errors[0], /no verdicts/);
  assert.strictEqual(out.unaccounted.length, 4);
  assert.throws(() => vf.parseArgs(['--comments=a']), /required/);
});

test('a --local run is checked by its findings, and a task by its own item', () => {
  const out = vf.verify({ comments: { findings: [{ id: 'da3d32cd', path: 'x.ts' }], task: 'add … to the label' }, result: { verdicts: [{ item: 'finding:da3d32cd', verdict: 'fixed' }], fixedThreadIds: [] } });
  assert.deepStrictEqual(out.unaccounted.map((u) => u.item), ['task']);
});
