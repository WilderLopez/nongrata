-- Which users each device has carried (docs/DESIGN.md, section 6.5), for the apps that set
-- LINK_USERS_<APP>. A ban by `user` then reaches every device that user was seen on, whether or
-- not it still sends that user, and an admin can list a user's devices. One row per pair, written
-- by the check. Like the rest of the schema: hashes with the app's prefix, never raw identifiers.
-- The device's ref is the start of install_hash, so it is not stored.

CREATE TABLE user_links (
  app          TEXT NOT NULL,
  install_hash TEXT NOT NULL,
  user_hash    TEXT NOT NULL,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  PRIMARY KEY (app, install_hash, user_hash)
);

CREATE INDEX user_links_app_user ON user_links (app, user_hash, last_seen);
CREATE INDEX user_links_last_seen ON user_links (last_seen);
