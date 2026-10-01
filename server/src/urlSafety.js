// Validation for anything a shop can point at an external address.
//
// The LINE link was hardened because it is rendered as a link. Product images
// are the same class of problem: they end up in an <img src> on the customer
// menu and in a QR payload, so a value like javascript:, a data: document or a
// tracking pixel from a host the shop never chose is all reachable from a
// menu an unauthenticated customer loads.
//
// Kept in one place so every caller gets the same rule, and so adding a new
// external field does not mean remembering to invent a validator for it.

// Hosts that are expected to serve user-supplied imagery, plus the shop's own
// uploads. Anything else is still allowed, because plenty of shops legitimately
// host a menu photo somewhere else, but it has to be plain https and it has to
// look like a URL rather than a payload.
const BLOCKED_SCHEMES = /^(javascript|data|vbscript|file|blob):/i;

function validateExternalUrl(value, { field = 'That link', allowRelative = true } = {}) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return { value: '' };

  // A site-relative path is the shop's own upload, so it is fine.
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    return allowRelative ? { value: raw } : { error: `${field} must be a full https:// address` };
  }

  if (BLOCKED_SCHEMES.test(raw)) {
    return { error: `${field} must be an https:// address` };
  }
  if (!/^https:\/\//i.test(raw)) {
    return { error: `${field} must start with https://` };
  }
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return { error: `${field} does not look like a valid URL` };
  }
  if (url.protocol !== 'https:') {
    return { error: `${field} must be an https:// address` };
  }
  // Credentials in a URL are a phishing trick and never legitimate here.
  if (url.username || url.password) {
    return { error: `${field} must not contain a username or password` };
  }
  return { value: url.toString() };
}

module.exports = { validateExternalUrl };
