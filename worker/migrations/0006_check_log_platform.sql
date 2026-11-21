-- The platform of each check (docs/CHECK-API.md): 'android' when the request says
-- platform: "android", 'ios' for every other request (the Swift SDK sends "ios"). NULL on rows
-- from before this migration. The code that writes it needs this migration applied first.

ALTER TABLE check_log ADD COLUMN platform TEXT CHECK (platform IN ('ios', 'android'));
