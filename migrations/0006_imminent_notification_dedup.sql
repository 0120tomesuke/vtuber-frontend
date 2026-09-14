-- A durable, per-video send claim prevents Queue retries or delayed jobs from
-- delivering the same start notification more than once.
CREATE TABLE IF NOT EXISTS imminent_notifications (
  video_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX IF NOT EXISTS imminent_notifications_sent_at ON imminent_notifications(sent_at);
