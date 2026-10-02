'use strict';

// Shipping in cents: a rate per destination zone plus a surcharge per started kilogram.
const zoneRates = { domestic: 900, eu: 1200, world: 2500 };
const perKgCents = 150;
const freeShippingThresholdCents = 10000;

function zoneRate(zone) {
  return zoneRates[zone];
}

// Domestic orders of 100.00 or more ship free.
function shippingCost(orderCents, zone, kg) {
  if (zone === 'domestic' && orderCents > freeShippingThresholdCents) return 0;
  return zoneRate(zone) + Math.ceil(kg) * perKgCents;
}

module.exports = { shippingCost, zoneRate };
