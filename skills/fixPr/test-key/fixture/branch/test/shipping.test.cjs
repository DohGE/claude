'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shippingCost } = require('../src/shipping.cjs');

test('domestic orders of 100.00 or more ship free', () => {
  assert.strictEqual(shippingCost(10000, 'domestic', 3), 0);
  assert.strictEqual(shippingCost(12500, 'domestic', 3), 0);
});

test('shipping is the zone rate plus a surcharge per started kilogram', () => {
  assert.strictEqual(shippingCost(5000, 'eu', 1.2), 1200 + 2 * 150);
  assert.strictEqual(shippingCost(9999, 'domestic', 0.5), 900 + 150);
});
