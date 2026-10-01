const { coll } = require('./db');

const ROUND2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function parsedModifiers(item) {
  try {
    const value = JSON.parse(item.modifiers || '[]');
    return Array.isArray(value) ? value : [];
  } catch (e) {
    return [];
  }
}

function modifierAdj(item) {
  return parsedModifiers(item).reduce((sum, modifier) => sum + Math.max(0, Number(modifier.adj) || 0), 0);
}

function itemLineTotal(item) {
  return ROUND2(((Number(item.unitPrice) || 0) + modifierAdj(item)) * (Number(item.quantity) || 0));
}

function recompute(order) {
  const items = coll('orderItems').filter((item) => item.orderId === order.id && item.status !== 'cancelled' && !item.refunded);
  const subtotal = ROUND2(items.reduce((sum, item) => sum + itemLineTotal(item), 0));
  const settings = coll('settings');
  const taxRate = Number(settings.taxRate) || 0;
  const serviceRate = Number(settings.serviceChargeRate) || 0;
  const tax = ROUND2((subtotal * taxRate) / 100);
  const serviceCharge = ROUND2((subtotal * serviceRate) / 100);
  const maxDiscount = ROUND2(subtotal + tax + serviceCharge);
  const requestedDiscount = Math.max(0, Number(order.discount) || 0);
  const discount = ROUND2(Math.min(requestedDiscount, maxDiscount));
  const tip = Math.max(0, Number(order.tip) || 0);
  order.subtotal = subtotal;
  order.tax = tax;
  order.serviceCharge = serviceCharge;
  order.discount = discount;
  order.tip = tip;
  order.total = ROUND2(Math.max(0, subtotal + tax + serviceCharge - discount + tip));
  return order;
}

module.exports = { ROUND2, parsedModifiers, modifierAdj, itemLineTotal, recompute };
