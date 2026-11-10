-- Admin devices: pairing and signed requests (docs/DEVICE-PAIRING.md, section 10).
-- Same rules as before: no raw identifiers or IPs; Unix milliseconds.

-- One row per `POST /v1/admin/pairings`. Only the SHA-256 of the secret is kept. The daily cron
-- deletes the expired ones (approved or not).
CREATE TABLE admin_pairings (
  id               TEXT PRIMARY KEY,
  secret_hash      TEXT NOT NULL,        -- hex SHA-256 of the secret (its base64url text)
  role             TEXT NOT NULL CHECK (role IN ('read', 'admin')),
  label            TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  claimed_at       INTEGER,
  device_id        TEXT,
  approved_at      INTEGER
);

-- A device that claimed a pairing (`pending`) and, once approved, signs its requests (`active`).
-- Revoked devices stay, with revoked_at, so the admin log can still name them.
CREATE TABLE admin_devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('ios', 'ipados', 'macos', 'other')),
  role          TEXT NOT NULL CHECK (role IN ('read', 'admin')),
  public_key    TEXT NOT NULL,           -- base64url, 65-byte uncompressed P-256 point
  status        TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);

-- One row per signed request, written only after its signature verifies; a primary key
-- conflict is a replay. Rows live ten minutes: each insert deletes that device's expired ones and
-- the daily cron deletes everyone's.
CREATE TABLE admin_nonces (
  device_id   TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
) WITHOUT ROWID;
CREATE INDEX admin_nonces_expires_at ON admin_nonces (expires_at);

-- admin_log gains `actor` and `device_id`, and the actions `pair` and `revoke`. SQLite cannot
-- change a CHECK in place, so the table is rebuilt: copy, drop, rename, recreate the index. The
-- ids are kept. `pair` and `revoke` concern the whole Worker, not one app, so for them `app` is
-- NULL and `device_id` names the device; older rows get a NULL actor.
CREATE TABLE admin_log_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app         TEXT,
  action      TEXT NOT NULL CHECK (action IN ('ban', 'unban', 'pair', 'revoke')),
  kind        TEXT CHECK (kind IN ('idfv', 'install', 'icloud', 'user', 'android_id')),
  hash        TEXT,
  ref         TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  device_id   TEXT,
  actor       TEXT CHECK (actor = 'token' OR actor LIKE 'device:%'),
  CHECK ((app IS NULL) = (action IN ('pair', 'revoke')))
);

INSERT INTO admin_log_new (id, app, action, kind, hash, ref, note, created_at)
  SELECT id, app, action, kind, hash, ref, note, created_at FROM admin_log;

DROP TABLE admin_log;
ALTER TABLE admin_log_new RENAME TO admin_log;

CREATE INDEX admin_log_app_created_at ON admin_log (app, created_at);
