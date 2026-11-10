-- Admin API listings (docs/DESIGN.md, sections 6.4 and 7.1; docs/ADMIN-API.md).
-- Same rules as 0001: only hashes and refs, never raw identifiers or IPs; Unix milliseconds.

-- One row per successful POST /v1/admin/ban or /v1/admin/unban. Not purged by the cron: bans
-- never expire, so the record of who was banned or unbanned, and why, must not either. It grows
-- by one row per human action.
CREATE TABLE admin_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app         TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('ban', 'unban')),
  kind        TEXT CHECK (kind IN ('idfv', 'install', 'icloud', 'user', 'android_id')),
  hash        TEXT,
  ref         TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);

-- GET /v1/admin/log: newest first, keyset on (created_at, id). id is the rowid, so the index
-- already carries it.
CREATE INDEX admin_log_app_created_at ON admin_log (app, created_at);

-- GET /v1/admin/bans: newest first, keyset on (created_at, hash). banned_ids only had its
-- primary key (app, hash). Writes to banned_ids are rare (bans and propagation), so the extra
-- index costs little; check_log, written on every check, gets no new index.
CREATE INDEX banned_ids_app_created_at ON banned_ids (app, created_at, hash);
