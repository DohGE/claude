'use strict';

// Sums line items priced in cents. A quantity may be fractional (goods sold by weight),
// so each line is rounded to whole cents before it is added.
function subtotal(items) {
  return items.reduce((sum, item) => sum + Math.round(item.priceCents * item.qty), 0);
}

module.exports = { subtotal };
