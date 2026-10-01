const { coll, nextId, now } = require('./db');
const { ROUND2, itemLineTotal } = require('./orderTotals');

function numberSetting(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalisePhone(phone) {
  const raw = String(phone || '').replace(/[^\d]/g, '');
  if (!raw) return '';
  if (raw.startsWith('66') && raw.length > 9) return `0${raw.slice(2)}`;
  return raw;
}

function settings() {
  const s = coll('settings');
  return {
    enabled: s.loyaltyEnabled !== false,
    prompt: ['always', 'optional', 'never'].includes(s.loyaltyPrompt) ? s.loyaltyPrompt : 'always',
    pointsPerUnit: Math.max(0, numberSetting(s.loyaltyPointsPerUnit, 1)),
    pointValue: Math.max(0, numberSetting(s.loyaltyPointValue, 0)),
    minRedeemPoints: Math.max(0, numberSetting(s.loyaltyMinRedeemPoints, 0)),
    requirePhone: Boolean(s.loyaltyRequirePhone),
    autoRegister: Boolean(s.loyaltyAutoRegister),
    allowSkip: s.loyaltyAllowSkip !== false,
    maxCoupons: Math.max(0, numberSetting(s.loyaltyMaxCoupons, 0)),
    allowStacking: s.loyaltyAllowStacking !== false,
  };
}

function findByPhone(phone) {
  const key = normalisePhone(phone);
  return key ? coll('loyaltyMembers').find((member) => normalisePhone(member.phone) === key) || null : null;
}

function findById(id) {
  return coll('loyaltyMembers').find((member) => Number(member.id) === Number(id)) || null;
}

function publicMember(member) {
  if (!member) return null;
  return {
    id: member.id,
    name: member.name,
    phone: member.phone,
    email: member.email || null,
    points: Number(member.points) || 0,
    tier: member.tier || 'standard',
    createdAt: member.createdAt,
    // Consent state, so staff can see at a glance whether marketing contact is
    // allowed before they use a record.
    consentAt: member.consentAt || null,
    consentVersion: member.consentVersion || null,
    consentPurposes: (member.consent && member.consent.purposes) || [],
    consentWithdrawnAt: member.consentWithdrawnAt || (member.consent && member.consent.withdrawnAt) || null,
    dataRetentionUntil: member.dataRetentionUntil || null,
    pinned: member.pinned === true,
  };
}

function findCoupon(code) {
  const value = String(code || '').trim().toUpperCase();
  return value ? coll('discounts').find((discount) => String(discount.code || '').trim().toUpperCase() === value) || null : null;
}

function maxRedeemablePoints(member) {
  const cfg = settings();
  if (!cfg.enabled || !member || cfg.pointValue <= 0) return 0;
  const balance = Number(member.points) || 0;
  if (cfg.minRedeemPoints && balance < cfg.minRedeemPoints) return 0;
  return Math.max(0, Math.floor(balance));
}

function couponDiscountValue(coupon, subtotal) {
  const value = Number(coupon.value) || 0;
  return ROUND2(coupon.type === 'percent' ? Math.min((subtotal * Math.max(0, value)) / 100, subtotal) : Math.min(Math.max(0, value), subtotal));
}

function orderSubtotal(order) {
  const items = coll('orderItems').filter((item) => item.orderId === order.id && item.status !== 'cancelled' && !item.refunded);
  return ROUND2(items.reduce((sum, item) => sum + itemLineTotal(item), 0));
}

function priceRedemption({ order, member, codes = [], pointsToUse = 0 }) {
  const cfg = settings();
  if (!cfg.enabled) return { ok: false, error: 'Loyalty is switched off' };
  if (!order) return { ok: false, error: 'Order not found' };
  if (!Array.isArray(codes)) return { ok: false, error: 'Coupon codes must be an array' };
  const subtotal = orderSubtotal(order);
  if (subtotal <= 0) return { ok: false, error: 'Nothing to discount' };
  const wanted = [...new Set(codes.map((code) => String(code || '').trim()).filter(Boolean))];
  if (cfg.maxCoupons && wanted.length > cfg.maxCoupons) return { ok: false, error: `A maximum of ${cfg.maxCoupons} coupon${cfg.maxCoupons === 1 ? '' : 's'} can be used` };
  const coupons = [];
  const seen = new Set();
  for (const code of wanted) {
    const coupon = findCoupon(code);
    if (!coupon) return { ok: false, error: `Coupon ${code} not found` };
    if (coupon.active === false) return { ok: false, error: `Coupon ${code} is not active` };
    if (seen.has(coupon.id)) continue;
    if (coupon.stackable === false && wanted.length > 1) return { ok: false, error: `Coupon ${coupon.code} cannot be used with other coupons` };
    if (!cfg.allowStacking && wanted.length > 1) return { ok: false, error: 'Only one coupon can be used at a time' };
    const cost = Math.max(0, Number(coupon.pointsCost) || 0);
    if (cost > 0 && (!member || Number(member.points) < cost)) return { ok: false, error: `Coupon ${coupon.code} needs ${cost} points` };
    seen.add(coupon.id);
    coupons.push({ id: coupon.id, code: coupon.code, name: coupon.name, discount: couponDiscountValue(coupon, subtotal), pointsCost: cost });
  }
  const maxDiscount = ROUND2(subtotal + (Number(order.tax) || 0) + (Number(order.serviceCharge) || 0));
  const couponTotal = ROUND2(Math.min(coupons.reduce((sum, coupon) => sum + coupon.discount, 0), maxDiscount));
  const remaining = ROUND2(Math.max(0, subtotal - couponTotal));
  let points = Math.max(0, Math.floor(Number(pointsToUse) || 0));
  const redeemable = maxRedeemablePoints(member);
  if (points > 0 && (!member || points > redeemable)) return { ok: false, error: member ? `Only ${redeemable} points available` : 'A loyalty member is needed to use points' };
  const pointsValue = ROUND2(Math.min(points * cfg.pointValue, remaining));
  if (cfg.pointValue > 0) points = Math.min(points, Math.floor((pointsValue + 1e-9) / cfg.pointValue));
  const couponPointCost = coupons.reduce((sum, coupon) => sum + coupon.pointsCost, 0);
  const totalPoints = points + couponPointCost;
  if (totalPoints > 0 && (!member || Number(member.points) < totalPoints)) return { ok: false, error: `Not enough points (needs ${totalPoints})` };
  return { ok: true, coupons, points, couponPointCost, totalPoints, pointsValue, discount: ROUND2(couponTotal + pointsValue), member: publicMember(member) };
}

function ledger(entry) {
  coll('loyaltyLedger').push({ id: nextId('loyaltyLedger'), at: now(), ...entry });
}

module.exports = { normalisePhone, settings, findByPhone, findById, publicMember, findCoupon, maxRedeemablePoints, priceRedemption, ledger, ROUND2 };
