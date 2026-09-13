-- Cloudflare-native operational storage.  app_state remains only for small
-- cursors/housekeeping markers; video, notification, and metric history live here.
CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  youtube_url TEXT NOT NULL DEFAULT '',
  is_global INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_excluded INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS talent_aliases (
  source_name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_keywords (
  category TEXT NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (category, keyword)
);
CREATE TABLE IF NOT EXISTS exclude_words (
  keyword TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS videos (
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  channel_title TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  start_time TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming',
  is_special INTEGER NOT NULL DEFAULT 0,
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS videos_status_start ON videos(status, start_time DESC);
CREATE INDEX IF NOT EXISTS videos_channel_start ON videos(channel_id, start_time DESC);
CREATE TABLE IF NOT EXISTS video_states (
  scope TEXT NOT NULL,
  video_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, video_id),
  FOREIGN KEY (video_id) REFERENCES videos(video_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS video_states_scope_status ON video_states(scope, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS viewer_samples (
  video_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  viewers INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'holodex',
  PRIMARY KEY (video_id, observed_at),
  FOREIGN KEY (video_id) REFERENCES videos(video_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS viewer_samples_video_time ON viewer_samples(video_id, observed_at);
CREATE TABLE IF NOT EXISTS notification_state (
  video_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT,
  notification_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notification_log_created ON notification_log(created_at DESC);
CREATE TABLE IF NOT EXISTS monitor_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  run_type TEXT NOT NULL,
  rss_batch_start INTEGER,
  status TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS monitor_runs_started ON monitor_runs(started_at DESC);
CREATE TABLE IF NOT EXISTS rss_seen (
  video_id TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
