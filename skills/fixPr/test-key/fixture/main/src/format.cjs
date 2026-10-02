'use strict';

// 1999 -> "19.99 EUR"
function formatPrice(cents, currency = 'EUR') {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

module.exports = { formatPrice };
