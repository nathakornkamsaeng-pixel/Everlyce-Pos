// Creating an extra shop, for the suites that need one.
//
// The hosted build created shops with the public registration form. This build
// has no such form: there is no signup, because there is nothing to sign up for.
// The admin endpoint is the way a shop gets created here, so that is what the
// suites use.
//
// It needs platform sign-in, which is why this takes the token rather than
// assuming one. Suites already have a platform admin from their bootstrap
// environment.
const assert = require('assert');

/**
 * Creates a second shop and returns it, activated.
 *
 * @param {object} opts
 * @param {Function} opts.call  the suite's request helper
 * @param {string} opts.token  a platform admin token
 * @param {object} opts.fields  name/slug, and optionally contact details
 * @returns {Promise<object>} the created store, as the API returns it
 */
async function createStore({ call, token, fields }) {
  const body = {
    name: fields.name || 'Extra Cafe',
    // Activated on creation, which is the only mode this build has. There is no
    // waiting state and no key to redeem, so a store that came back pending
    // would be a bug rather than a thing to assert on.
    activate: true,
    plan: 'enterprise',
  };
  if (fields.slug) body.slug = fields.slug;
  if (fields.contactName) body.contactName = fields.contactName;
  if (fields.contactEmail) body.contactEmail = fields.contactEmail;
  if (fields.contactPhone) body.contactPhone = fields.contactPhone;
  // The owner credentials have to be forwarded or the shop comes back with
  // nobody able to sign in to it, which is exactly the bug this helper exists to
  // make visible rather than hide.
  if (fields.username) body.username = fields.username;
  if (fields.password) body.password = fields.password;
  if (fields.ownerName) body.ownerName = fields.ownerName;

  const res = await call('POST', '/api/platform/stores', { body, token });
  assert.strictEqual(res.status, 201, `creating ${body.slug || body.name} should succeed, got ${res.status} ${res.text || ''}`);
  assert.strictEqual(res.data.store.status, 'active', `${body.slug || body.name} should be created live, not pending`);
  // The whole response, not just the store: the owner is on it, and a suite that
  // wants to prove the owner account was created needs to see it. The store is
  // also spread in at the top level so a caller can use it directly.
  return { ...res.data.store, ...res.data, store: res.data.store };
}

module.exports = { createStore };
