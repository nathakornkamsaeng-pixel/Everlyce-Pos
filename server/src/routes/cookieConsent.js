// Cookie consent, as an endpoint.
//
// Public, because a visitor who has not signed in is exactly who gets asked.
// The gate is enforced at the point of writing a cookie, not here: this reports
// whether consent is outstanding and records a decision.

const express = require('express');
const { log, EVENTS } = require('../activityLog');
const consent = require('../cookieConsent');

const router = express.Router();

/** Whether this visitor still has to agree, and to what. */
router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(consent.current(req));
});

/**
 * Record a decision.
 *
 * Kept, not just honoured: "did this person agree, when, and to which version"
 * is the question an audit or a complaint will ask, and it cannot be answered
 * from a cookie that has since expired.
 */
router.post('/', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = consent.record(req, { granted: body.granted === true, categories: body.categories });
  if (result.error) return res.status(result.error.status).json({ detail: result.error.detail });

  log(
    result.entry.granted ? EVENTS.CONSENT_GRANTED : EVENTS.CONSENT_REFUSED,
    { user: null },
    {
      scope: 'cookies',
      version: result.entry.version,
      categories: result.entry.categories,
      consentId: result.entry.id,
      ip: req.ip,
    },
  );

  res.status(201).json({
    ok: true,
    granted: result.entry.granted,
    version: result.entry.version,
    decidedAt: result.entry.decidedAt,
    status: consent.current(req),
  });
});

module.exports = router;