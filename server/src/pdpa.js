const { coll, touch, transaction, nextId, now, platformSettings } = require('./db');

// Personal Data Protection Act B.E. 2562 (PDPA) helpers.
//
// What this module does: records consent, honours a withdrawal, exports and
// erases a customer's data on request, and purges records once the retention
// period has passed. What it cannot do: make a business legally compliant.
// A controller still has to publish a notice, register with the PDPC where
// required, train staff, and keep its own records of processing activity.

const CONSENT_VERSION = '1.0';

// Every lawful basis the loyalty module relies on, spelled out so the notice
// and the stored record agree.
const PURPOSES = {
  loyalty: 'Loyalty points and member benefits',
  marketing: 'Promotions and offers',
  service: 'Service the account and answer requests',
};

function settings() {
  return coll('settings');
}

function retentionDays() {
  const value = Number(settings().personalDataRetentionDays);
  if (!Number.isFinite(value) || value < 0) return 365;
  return Math.floor(value);
}

// The version recorded against a customer's consent has to be the version of the
// notice they were actually shown. The notice is the platform's document, so this
// reads the platform's version: a consent record saying "1.0" against a notice
// that says "2.0" is exactly the record that cannot settle a complaint.
function policyVersion() {
  const shared = (platformSettings() || {}).privacy || {};
  return String(shared.policyVersion || settings().privacyPolicyVersion || CONSENT_VERSION);
}

function isValidPhone(value) {
  return /^[0-9+\-\s()]{6,20}$/.test(String(value || '').trim());
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function findMemberByContact(phone, email) {
  const wantPhone = normalizePhone(phone);
  const wantEmail = String(email || '').trim().toLowerCase();
  if (!wantPhone && !wantEmail) return null;
  return coll('loyaltyMembers').find((m) => {
    if (wantPhone && normalizePhone(m.phone) === wantPhone) return true;
    if (wantEmail && m.email && String(m.email).trim().toLowerCase() === wantEmail) return true;
    return false;
  }) || null;
}

// Consent is recorded rather than inferred, and only for the purposes the
// customer actually agreed to. A declined marketing purpose is stored as an
// explicit "no" so the shop can prove it was never contacted on that basis.
function consentRecord(body = {}, req) {
  const marketing = body.consentMarketing === true;
  const loyalty = body.consentLoyalty === true;
  // Serving an account the customer already has is not optional, so it is
  // recorded as a purpose in its own right rather than being folded into
  // loyalty consent the customer never gave.
  const purposes = ['service'];
  if (loyalty) purposes.push('loyalty');
  if (marketing) purposes.push('marketing');
  return {
    granted: true,
    purposes,
    purposeLabels: purposes.map((key) => PURPOSES[key]),
    version: policyVersion(),
    // When and how it was given, so consent can be evidenced later.
    capturedAt: now(),
    capturedBy: req && req.user ? { id: req.user.id, username: req.user.username } : null,
    source: 'loyalty_signup',
    withdrawnAt: null,
  };
}

function attachConsent(member, body, req) {
  // Nothing identifying means there is no personal data here, so no consent to
  // record. Keeping the field null makes that visible rather than implying a
  // conversation that never happened.
  if (!member.phone && !member.email) {
    member.consent = null;
    member.consentAt = null;
    member.consentVersion = null;
    member.dataRetentionUntil = null;
    return member;
  }
  member.consent = consentRecord(body, req);
  // Kept flat as well, because a reviewer looking at one record should not have
  // to know the shape of the nested object.
  member.consentAt = member.consent.capturedAt;
  member.consentVersion = member.consent.version;
  member.dataRetentionUntil = retentionDays() > 0
    ? new Date(Date.now() + retentionDays() * 86400000).toISOString()
    : null;
  return member;
}

function hasValidConsent(member, purpose = 'loyalty') {
  if (!member || !member.consent) return false;
  if (member.consent.withdrawnAt) return false;
  return (member.consent.purposes || []).includes(purpose);
}

// Right of access and data portability: everything held about one customer, in
// a form the customer can keep.
function exportMember(member) {
  const ledger = coll('loyaltyLedger').filter((entry) => Number(entry.memberId) === Number(member.id));
  const orders = coll('orders').filter((order) => order.customerId && Number(order.customerId) === Number(member.id));
  return {
    exportedAt: now(),
    policyVersion: policyVersion(),
    controller: {
      legalName: settings().legalName || settings().restaurantName || '',
      contactEmail: settings().privacyContactEmail || '',
    },
    subject: {
      id: member.id,
      name: member.name,
      phone: member.phone || null,
      email: member.email || null,
      tier: member.tier,
      points: member.points,
      createdAt: member.createdAt,
    },
    consent: member.consent || null,
    loyaltyHistory: ledger,
    orders: orders.map((order) => ({
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      total: order.total,
      paymentStatus: order.paymentStatus,
    })),
  };
}

// Right to erasure. Personal fields go; the ledger rows are kept as anonymous
// numbers because financial records have to be retained, and a loyalty balance
// cannot be kept once the identity behind it is gone.
function eraseMember(member) {
  const id = Number(member.id);
  const removed = { member: false, ledger: 0, redeemedBy: 0 };

  transaction(() => {
    const members = coll('loyaltyMembers');
    const index = members.findIndex((m) => Number(m.id) === id);
    if (index >= 0) {
      members.splice(index, 1);
      removed.member = true;
    }
    // Loyalty history is kept for accounting, detached from the person.
    for (const entry of coll('loyaltyLedger')) {
      if (Number(entry.memberId) === id) {
        entry.memberId = null;
        entry.subject = 'erased';
        removed.ledger += 1;
      }
    }
    // Anything the member redeemed on someone else's behalf loses the link too.
    for (const order of coll('orders')) {
      if (order.customerId && Number(order.customerId) === id) {
        order.customerId = null;
        removed.redeemedBy += 1;
      }
    }
  });

  return removed;
}

function withdrawConsent(member, purpose = null) {
  transaction(() => {
    const live = coll('loyaltyMembers').find((m) => Number(m.id) === Number(member.id));
    if (!live) return;
    live.consent = live.consent || { purposes: [], purposeLabels: [], version: policyVersion(), capturedAt: now() };
    live.consent.withdrawnAt = now();
    if (purpose && (live.consent.purposes || []).includes(purpose)) {
      live.consent.purposes = live.consent.purposes.filter((p) => p !== purpose);
      live.consent.purposeLabels = (live.consent.purposeLabels || []).filter((l) => l !== PURPOSES[purpose]);
    }
    live.consentWithdrawnAt = now();
  });
  return coll('loyaltyMembers').find((m) => Number(m.id) === Number(member.id));
}

// Retention. Anything past its retention date, or whose consent was withdrawn
// and not re-granted, is removed. Pinned records are kept, for example a
// member with an open balance, so an accidental purge cannot destroy a debt.
function purgeExpired(nowMs = Date.now()) {
  const days = retentionDays();
  const cutoff = days > 0 ? nowMs - days * 86400000 : null;
  const purge = [];

  for (const member of coll('loyaltyMembers')) {
    if (member.pinned === true) continue;
    const withdrawn = member.consentWithdrawnAt ? new Date(member.consentWithdrawnAt).getTime() : null;
    const created = member.createdAt ? new Date(member.createdAt).getTime() : null;
    const expired = cutoff !== null && created !== null && created < cutoff;
    // Consent given, then withdrawn, with nothing to settle: the record goes.
    const withdrawnExpired = withdrawn !== null && (nowMs - withdrawn) > 30 * 86400000 && Number(member.points || 0) === 0;
    const noConsent = !member.consentAt && cutoff !== null && created !== null && created < cutoff;
    if (expired || withdrawnExpired || noConsent) purge.push(member);
  }

  if (!purge.length) return { purged: 0, ids: [] };

  transaction(() => {
    for (const member of purge) eraseMember(member);
  });

  return { purged: purge.length, ids: purge.map((m) => m.id) };
}

module.exports = {
  CONSENT_VERSION,
  PURPOSES,
  retentionDays,
  policyVersion,
  isValidPhone,
  normalizePhone,
  findMemberByContact,
  consentRecord,
  attachConsent,
  hasValidConsent,
  exportMember,
  eraseMember,
  withdrawConsent,
  purgeExpired,
};
