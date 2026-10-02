'use strict';

const { shippingCost } = require('./shipping.cjs');

// Sums line items priced in cents. A quantity may be fractional (goods sold by weight),
// so each line is rounded to whole cents before it is added.
function subtotal(items) {
  return items.reduce((sum, item) => sum + Math.round(item.priceCents * item.qty), 0);
}

// What the customer pays: the items, then shipping to the zone for the cart's weight.
function cartTotal(items, zone) {
  const itemsCents = subtotal(items);
  const kg = items.reduce((sum, item) => sum + (item.kg || 0) * item.qty, 0);
  return itemsCents + shippingCost(itemsCents, zone, kg);
}

module.exports = { subtotal, cartTotal };
