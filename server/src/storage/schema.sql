-- Everlyce POS on PostgreSQL.
--
-- Why this exists: the file engine rewrites the whole document on every write,
-- so it has one writer and grows with the size of the install. A shop doing
-- real trade needs many concurrent writers and a database that does not care
-- how big the data is.
--
-- Three decisions worth stating, because they are the ones that are expensive
-- to change later:
--
-- 1. Ids are plain integers carried over from the file engine, not generated
--    sequences. Migration can therefore map every foreign key directly, and a
--    rollback to the old engine still resolves. Sequences start at a high
--    offset later if a mixed fleet ever needs it.
--
-- 2. Money is numeric(12,2), never float. The file engine used JavaScript
--    numbers, which cannot represent 0.1 + 0.2. Every total here is rounded by
--    the database, so a rounding mistake cannot become a shortfall.
--
-- 3. Every tenant table carries store_id and has row level security on it. The
--    application already scopes reads by store; RLS means a query that forgets
--    the WHERE clause returns nothing rather than another shop's orders. The
--    safety net is in the database, not only in the code.

BEGIN;

CREATE TABLE IF NOT EXISTS stores (
  id            integer PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','awaiting_activation','active','suspended')),
  plan          text NOT NULL DEFAULT 'starter',
  plan_months   integer NOT NULL DEFAULT 0,
  key_hash      text,
  key_issued_at timestamptz,
  key_expires_at timestamptz,
  key_used_at   timestamptz,
  key_revoked_at timestamptz,
  contact_name  text,
  contact_email text,
  contact_phone text,
  note          text,
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  suspended_at  timestamptz,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS branches (
  id         integer PRIMARY KEY,
  store_id   integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Exactly one default branch per store, enforced rather than hoped for.
CREATE UNIQUE INDEX IF NOT EXISTS branches_one_default
  ON branches (store_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS branches_name_per_store ON branches (store_id, lower(name));

CREATE TABLE IF NOT EXISTS users (
  id            integer PRIMARY KEY,
  store_id      integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  username      text NOT NULL,
  name          text NOT NULL DEFAULT '',
  role          text NOT NULL CHECK (role IN ('admin','manager','cashier','kds','display')),
  password_hash text,
  pin_hash      text,
  cashier_id    integer,
  language      text NOT NULL DEFAULT 'th',
  active        boolean NOT NULL DEFAULT true,
  auth_version  integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Sign-in looks up by username inside a store, so this is the hot index. And a
-- duplicate username in one store makes sign-in ambiguous, which is exactly
-- what the integrity check hunts for; the database refuses it outright.
CREATE UNIQUE INDEX IF NOT EXISTS users_store_username ON users (store_id, lower(username));

CREATE TABLE IF NOT EXISTS categories (
  id         integer PRIMARY KEY,
  store_id   integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       jsonb NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS categories_store ON categories (store_id, sort_order);

CREATE TABLE IF NOT EXISTS products (
  id         integer PRIMARY KEY,
  store_id   integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category_id integer REFERENCES categories(id) ON DELETE SET NULL,
  name       jsonb NOT NULL,
  description jsonb NOT NULL DEFAULT '{}'::jsonb,
  price      numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  cost       numeric(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  image_url  text,
  available  boolean NOT NULL DEFAULT true,
  archived   boolean NOT NULL DEFAULT false,
  track_stock boolean NOT NULL DEFAULT false,
  stock_count numeric(12,3) NOT NULL DEFAULT 0,
  low_stock_threshold numeric(12,3) NOT NULL DEFAULT 5,
  allergens  text NOT NULL DEFAULT '',
  sku        text,
  barcode    text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The till loads the menu for one store, ordered, active only.
CREATE INDEX IF NOT EXISTS products_store_menu ON products (store_id, sort_order) WHERE NOT archived;
-- Scanning a barcode has to be fast and unique enough to settle payment.
CREATE INDEX IF NOT EXISTS products_barcode ON products (store_id, barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_sku ON products (store_id, sku) WHERE sku IS NOT NULL;

CREATE TABLE IF NOT EXISTS tables (
  id         integer PRIMARY KEY,
  store_id   integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id  integer REFERENCES branches(id) ON DELETE CASCADE,
  name       text NOT NULL,
  seats      integer,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS tables_store_branch ON tables (store_id, branch_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         integer PRIMARY KEY,
  store_id   integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id  integer REFERENCES branches(id) ON DELETE CASCADE,
  table_id   integer REFERENCES tables(id) ON DELETE SET NULL,
  token      text NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  total      numeric(12,2) NOT NULL DEFAULT 0,
  order_count integer NOT NULL DEFAULT 0,
  opened_at  timestamptz NOT NULL DEFAULT now(),
  opened_by  integer,
  closed_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token ON sessions (token);
-- The floor screen asks "what is open right now" for one branch.
CREATE INDEX IF NOT EXISTS sessions_open ON sessions (store_id, branch_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS orders (
  id           integer PRIMARY KEY,
  store_id     integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id    integer REFERENCES branches(id) ON DELETE SET NULL,
  table_id     integer REFERENCES tables(id) ON DELETE SET NULL,
  session_id   integer REFERENCES sessions(id) ON DELETE SET NULL,
  order_number text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','refunded','void')),
  payment_method text,
  order_type   text NOT NULL DEFAULT 'dine_in' CHECK (order_type IN ('dine_in','takeaway','delivery')),
  draft        boolean NOT NULL DEFAULT false,
  subtotal     numeric(12,2) NOT NULL DEFAULT 0,
  discount     numeric(12,2) NOT NULL DEFAULT 0,
  tax          numeric(12,2) NOT NULL DEFAULT 0,
  service_charge numeric(12,2) NOT NULL DEFAULT 0,
  tip          numeric(12,2) NOT NULL DEFAULT 0,
  total        numeric(12,2) NOT NULL DEFAULT 0,
  notes        text NOT NULL DEFAULT '',
  customer_name text,
  member_id    integer,
  points_used  integer NOT NULL DEFAULT 0,
  points_discount numeric(12,2) NOT NULL DEFAULT 0,
  promptpay_request_id integer,
  receipt_token text,
  receipt_expires_at timestamptz,
  receipt_qr_until timestamptz,
  source       text,
  created_by   integer,
  paid_by      integer,
  prep_ms      integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  paid_at      timestamptz,
  completed_at timestamptz
);
-- The till and the KDS both list live orders, newest first, per branch.
CREATE INDEX IF NOT EXISTS orders_live ON orders (store_id, branch_id, created_at DESC)
  WHERE payment_status = 'pending' AND NOT draft;
CREATE INDEX IF NOT EXISTS orders_number ON orders (store_id, order_number);
CREATE UNIQUE INDEX IF NOT EXISTS orders_receipt_token ON orders (receipt_token) WHERE receipt_token IS NOT NULL;
-- Reporting walks a date range. Without this it is a sequential scan over every
-- order the shop has ever taken.
CREATE INDEX IF NOT EXISTS orders_created ON orders (store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id            integer PRIMARY KEY,
  store_id      integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id      integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    integer REFERENCES products(id) ON DELETE SET NULL,
  product_name  text NOT NULL,
  quantity      numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price    numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  notes         text NOT NULL DEFAULT '',
  modifiers     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'pending',
  refunded      boolean NOT NULL DEFAULT false,
  refunded_quantity numeric(12,3) NOT NULL DEFAULT 0,
  stock_reserved boolean NOT NULL DEFAULT false,
  stock_consumed  boolean NOT NULL DEFAULT false,
  branch_id     integer REFERENCES branches(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Every read of an order's lines goes through this, on the hot path.
CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_product ON order_items (store_id, product_id);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id             integer PRIMARY KEY,
  store_id       integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id      integer REFERENCES branches(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opening_amount numeric(12,2) NOT NULL DEFAULT 0,
  closing_amount numeric(12,2),
  expected_amount numeric(12,2),
  variance_amount numeric(12,2),
  opened_by      integer,
  opened_by_username text,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);
-- One open drawer per branch. The file engine checked this in application code,
-- which is only safe because Node is single threaded; the database holds it
-- under concurrency, which is the condition the migration creates.
CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open
  ON cash_sessions (store_id, branch_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS payments (
  id              integer PRIMARY KEY,
  store_id        integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id        integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- Methods are the registry's, not a fixed shortlist: 'qr' and 'transfer' are
  -- the same Thai QR money arriving two different ways, and a gateway will add
  -- more. provider records which one actually settled it.
  method          text NOT NULL CHECK (method IN ('cash','card','promptpay','qr','transfer','truemoney','other')),
  provider        text,
  amount          numeric(12,2) NOT NULL CHECK (amount >= 0),
  received        numeric(12,2) NOT NULL DEFAULT 0,
  change          numeric(12,2) NOT NULL DEFAULT 0,
  cash_session_id integer REFERENCES cash_sessions(id) ON DELETE SET NULL,
  idempotency_key text,
  reference       text,
  created_by      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz
);
-- The replay guard, enforced by the database. A retried checkout with the same
-- key can only ever match one row.
CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency
  ON payments (store_id, order_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS payments_session ON payments (cash_session_id) WHERE cash_session_id IS NOT NULL;

-- --------------------------------------------------------------- printing
--
-- A printer is a device. A printer_profile is a model, held as data: paper
-- width, code pages, cut, drawer, dots per inch. Supporting a new model is a
-- row, not a driver, which is what makes "hundreds of models" tractable.
CREATE TABLE IF NOT EXISTS printer_profiles (
  id            serial PRIMARY KEY,
  vendor        text NOT NULL,
  model         text NOT NULL,
  aliases       text[] NOT NULL DEFAULT '{}',
  protocol      text NOT NULL CHECK (protocol IN ('escpos-network','escpos-usb','escpos-bluetooth','raw-tcp','browser','cloud')),
  transport     text NOT NULL DEFAULT 'tcp',
  paper_width_mm integer NOT NULL DEFAULT 80 CHECK (paper_width_mm IN (58,80)),
  dpi           integer NOT NULL DEFAULT 203,
  columns       integer NOT NULL DEFAULT 48,
  code_pages    text[] NOT NULL DEFAULT ARRAY['CP874','CP437'],
  supports_cut  boolean NOT NULL DEFAULT true,
  supports_drawer boolean NOT NULL DEFAULT false,
  supports_image boolean NOT NULL DEFAULT true,
  supports_colour boolean NOT NULL DEFAULT false,
  max_char_width_px integer NOT NULL DEFAULT 512,
  quirks        jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (vendor, model)
);
CREATE INDEX IF NOT EXISTS printer_profiles_lookup ON printer_profiles (vendor, model);

CREATE TABLE IF NOT EXISTS printers (
  id           integer PRIMARY KEY,
  store_id     integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id    integer REFERENCES branches(id) ON DELETE CASCADE,
  profile_id   integer REFERENCES printer_profiles(id) ON DELETE SET NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'receipt'
               CHECK (kind IN ('receipt','kitchen','bar','label','other')),
  protocol     text NOT NULL DEFAULT 'escpos-network',
  address      text,
  vendor_id    text,
  product_id   text,
  cloud_id     text,
  is_default_receipt boolean NOT NULL DEFAULT false,
  is_default_kitchen boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  last_seen_at timestamptz,
  last_status  text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS printers_store ON printers (store_id, branch_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS printers_default_receipt
  ON printers (store_id, branch_id) WHERE is_default_receipt;
CREATE UNIQUE INDEX IF NOT EXISTS printers_default_kitchen
  ON printers (store_id, branch_id) WHERE is_default_kitchen;

CREATE TABLE IF NOT EXISTS print_jobs (
  id           bigserial PRIMARY KEY,
  store_id     integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id    integer REFERENCES branches(id) ON DELETE SET NULL,
  printer_id   integer REFERENCES printers(id) ON DELETE SET NULL,
  order_id     integer REFERENCES orders(id) ON DELETE SET NULL,
  kind         text NOT NULL DEFAULT 'receipt'
               CHECK (kind IN ('receipt','kitchen','label','reprint','test')),
  template     text NOT NULL DEFAULT 'receipt',
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','claimed','printing','done','failed','cancelled')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  claimed_by   text,
  claimed_at   timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  printed_at   timestamptz
);
-- How a printer agent claims work: the claim query is this index and nothing
-- else, so a deployment with thousands of printers and a deep queue stays flat.
CREATE INDEX IF NOT EXISTS print_jobs_claim ON print_jobs (printer_id, available_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS print_jobs_store_status ON print_jobs (store_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS print_jobs_order ON print_jobs (order_id) WHERE order_id IS NOT NULL;

-- --------------------------------------------------------------- scanning
--
-- Same shape as printers. A scanner_profile is a model held as data: what it
-- prefixes, what it terminates with, and which symbologies it emits. The
-- overwhelming majority of scanners are HID keyboard wedges, which need no
-- driver at all, only a profile.
CREATE TABLE IF NOT EXISTS scanner_profiles (
  id            serial PRIMARY KEY,
  vendor        text NOT NULL,
  model         text NOT NULL,
  aliases       text[] NOT NULL DEFAULT '{}',
  transport     text NOT NULL DEFAULT 'hid' CHECK (transport IN ('hid','serial','com','scale')),
  symbologies   text[] NOT NULL DEFAULT ARRAY['ean13','ean8','upca','code128','code39','qr','itf14'],
  prefix        text,
  suffix        text,
  terminator    text NOT NULL DEFAULT 'enter' CHECK (terminator IN ('enter','tab','none','cr')),
  keyboard_layout text NOT NULL DEFAULT 'en',
  emits_fnc1    boolean NOT NULL DEFAULT false,
  min_length    integer NOT NULL DEFAULT 4,
  max_length    integer NOT NULL DEFAULT 128,
  quirks        jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (vendor, model)
);

CREATE TABLE IF NOT EXISTS scanners (
  id          integer PRIMARY KEY,
  store_id    integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id   integer REFERENCES branches(id) ON DELETE CASCADE,
  profile_id  integer REFERENCES scanner_profiles(id) ON DELETE SET NULL,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'barcode' CHECK (kind IN ('barcode','scale')),
  transport   text NOT NULL DEFAULT 'hid',
  device_path text,
  station     text NOT NULL DEFAULT 'till',
  active      boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scanners_store ON scanners (store_id, branch_id);

-- ------------------------------------------------------------- row security
--
-- The application already scopes every read by store. These policies are the
-- backstop: a query that forgets the store filter returns nothing rather than
-- another shop's orders. They are deliberately NOT enabled with FORCE yet, so
-- the file engine keeps working until the SQL path is ready; enabling FORCE
-- ROW LEVEL SECURITY is the switch that turns the safety net on.
ALTER TABLE branches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE products     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE printers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_jobs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanners     ENABLE ROW LEVEL SECURITY;

-- A session variable the repository sets per request, the same way the
-- AsyncLocalStorage context works today.
CREATE OR REPLACE FUNCTION current_store_id() RETURNS integer
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.store_id', true), '')::integer
  $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches','users','categories','products','tables','sessions',
    'orders','order_items','cash_sessions','payments','printers','print_jobs','scanners'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (store_id = current_store_id()) WITH CHECK (store_id = current_store_id())',
      t || '_tenant', t);
  END LOOP;
END $$;

COMMIT;
