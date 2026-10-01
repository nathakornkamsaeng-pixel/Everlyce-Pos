# Everlyce POS

A point of sale for restaurants and cafés that runs on a server you control. One
shop per install, your own web address, your data on your own disk, and no
account to create.

- **Shop URL** — your shop is the whole host, so sign-in is at `/login`
- **Main page** — what the software does, and how to install it
- **No sign-up** — you clone it, you run it, there is nothing to register for
- **No keys** — start the process and it is trading

Prefer someone else to run it? There is a hosted version at
[pos.everlyce.com](https://pos.everlyce.com). This repository is the
self-hosted build: one shop per install, run by you.

## Features

Point of sale, table management, QR ordering from the guest's phone, kitchen
display, PromptPay, customer display, loyalty, stock, discounts, reports, cash
sessions and receipts in Thai and English.

## Requirements

- Node.js 20 or newer
- nginx (or any reverse proxy) with TLS
- ~200 MB of disk for the app, plus your data

## Install

```bash
git clone https://github.com/nathakornkamsaeng-pixel/pos.git
cd pos
npm install
npm run build
```

## Configure the systemd service

```bash
sudo tee /etc/systemd/system/pos-api.service >/dev/null <<'EOF'
[Unit]
Description=Everlyce POS API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/pos/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=2
Environment=PORT=8080
Environment=POS_DATA_DIR=/opt/pos/server/data
Environment=NODE_ENV=production
Environment=POS_DEFAULT_STORE_SLUG=myrestaurant
Environment=POS_ALLOWED_HOSTS=pos.example.com,localhost,127.0.0.1
Environment=POS_CONTACT_EMAIL=you@example.com
# Single-store self-hosted mode: no registration, no activation keys.
Environment=POS_SELF_HOST=1

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now pos-api
```

### Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Port the API listens on. It binds to `127.0.0.1` only, so it must sit behind a proxy. |
| `POS_DATA_DIR` | `server/data` | Where `data.json` and the JWT secret live. Back this up. |
| `POS_DEFAULT_STORE_SLUG` | `myrestaurant` | Slug used when a fresh install creates its first store. |
| `POS_ALLOWED_HOSTS` | `pos.example.com,localhost,127.0.0.1` | Comma-separated `Host` allowlist. Requests with any other host get a `421`. |
| `POS_CONTACT_EMAIL` | `you@example.com` | Your own address, shown to your staff on screens that need a contact. |
| `POS_TOKEN_TTL` | `12h` | How long a sign-in lasts. |
| `POS_BOOTSTRAP_USERNAME` | `admin` | Username for the first admin created on first run. |
| `POS_BOOTSTRAP_PASSWORD` | random | Set it, or a random one is written to `data/bootstrap-admin.txt`. |
| `POS_CORS_ORIGIN` | *(empty)* | Leave empty unless you front the API from another origin. |
| `POS_SELF_HOST` | *(empty)* | Set to `1`. This is the only mode this build has. See below. |
| `POS_SMTP_HOST` | *(empty)* | *(hosted builds only)* Outgoing mail server. Unused in this build. |

## Single-store self-hosted mode

Set `POS_SELF_HOST=1` and the install runs as exactly one shop:

- **Online registration is off.** There is no signup, because there is nothing to
  sign up *for*: the install is already yours.
- **No activation keys.** The shop you set up is trading the moment you set it
  up.
- **The platform console is switched off.** It could list one shop, mint keys
  nobody would redeem, read every contact field, and delete the only shop on the
  install. Under the flag it answers `404` on everything except two read-only
  public endpoints the front page needs.
- **A second shop is refused**, because the mode is deliberately one shop.

Branches still work, so one shop running several locations is fine.

The flag is read once at startup, so changing it needs a restart. This build
expects it on; with it off you get the multi-store code paths, which are not what
this repository is for.

## Addresses

The shop is at the **root of the host**, not under a name of its own:

```
https://pos.example.com/login          staff sign in
https://pos.example.com/orders         the till
https://pos.example.com/               the front page, and set up on a fresh install
```

There is no shop name in the URL, because there is only one shop and the name
distinguished nothing. The server publishes that shop's address in
`/api/platform/config` and the app asks rather than carrying its own copy.

QR codes and bookmarks that carry the old name still work, at
`/{shop-name}/...`. The prefix is not required anywhere new.

## First run

Start the server, open the page, and name your shop. That form is the whole
setup: it creates the shop, creates the owner account, and marks it active in one
request. There is no email to confirm and no key to enter.

```bash
npm start
# then open the printed URL and use the Set up tab
```

If you prefer to have the account created for you at boot instead, set
`POS_BOOTSTRAP_USERNAME` and `POS_BOOTSTRAP_PASSWORD` before the first start and
a random password is written to `$POS_DATA_DIR/bootstrap-admin.txt` when you do
not. That file is written `0600`: read it, change the password, delete it.

The setup form is only offered while the install has no shop. Once one exists the
endpoint refuses, so it cannot be used to add a second shop to a single-shop
install.

## nginx

```nginx
server {
    server_name pos.example.com;

    client_max_body_size 3m;
    limit_conn pos_conn 40;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" always;

    # Rate limits: sign-in, public ordering, and the public sign-up endpoints.
    location = /api/auth/login {
        limit_req zone=pos_login burst=5 nodelay;
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # The setup endpoint is one-shot by design and refuses once a shop exists,
    # so it is the one to rate limit hardest.
    location = /api/platform/setup    { limit_req zone=pos_onboard burst=3 nodelay; proxy_pass http://127.0.0.1:8080; }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120;
    }

    listen 443 ssl;
    ssl_certificate     /etc/letsencrypt/live/pos.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pos.example.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
}
```

Define the rate-limit zones in `/etc/nginx/conf.d/pos-security.conf`:

```nginx
limit_req_zone $binary_remote_addr zone=pos_login:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=pos_public:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=pos_onboard:10m rate=5r/m;
limit_conn_zone $binary_remote_addr zone=pos_conn:10m;
```

## Branches

A store can run more than one location. Each branch has its own tables, orders,
cash drawer and reports, while the menu, staff and discounts are shared across
the store.

Every store starts with a default **Main** branch, created automatically, and
an existing install is attached to it on upgrade, so nothing is orphaned. Pick
a branch from the switcher in the app header; it is remembered per store. With
only one branch the switcher is hidden.

A branch cannot be deleted while it still has tables, or has orders in its
history, because that would silently take the data with it. Deactivate it
instead, or move the tables first.

From the API, the active branch travels on `X-POS-Branch`, and `?branchId=<id>`
filters a list. `branchId=all` covers every branch, which is the default.

## Security

- Every JWT is bound to the store it was issued for, so a valid token from one
  shop is rejected by another.
- Staff and platform tokens are separate audiences; neither opens the other's
  API.
- API keys are hashed, single use, expiring and compared in constant time.
- Sign-in locks per account *and* IP, with backoff up to 24 hours.
- The API binds to `127.0.0.1`, checks the `Host` header, and is meant to sit
  behind a proxy.
- Browser tokens live in `sessionStorage`, not `localStorage`.
- New passwords must be 12 characters or longer; admin accounts cannot use a
  PIN alone.

## Tests

```bash
npm test          # every server suite, then the web suites
npm run test:server
```

No environment variables are needed. Each suite provisions its own throwaway
data directory under the system temp dir, seeds it from
`server/example-data/data.json`, and removes it on exit. The suites boot the
real server and set up a shop, take orders and move money, so
`server/test/helpers/isolated-data.js` refuses to run if it is ever pointed at
the live `server/data` directory.

`multistore.test.js` covers registration, sign-in before activation, key
issuance, activation, store creation and deletion, isolation between stores,
suspension and restart persistence. `security-multistore.test.js` covers
lockout, token revocation, secret redaction and header handling.
`branches.test.js` covers branch CRUD, permissions, table and order branch
tagging, per-branch reporting and restart persistence. `selfhost.test.js`
covers single-store mode, including that hosted behaviour returns when the flag
is off. `pdpa.test.js` covers consent, export, withdrawal, erasure, retention
and audit history. `stat.test.js` covers the health report and its auth.
`apikeys.test.js` covers the integration API, key scopes, cross-store
isolation and revocation. `urlsafety.test.js` covers external URL validation
and the in-process sign-in caps. `storage.test.js` is the storage-engine
conformance suite, `checkout.test.js` unit-tests the money rules with no server
at all, and `postgres.test.js` runs against a real PostgreSQL
(`npm run test:postgres`; `npm run test:all` runs everything).

## Privacy

Two owners, because the notice has two things in it.

| | owner | why |
| --- | --- | --- |
| the wording: title, sections, rights, security, breach note | platform, at `/platform` | the same document for every shop, and a customer is entitled to read it |
| **the controller: legal name, privacy email, postal address** | **the site owner, at `/platform`** | they operate the service that collects the data, so they are the controller |
| tax ID, retention days | the shop, in its own settings | the shop's own facts for its own tax invoice and its own housekeeping |
| the shop's legal name | the shop | still used for a valid tax invoice, but it no longer dect**: given or refused, when, against which policy
  version, and what was agreed to. Kept because "did they agree, and to what"
  cannot be answered from a cookie that has expired.
- **The version matters.** Changing the wording without bumping
  `consentVersion` would mean people had agreed to something they never saw, so
  bumping it re-asks everyone.
- **Withdrawal is as easy as agreement.** Withdrawn records stop counting, and a
  refusal is a standing decision that revoking a grant does not undo.
- **No raw addresses.** A consent record has to be attributable to be worth
  keeping, but the address is salted and hashed and the user agent truncated. The
  hash covers the *whole* address: truncating it to look more anonymous lumps
  everyone behind one router into one person, so the first to agree would mark all
  of them agreed.

`GET /api/platform/consent/history` reads the lot. Read only on purpose: a consent
record that can be edited is not evidence of consent.

What the app does use, stated plainly on the privacy notice and in the home page
footer: a session token in `sessionStorage`, cleared when the tab closes, and four
preferences in `localStorage` — language, last store, last branch, and the
language the privacy notice was last read in. No customer data, nothing leaves
the device, no third-party analytics.

The privacy notice was also published by every shop and **linked from nowhere on
the home page**, so a visitor had to know to guess the URL. It is linked in the
footer now, along with the storage position.

Every string on the page is editable in both languages from `/platform`, grouped
by page, with a count of anything still missing its Thai and a reset back to the
wording that ships with the software. Missing or emptied edits fall back to the
built-in copy rather than rendering a blank in a legal document.

The consent version recorded against a customer comes from the platform, because a
record saying 1.0 against a notice saying 2.0 is exactly the record that cannot
settle a complaint.

## Printers and payment methods

Both per shop. Two shops on one install have different machines behind the counter
and take payment in different ways, and neither can see or change the other's.

### Printers

`/printers` in the shop's admin. Pick one of the eleven supported models or bring
your own, name it, say where it is and what it is for.

- The first receipt printer becomes the default by itself, and only one is the
  default per job. Removing one hands the job on rather than leaving orders with
  nowhere to go.
- A network printer with no address is refused with a message saying what is
  missing, because the commonest support call is a printer that silently does
  nothing for want of an IP.
- A test print is real ESC/POS bytes through the driver, so paper width is
  checked before a real order rather than during one.
- Where a shop has no printer for a job, the page says so **per job**. A shop
  about to promise the kitchen display with no kitchen printer is invisible from
  the till otherwise.

Every profile is shown as **not yet checked**, because none has been measured
against a physical unit. Paper width and columns are solid. The code page that
means Thai is firmware dependent and is left unset on purpose: a wrong guess
prints mojibake, and a confident wrong answer is worse than no answer.

### Payment methods

`Settings → Payment methods`. The shop's own list, in the order its staff meet
it, and a shop can add its own.

Each method says whether it settles **immediately** or **waits for confirmation**.
That is the distinction that matters and is easy to get wrong: immediate means
the till treats the money as in the drawer and a cashier can void the order;
deferred means it cannot be voided at the till at all. Getting it the wrong way
round lets a cashier take money for a payment that never arrived. The page warns
when a shop has chosen a deferred method.

Cash cannot be removed. It is not a setting, it is what a till is.

## Taking payments

`server/src/payments/` holds the payment providers behind one interface, so the
till asks what a shop can accept and never has to know which provider answered.

| Provider | Works today | Needs |
| --- | --- | --- |
| `cash` | yes | nothing |
| `thaiqr` | yes | a Thai bank account, PromptPay number, tax ID or billing ID |
| `opn` | configured only | an Opn merchant account and live keys |
| `stripe` | configured only | a Stripe account and live keys |

**Thai QR is the one that matters most.** Every Thai banking app already reads
it, so a shop can take money with the account it has today, with no contract and
no API key. The payload is built in `payments/thaiqr.js` as EMVCo TLV with a
CRC-16/CCITT checksum, and it carries:

| Tag | |
| --- | --- |
| `00` | payload format |
| `01` | `12` dynamic, one QR per order |
| `29` | PromptPay account, as a phone number, tax ID or billing ID |
| `53` `54` `58` | Thai baht, the amount, Thailand |
| `59` `60` | merchant name and city, so the payer's screen says something recognisable |
| `62` | **the reference** |

Tag `62` is the field the previous inline builder left out entirely. Without it a
payment arrives with nothing on the payer's statement to match against the
shop's bank feed, and every reconciliation becomes a manual guess on amount and
timestamp. The reference is derived from the order number on the server, so a
client cannot put an arbitrary value into a payment of its own.

Card gateways are present but **not switched on**. A gateway that claims to be
ready without live credentials fails at the counter, which is the worst moment
to discover it, so `capabilities()` reports them as unavailable with the reason
attached until real keys are configured, and charging through one refuses rather
than quietly falling back to cash.

Gateway credentials are never returned by any endpoint. They are replaced with a
`*Configured` boolean on the way out, for admins as well as cashiers: an admin
has just typed the value, which makes them the person least safe to hand a copy
of it, and the only question anyone needs answered is whether a key is set.

`GET /api/payments/capabilities` returns the list, so the till can show a real
answer instead of a method that turns out to be unconfigured once the customer
has their card out.

### Running the PostgreSQL suite

It creates and drops roles to prove RLS cannot be bypassed, so it needs a
superuser connection rather than the application role:

```sh
sudo -u postgres psql -qc "CREATE DATABASE everlyce_test OWNER postgres"
TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/everlyce_test' npm run test:postgres
```

It cleans up after itself on a passing run. The database should not be the
production one.

## PostgreSQL

`server/src/storage/schema.sql` is the relational schema: 16 tables, 47 indexes,
13 row level security policies. It is the target engine, chosen over a file store
because the file engine has one writer and its write cost grows with the size of
the install.

Three decisions that are expensive to change later:

- **Ids are the existing integers**, not generated sequences, so migration maps
  every foreign key directly and a rollback still resolves.
- **Money is `numeric(12,2)`**, never float. JavaScript cannot represent
  `0.1 + 0.2`, which on a till is a real dispute. Each column therefore has a
  stated ceiling, and a total past it is refused rather than truncated.
- **Every tenant table carries `store_id` with RLS on it.** The application
  already scopes reads by store; RLS means a query that forgets the `WHERE`
  returns nothing rather than another shop's orders. The safety net lives in the
  database, not only in the code. Policies are enabled but not `FORCE`d yet, so
  turning the net fully on is a deliberate switch.

`postgres.test.js` asserts the properties a single-writer file engine could not
enforce, all against a live database: ten concurrent drawer opens where exactly
one succeeds, six concurrent retries of one payment where one row survives, no
payment without an order, no line outliving its order, exact decimals, and a
query that forgets its store filter returning nothing. Run it with:

```bash
createdb everlyce_test
TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/everlyce_test npm run test:postgres
```

## Printing

`server/src/printing/escpos.js` speaks ESC/POS as bytes. This is the whole
reason a large supported-model count is a data problem rather than an
engineering one: ESC/POS is a de facto standard, so there is **one driver**
parameterised by what a device can do, and the `printer_profiles` table decides
those parameters rather than selecting code paths.

`escpos.test.js` asserts the exact bytes, because a printer is not available in
CI and the only way to be sure a ticket is right is to check the wire format.
Expectations are written from the manual rather than recorded from the code, so
a change that alters the output fails instead of passing quietly.

Three things that are deliberately *not* constants in the driver:

- **The code page.** Which `ESC t` number means Thai is firmware dependent, so
  it is a profile setting. Hardcoding it would be right for one manufacturer and
  print mojibake everywhere else.
- **Capability flags.** A printer with no cutter is fed paper instead of sent
  `GS V`, one with no drawer is not sent `ESC p`, one that cannot do images is
  sent no raster data.
- **An unknown model still prints.** `genericProfile()` is the fallback, and
  every real profile refines it rather than replacing it, so a model nobody has
  catalogued works at sensible defaults instead of being refused.

### Supported models

`server/src/printing/profiles.js` seeds the first eleven, as rows: five Epson
(TM-T88VII, TM-T88VI, TM-T20II, TM-T82III, TM-T88III), Star TSP143III,
Bixolon SRP-Q300, Citizen CT-S310, Rongta RP80A, and two Xprinter (XP-N160II,
XP-Q200). The last is 58mm, so the narrower 32-column path is exercised rather
than assumed.

Every seeded row carries `quirks.verified: false` and where the claim came from.
That is deliberate: the model names and the 80/58mm split are solid, and the
column counts follow the usual 48/32 at 203dpi, but nobody has measured these
against physical units yet. A row is a claim someone can check and correct,
which is the point of storing it as data.

**No profile claims a Thai code page number.** Which `ESC t` value means Thai
is firmware dependent, so guessing one would print mojibake on most of these.
They fall back to the driver default instead.

`profiles.test.js` renders a full receipt through every seeded profile and
asserts no line exceeds that printer's column count, plus the drawer pulse and
the cut. A wrong `columns` value would otherwise silently print a receipt
running off the paper.

Printing is deliberately **not** in the integration API. A store's API key
carries `catalog:read`, `orders:read` and `orders:write`; a partner pushing
orders has no business kicking a cash drawer or reprinting a receipt, so there
is no scope that reaches printing.

Thai is wrapped on a character budget, not on spaces, because Thai has no spaces
between words. Only eleven code points in the Thai block are non-spacing marks;
treating the whole block as combining makes every character measure zero, so
nothing ever wraps and long names run off the paper.

## The status page

`/api/stat/health` answers two audiences from one endpoint, by content
negotiation:

- A browser (`Accept: text/html`) gets a self-contained status page: the
  verdict, uptime, response time, runtime, memory, integrity, what the system
  does, and its security posture. No external font, image or script, and no
  dependency on the app bundle, so it still renders if the bundle is what is
  broken.
- Anything else gets the small JSON it has always got, unchanged, so uptime
  monitors and status pings need no change.

The page is built to be screenshotted and sent to people, so it ca.." -H 'Content-Type: application/json' \
  -d '{"orderType":"delivery","items":[{"productId":12,"quantity":2}]}'
```

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/api/v1/catalog` | `catalog:read` |
| GET | `/api/v1/orders` | `orders:read` |
| GET | `/api/v1/orders/:id` | `orders:read` |
| POST | `/api/v1/orders` | `orders:write` |

Scopes are enforced per key, so a read-only key cannot create an order. A key
carries its store id, and its hash is only ever compared inside that store's own
bucket, so **a key for one shop cannot read another shop** — sending a different
`X-POS-Store` header changes nothing. Keys are rate limited per key, every issue
and revocation is written to the activity log, and revoking one takes effect on
the integration's next request rather than waiting for a session to expire.

Order prices come from the catalogue, not the payload, so a tampered request
cannot under-charge a sale.

## Public endpoints

Everything reachable without a sign-in, and what it deliberately does not say:

| Endpoint | Says | Does not say |
| --- | --- | --- |
| `/api/health` | `ok` | store count |
| `/api/stat/health` | verdict, error and warning counts, uptime | store count, row count |
| `/api/platform/config` | the contact address shown on the page | anything else |
| `/api/public/privacy-notice` | the published privacy notice | any store data |
| `/api/public/*` | the customer menu and order feed | staff, settings, reports |

The counts behind the sign-in are on `/api/stat/report`. A public page that is
meant to be screenshotted and sent to people should not carry "1 store, 533
rows", which is reconnaissance and nothing else.

`apikeys.test.js` asserts each of these, and that the data routes all answer
401 without a session.

## Licence

GNU Affero General Public License v3.0 or later. The full text is in the `LICENSE` file at the root of the repository.
