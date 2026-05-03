-- Slice 6: cookie-keyed session ownership.
-- Adds owner_id, the opaque identifier the session_owner cookie carries
-- (HMAC-signed). Session-scoped routes verify the inbound cookie's
-- decoded id matches this column. The repository requires ownerId on
-- every insert (typed `NewSession` interface), so no rows lack it in
-- practice; this column is NOT NULL to enforce that at the DB layer too.
ALTER TABLE `research_sessions` ADD `owner_id` text(40) NOT NULL;
