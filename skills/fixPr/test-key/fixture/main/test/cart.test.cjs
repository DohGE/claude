'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { subtotal } = require('../src/cart.cjs');

test('subtotal adds price times quantity', () => {
  assert.strictEqual(subtotal([{ priceCents: 250, qty: 2 }, { priceCents: 100, qty: 1 }]), 600);
});

test('subtotal rounds a fractional quantity to whole cents', () => {
  // 0.35 kg at 9.99 per kg is 349.65 cents.
  assert.strictEqual(subtotal([{ priceCents: 999, qty: 0.35 }]), 350);
});
