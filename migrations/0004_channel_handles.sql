-- YouTube channel handles are used only for explicit @handle references in
-- descriptions. Keeping them separately avoids mistaking ordinary credits for
-- guest appearances.
CREATE TABLE IF NOT EXISTS channel_handles (
  channel_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_handles_handle ON channel_handles(handle);
