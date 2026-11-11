-- The support code of the device that propagated each automatic ban (docs/DESIGN.md, section
-- 6.1). An unban by ref removes that device's automatic bans at once, instead of waiting for
-- its next check to send them. NULL on manual bans and on rows from before this migration.
-- Like the rest of banned_ids: a ref is a hash prefix, never a raw identifier.

ALTER TABLE banned_ids ADD COLUMN ref TEXT;

CREATE INDEX banned_ids_app_ref ON banned_ids (app, ref) WHERE ref IS NOT NULL;
