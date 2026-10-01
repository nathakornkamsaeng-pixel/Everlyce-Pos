const express = require('express');
const { coll, nextId, now, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const L = require('../loyaltyEngine');
const pdpa = require('../pdpa');
const { recompute } = require('../orderTotals');
const { log, EVENTS } = require('../activityLog');

const router = express.Router();

// The notice is read before anyone signs up, so it sits above the auth gate.
// A customer cannot consent to something they are not allowed to read. The
// shape is built in one place, shared with the public /api/public/privacy-notice.
const { noticeForStore: privacyNotice } = require('../privacyNotice');

router.get('/privacy-notice', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(privacyNotice());
});

router.use(requireAuth);

router.get('/members', (req, res) => {
  res.json(coll('loyaltyMembers').map(L.publicMember));
});

// Cashier flow: type a phone number at the register, get the member back (or null).
router.get('/lookup', (req, res) => {
  const member = L.findByPhone(req.query.phone);
  const cfg = L.settings();
  res.json({
    found: !!member,
    member: L.publicMember(member),
    maxRedeemablePoints: L.maxRedeemablePoints(member),
    rules: {
      enabled: cfg.enabled,
      prompt: cfg.prompt,
      allowSkip: cfg.allowSkip,
      autoRegister: cfg.autoRegister,
      requirePhone: cfg.requirePhone,
      pointValue: cfg.pointValue,
      minRedeemPoints: cfg.minRedeemPoints,
      maxCoupons: cfg.maxCoupons,
      allowStacking: cfg.allowStacking,
    },
  });
});

// Registering at the register, from the charge popup.
router.post('/register', (req, res) => {
  const b = req.body || {};
  const phone = String(b.phone || '').trim();
  if (!phone) return res.status(400).json({ detail: 'phone is required' });
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ detail: 'name is required' });
  if (L.findByPhone(phone)) return res.status(409).json({ detail: 'That phone number is already registered' });
  const m = {
    id: nextId('loyaltyMembers'),
    name: String(b.name).trim(),
    phone,
    email: b.email || null,
    points: Math.max(0, Number(b.points) || 0),
    tier: b.tier || 'standard',
    createdAt: now(),
  };
  coll('loyaltyMembers').push(m);
  L.ledger({ memberId: m.id, type: 'signup', points: 0, note: 'Member registered' });
  log(EVENTS.MEMBER_NEW, req, { id: m.id, name: m.name });
  touch();
  res.status(201).json(L.publicMember(m));
});

// Coupons the cashier can see and check against the member's balance.
router.get('/coupons', (req, res) => {
  const cfg = L.settings();
  res.json(coll('discounts').map((d) => ({
    id: d.id,
    code: d.code,
    name: d.name,
    type: d.type,
    value: d.value,
    active: d.active !== false,
    pointsCost: Math.max(0, Number(d.pointsCost) || 0),
    stackable: d.stackable !== false,
  })));
});

// Check a set of codes + points before the cashier commits to payment.
router.post('/quote', (req, res) => {
  const b = req.body || {};
  const order = coll('orders').find((o) => o.id === Number(b.orderId));
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  const member = b.memberId ? L.findById(b.memberId) : null;
  const result = L.priceRedemption({
    order,
    member,
    codes: b.codes || [],
    pointsToUse: b.pointsToUse || 0,
  });
  if (!result.ok) return res.status(400).json({ detail: result.error });
  res.json({
    discount: result.discount,
    coupons: result.coupons,
    points: result.points,
    couponPointCost: result.couponPointCost,
    totalPoints: result.totalPoints,
    pointsValue: result.pointsValue,
    maxRedeemablePoints: L.maxRedeemablePoints(member),
  });
});

// Lock the chosen member/coupons/points onto the order before payment.
router.post('/apply', (req, res) => {
  const b = req.body || {};
  const order = coll('orders').find((o) => o.id === Number(b.orderId));
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  if (order.paymentStatus === 'paid') return res.status(400).json({ detail: 'Order is already closed' });
  const member = b.memberId ? L.findById(b.memberId) : null;
  if (b.memberId && !member) return res.status(404).json({ detail: 'Member not found' });

  const result = L.priceRedemption({
    order,
    member,
    codes: b.codes || [],
    pointsToUse: b.pointsToUse || 0,
  });
  if (!result.ok) return res.status(400).json({ detail: result.error });

  order.memberId = member ? member.id : null;
  order.memberName = member ? member.name : null;
  order.coupons = result.coupons;
  order.pointsUsed = result.totalPoints;
  order.pointsDiscount = result.pointsValue;
  order.discount = result.discount;
  recompute(order);
  order.loyaltyAppliedAt = now();
  order.updatedAt = now();
  touch();
  res.json({
    orderId: order.id,
    member: L.publicMember(member),
    coupons: result.coupons,
    pointsUsed: result.totalPoints,
    pointsDiscount: result.pointsValue,
    discount: result.discount,
    totalPointsDue: order.total,
  });
});

// Clear a loyalty application from a still-open order.
router.post('/clear', (req, res) => {
  const order = coll('orders').find((o) => o.id === Number((req.body || {}).orderId));
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  if (order.paymentStatus === 'paid') return res.status(400).json({ detail: 'Order is already closed' });
  order.memberId = null;
  order.memberName = null;
  order.coupons = [];
  order.pointsUsed = 0;
  order.pointsDiscount = 0;
  order.discount = 0;
  recompute(order);
  order.loyaltyAppliedAt = null;
  order.updatedAt = now();
  touch();
  res.json({ ok: true });
});

// Point history, newest first.
router.get('/ledger', (req, res) => {
  const entries = coll('loyaltyLedger');
  res.json(entries.slice().sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 200));
});

// ---- admin member management ----
router.post('/members', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ detail: 'name is required' });

  // Under the PDPA a customer's phone number and email are personal data, so
  // consent is recorded at the point it is collected, not assumed later.
  // A member with no identifying details is not personal data and needs none.
  const isPersonal = Boolean(b.phone || b.email);
  if (isPersonal && b.consentLoyalty !== true && b.consentMarketing !== true) {
    return res.status(400).json({
      detail: 'Record the customer\'s consent before saving their phone number or email',
      code: 'consent_required',
      policyVersion: pdpa.policyVersion(),
    });
  }
  if (b.phone && !pdpa.isValidPhone(b.phone)) {
    return res.status(400).json({ detail: 'That does not look like a valid phone number' });
  }

  const m = {
    id: nextId('loyaltyMembers'),
    name: String(b.name),
    phone: b.phone ? pdpa.normalizePhone(b.phone) : null,
    email: b.email || null,
    points: Number(b.points) || 0,
    tier: b.tier || 'standard',
    createdAt: now(),
  };
  pdpa.attachConsent(m, b, req);
  coll('loyaltyMembers').push(m);
  touch();
  log(EVENTS.MEMBER_NEW, req, { member: m.id, consent: m.consent ? m.consent.purposes.join('+') : 'no-personal-data' });
  res.status(201).json(L.publicMember(m));
});

// ------------------------------------------------- data subject rights

// Right of access and portability. Returns a file the customer can keep.
router.get('/members/:id/export', requireRole('admin'), (req, res) => {
  const m = L.findById(req.params.id);
  if (!m) return res.status(404).json({ detail: 'Member not found' });
  const data = pdpa.exportMember(m);
  log(EVENTS.DATA_SUBJECT_ACCESS, req, { member: m.id });
  res.set('Content-Disposition', `attachment; filename="customer-${m.id}.json"`);
  res.json(data);
});

// Withdrawal of consent. The record stays, because the balance may be owed,
// but marketing contact stops immediately.
router.post('/members/:id/withdraw-consent', requireRole('admin'), (req, res) => {
  const m = L.findById(req.params.id);
  if (!m) return res.status(404).json({ detail: 'Member not found' });
  const purpose = req.body && typeof req.body.purpose === 'string' ? req.body.purpose : null;
  const updated = pdpa.withdrawConsent(m, purpose);
  touch();
  log(EVENTS.CONSENT_WITHDRAWN, req, { member: m.id, purpose: purpose || 'all' });
  res.json(L.publicMember(updated));
});

// Right to erasure. Personal fields are removed; the financial trail is kept
// in a form that no longer identifies anyone.
router.delete('/members/:id', requireRole('admin'), (req, res) => {
  const m = L.findById(req.params.id);
  if (!m) return res.status(404).json({ detail: 'Member not found' });
  const removed = pdpa.eraseMember(m);
  touch();
  log(EVENTS.DATA_SUBJECT_ERASURE, req, { member: m.id, ...removed });
  res.json({ ok: true, removed });
});

// Keeps a record out of the retention sweep, for example a disputed balance.
router.post('/members/:id/pin', requireRole('admin'), (req, res) => {
  const m = L.findById(req.params.id);
  if (!m) return res.status(404).json({ detail: 'Member not found' });
  m.pinned = req.body && req.body.pinned === false ? false : true;
  touch();
  res.json(L.publicMember(m));
});


router.put('/members/:id', requireRole('admin'), (req, res) => {
  const m = L.findById(req.params.id);
  if (!m) return res.status(404).json({ detail: 'Member not found' });
  const b = req.body || {};
  if (b.name !== undefined) m.name = String(b.name);
  if (b.phone !== undefined) m.phone = b.phone || null;
  if (b.email !== undefined) m.email = b.email || null;
  if (b.tier !== undefined) m.tier = b.tier;
  if (b.points !== undefined) {
    const next = Math.max(0, Number(b.points) || 0);
    const delta = next - (Number(m.points) || 0);
    if (delta !== 0) L.ledger({ memberId: m.id, type: 'adjust', points: delta, note: 'Manual adjustment' });
    m.points = next;
  }
  touch();
  res.json(L.publicMember(m));
});

router.delete('/members/:id', requireRole('admin'), (req, res) => {
  const idx = coll('loyaltyMembers').findIndex((x) => x.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ detail: 'Member not found' });
  coll('loyaltyMembers').splice(idx, 1);
  touch();
  res.json({ ok: true });
});

module.exports = router;
