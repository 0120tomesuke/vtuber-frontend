-- Cache the Holodex affiliation of non-roster stream hosts. This keeps
-- Holostars out without a hand-maintained exclusion list or repeated lookups.
CREATE TABLE IF NOT EXISTS external_channel_classifications (
  channel_id TEXT PRIMARY KEY,
  org TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  is_holostars INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL
);
