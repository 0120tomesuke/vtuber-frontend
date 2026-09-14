-- Claim a normal notification before delivery.  Queue retries can otherwise
-- repeat a successfully sent mail when the worker stops before history saves.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_key TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX IF NOT EXISTS notification_deliveries_sent_at
  ON notification_deliveries(sent_at);
