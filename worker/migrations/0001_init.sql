-- Initial schema (docs/DESIGN.md, section 7.1). Only hashes with a per-app prefix:
-- never raw identifiers or IPs. Timestamps are Unix milliseconds.

CREATE TABLE banned_ids (
  app         TEXT NOT NULL,
  hash        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('idfv', 'install', 'icloud', 'user', 'android_id')),
  reason      TEXT NOT NULL CHECK (reason IN ('manual', 'propagated')),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (app, hash)
);

CREATE TABLE unban_refs (
  app         TEXT NOT NULL,
  ref         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (app, ref)
);

CREATE TABLE check_log (
  app         TEXT NOT NULL,
  ref         TEXT NOT NULL,
  blocked     INTEGER NOT NULL,
  matched     INTEGER NOT NULL,
  bit0        INTEGER,
  intent      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX check_log_app_ref ON check_log (app, ref, created_at);
CREATE INDEX check_log_created_at ON check_log (created_at);
