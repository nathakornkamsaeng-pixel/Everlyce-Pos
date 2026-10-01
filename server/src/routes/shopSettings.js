// A shop's printers, and the payment methods that shop accepts.
//
// Both per store. Two shops on one install have different machines behind the
// counter and take payment in different ways, and neither should be able to see
// or change the other's.

const express = require('express');
const { coll, nextId, now, transaction } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const printers = require('../printing/store');
const registry = require('../payments/registry');
const { ValidationError } = require('../catalog');
const { log, EVENTS } = require('../activityLog');

const router = express.Router();
router.use(requireAuth);

// ------------------------------------------------------------------ printers

/** What this shop can print to, and the models it can pick from. */
// --------------------------------------------------------- payment methods

// What every shop can take, whether or not it has set anything up. Cash is
// included because a till that cannot take cash is not a till.
const ALWAYS = [{ id: 'cash', label: 'Cash', kind: 'immediate', alwaysOn: true }];

// Methods that ship with the product, so a saved list can say which of them is
// the shop's own invention. Anything else in the list is.
const KNOWN = new Set(['cash', 'thaiqr', 'opn', 'stripe']);

// Offered when the shop has the credentials. Availability is decided by the
// provider registry, not by the shop asserting it, so a method cannot be shown
// as available when it would fail at the counter.
function availableMethods() {
  return registry.providers.map((p) => ({
    id: p.id,
    label: p.label,
    methods: p.methods,
    settledSynchronously: p.id === 'cash',
    display: p.id === 'thaiqr' ? 'qr' : p.id === 'cash' ? 'none' : 'gateway',
  }));
}

/**
 * The payment methods this shop takes.
 *
 * A shop's own list: what it has switched on, in the order its staff see, plus
 * any custom methods it has added itself. Custom methods are real and needed: a
 * Thai shop taking TrueMoney in cash, or a market stall on bank transfer, is not
 * covered by any built-in gateway.
 */
function shopMethods(settings) {
  const stored = settings && Array.isArray(settings.paymentMethods) ? settings.paymentMethods : [];
  const merged = new Map();
  for (const m of ALWAYS) merged.set(m.id, { ...m });
  for (const m of stored) {
    if (!m || typeof m !== 'object' || !m.id) continue;
    merged.set(String(m.id).slice(0, 24), {
      id: String(m.id).slice(0, 24),
      label: String(m.label || m.id).slice(0, 40),
      // Immediate means the till treats the money as in the drawer. Anything
      // else waits for a confirmation, which is the difference between a method
      // that can be voided by a cashier and one that cannot.
      kind: m.kind === 'immediate' ? 'immediate' : 'deferred',
      // Kept from what was saved. Hardcoding this to true labels every method
      // as the shop's own, including the built-in gateways, so the till cannot
      // tell a configured provider from an invented one.
      custom: m.custom === undefined ? !KNOWN.has(String(m.id).slice(0, 24)) : m.custom === true,
    });
  }
  return [...merged.values()];
}

router.get('/methods', requireRole('admin'), (req, res) => {
  const settings = coll('settings') || {};
  res.json({
    methods: shopMethods(settings),
    available: availableMethods(),
  });
});

/** Switch methods on and off, and add or remove this shop's own. */
router.put('/methods', requireRole('admin'), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!Array.isArray(body.methods)) throw new ValidationError('methods must be a list', 'invalid');
  const settings = coll('settings');
  const known = new Set([...ALWAYS.map((m) => m.id), ...registry.providers.map((p) => p.id)]);
  const out = [];
  for (const raw of body.methods.slice(0, 20)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim().slice(0, 24);
    if (!id) continue;
    // Cash cannot be removed: it is not a setting, it is what a till is.
    if (id === 'cash') { out.push({ id, label: 'Cash', kind: 'immediate' }); continue; }
    out.push({
      id,
      label: String(raw.label || id).slice(0, 40),
      kind: raw.kind === 'immediate' ? 'immediate' : 'deferred',
      // Known ids are the built-in providers and are not user-editable; anything
      // else is this shop's own method.
      custom: !known.has(id),
    });
  }
  settings.paymentMethods = out;
  require('../db').touch();
  log(EVENTS.SETTINGS_SAVE, req, { scope: 'paymentMethods', count: out.length });
  res.json({ methods: shopMethods(settings), available: availableMethods() });
});

module.exports = router;

// ---------------------------------------------------------- printer by id

router.get('/', (req, res) => {
  res.json(printers.summary());
});

router.post('/', requireRole('admin'), (req, res) => {
  const created = printers.add(req.body || {});
  log(EVENTS.SETTINGS_SAVE, req, { scope: 'printers', added: created.name, kind: created.kind });
  res.status(201).json({ printer: printers.dto(created), summary: printers.summary() });
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const updated = printers.update(req.params.id, req.body || {});
  res.json({ printer: printers.dto(updated), summary: printers.summary() });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  printers.remove(req.params.id);
  log(EVENTS.SETTINGS_SAVE, req, { scope: 'printers', removed: req.params.id });
  res.json({ ok: true, summary: printers.summary() });
});

/** Make this the printer for its job. One at a time, per kind. */
router.post('/:id/default', requireRole('admin'), (req, res) => {
  res.json({ printer: printers.dto(printers.setDefault(req.params.id)), summary: printers.summary() });
});

/** A test print, so a shop can check the paper width before a real order. */
router.post('/:id/test', requireRole('admin'), (req, res) => {
  const printer = printers.find(req.params.id);
  if (!printer) throw new printers.PrinterError('Printer not found', 'not_found', 404);
  // Built by the driver rather than a friendly string, so the test exercises the
  // real path: a shop finding out the paper is 58mm after taking an order is a
  // worse way to learn it.
  const E = require('../printing/escpos');
  const job = new E.EscposJob({
    columns: printer.columns,
    capabilities: E.caps({ paperWidthMm: printer.paperWidthMm }),
  });
  job.open();
  const rule = (label) => job.text(label).text('-'.repeat(printer.columns));
  job.align(E.ALIGN.CENTER).bold(true).size(2, 2).text('Everlyce POS').bold(false).size(1, 1);
  rule('');
  job.align(E.ALIGN.LEFT);
  rule(printer.name);
  rule(`Paper ${printer.paperWidthMm}mm, ${printer.columns} columns`);
  rule(printer.protocol);
  if (!printer.verified) rule('Profile not yet checked');
  job.feed(2);
  job.cut();
  const bytes = job.toBuffer();
  res.json({
    ok: true,
    // Base64 so a browser print agent can hand it straight to the printer.
    payload: Buffer.from(bytes).toString('base64'),
    columns: printer.columns,
    paperWidthMm: printer.paperWidthMm,
    note: 'Sent as ESC/POS bytes. A browser agent prints them through the print dialog.',
  });
});

