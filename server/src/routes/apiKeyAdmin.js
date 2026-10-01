// Managing integration keys. Session-authenticated and admin-only, because this
// is where a key is minted. The keys themselves then work without any session,
// on /api/v1 only.

const express = require('express');
const { coll, touch, now } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const { issue, revoke, publicKey, SCOPES, SCOPE_IDS } = require('../apiKeys');
const { log, EVENTS } = require('../activityLog');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', (req, res) => {
  res.json({
    scopes: SCOPES,
    keys: (coll('apiKeys') || [])
      .slice()
      .sort((a, b) => b.id - a.id)
      .map(publicKey),
  });
});

// The key is in this response and nowhere else. There is no endpoint that can
// return it again, because only its hash was stored.
router.post('/', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  const unknown = scopes.filter((s) => !SCOPE_IDS.includes(s));
  if (unknown.length) {
    return res.status(400).json({ detail: `Unknown scope: ${unknown.join(', ')}` });
  }
  let issued;
  try {
    issued = issue({ storeId: req.store.id, label: body.label, scopes });
  } catch (e) {
    return res.status(e.status || 500).json({ detail: e.message });
  }
  log(EVENTS.API_KEY_ISSUED, req, { label: issued.record.label, scopes: issued.record.scopes.join(' ') });
  return res.status(201).json({ key: issued.key, record: publicKey(issued.record) });
});

router.delete('/:id', (req, res) => {
  const record = (coll('apiKeys') || []).find((k) => Number(k.id) === Number(req.params.id));
  if (!record) return res.status(404).json({ detail: 'Key not found' });
  if (record.revokedAt) return res.status(409).json({ detail: 'That key is already revoked' });
  // Mutate the live record then touch. A transaction() here would deep-clone
  // the state and swap it, which detaches the record fetched a line above, and
  // the clone would be persisted with the key still live.
  record.revokedAt = now();
  touch();
  log(EVENTS.API_KEY_REVOKED, req, { label: record.label });
  return res.json({ key: publicKey(record) });
});

module.exports = router;
