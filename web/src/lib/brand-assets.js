// Brand asset URLs.
//
// The logo files are served at stable, unversioned paths, so any cache in
// front of the app (a CDN edge, or a browser that kept the old copy) will keep
// handing out the previous mark. Appending a version means a rebrand is
// visible immediately instead of after a long max-age expires.
//
// Bump BRAND_VERSION whenever the artwork in web/public/brand changes.
const BRAND_VERSION = 2;

export const brandAsset = (file) => `/brand/${file}?v=${BRAND_VERSION}`;

export const BRAND_LOGO = brandAsset('logo.svg');
