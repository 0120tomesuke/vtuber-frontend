-- Cache roster channel icons so title-detected guests render as portraits
-- without one Holodex lookup per detected name.
CREATE TABLE IF NOT EXISTS channel_icons (
  channel_id TEXT PRIMARY KEY,
  icon_url TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
