'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { formatPrice } = require('../src/format.cjs');

test('formatPrice prints cents as a decimal amount', () => {
  assert.strictEqual(formatPrice(1999), '19.99 EUR');
  assert.strictEqual(formatPrice(5, 'PLN'), '0.05 PLN');
});
