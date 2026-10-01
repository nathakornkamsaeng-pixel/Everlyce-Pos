// The version appended to brand asset URLs, so a rebrand is not served from a
// long-lived cache. It must match BRAND_VERSION in web/src/lib/brand-assets.js;
// stat.test.js fails if the two ever drift apart.
//
// Bump both when the artwork in web/public/brand changes.
const BRAND_VERSION = 2;

module.exports = { BRAND_VERSION };
