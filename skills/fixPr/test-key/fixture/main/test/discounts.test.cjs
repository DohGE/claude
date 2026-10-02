'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { discountPercent } = require('../src/discounts.cjs');

test('discountPercent knows the issued codes, in any case', () => {
  assert.strictEqual(discountPercent('welcome10'), 10);
  assert.strictEqual(discountPercent('NOPE'), 0);
});
