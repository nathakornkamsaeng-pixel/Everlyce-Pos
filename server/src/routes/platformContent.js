// Editing the platform's own pages: the home page at `/` and the PDPA privacy
// notice.
//
// These are the platform's words, not the software's buttons and not a shop's
// menu. A visitor reads the home page before they know any shop exists, and a
// customer is entitled to read the notice whoever they gave data to. So both are
// written once, here.
//
// Not part of publicConfig(). The published text is public, but a draft being
// edited is not: a half-written privacy notice should not be readable by someone
// deciding whether to trust us.

const express = require('express');
const { requirePlatformAuth } = require('../middleware');
const content = require('../platformContent');

const router = express.Router();
router.use(requirePlatformAuth);

const SCOPES = new Set(content.scopes);

function send(scope) {
  const all = content.platformStrings();
  const wanted = scope && SCOPES.has(scope) ? scope : null;
  const entries = Object.values(all)
    .filter((e) => !wanted || e.scope === wanted)
    .map(({ scope: es, key, en, th, edited }) => ({ scope: es, key, en, th, edited }));
  return {
    entries,
    scopes: [...SCOPES],
    counts: {
      total: entries.length,
      // A string with no Thai is a gap on a page that is read in Thai, and the
      // privacy notice is one of them, so it is worth counting rather than
      // leaving the editor to look complete when it is not.
      missingThai: entries.filter((e) => !String(e.th || '').trim()).length,
      edited: entries.filter((e) => e.edited).length,
    },
  };
}

router.get('/', (req, res) => {
  res.json(send(req.query.scope));
});

router.put('/', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const scope = String(body.scope || '');
  if (!SCOPES.has(scope)) return res.status(400).json({ detail: 'Unknown scope' });
  const updates = body.entries;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ detail: 'entries must be an object of key to {en, th}' });
  }
  content.saveStrings(scope, updates);
  res.json(send(scope));
});

// Puts a scope back to the copy that ships with the software. Offered because
// an edited legal notice is a serious thing to have mistyped.
router.post('/reset', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const scope = String(body.scope || '');
  if (!SCOPES.has(scope)) return res.status(400).json({ detail: 'Unknown scope' });
  content.resetStrings(scope);
  res.json(send(scope));
});

// The public read, for the pages that render this copy. Unauthenticated because
// these pages are public: the home page is the front door and the privacy notice
// is owed to a customer who has never signed in.
router.get('/published/:lang', (req, res) => {
  const saved = content.platformStrings();
  const out = {};
  for (const entry of Object.values(saved)) {
    const text = req.params.lang === 'th' ? (entry.th || entry.en) : (entry.en || entry.th);
    if (text) out[entry.key] = text;
  }
  res.set('Cache-Control', 'no-store');
  res.json(out);
});

module.exports = router;