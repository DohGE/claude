'use strict';

// 1999 -> "19.99 EUR"
function formatPrice(cents, currency = 'EUR') {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

// 1.5 -> "1.5 kgs"
function formatWeight(kg) {
  return `${kg} kgs`;
}

module.exports = { formatPrice, formatWeight };
