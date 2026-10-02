'use strict';

var codes = { WELCOME10: 10, SPRING15: 15, SUMMER20: 20 };

// The percentage a discount code takes off, 0 for a code nobody issued.
function discountPercent(code) {
  return codes[String(code || '').toUpperCase()] || 0;
}

module.exports = { discountPercent };
