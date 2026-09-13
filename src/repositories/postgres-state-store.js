import pg from 'pg';
import { env, requireEnv } from '../config/env.js';

export const StateKey = Object.freeze({
  UI_LIVE: 'ui_live',
  UI_UPCOMING: 'ui_upcoming',
  UI_ENDED: 'ui_ended',
  ALL_LIVE: 'all_live',
  ALL_UPCOMING: 'all_upcoming',
  ALL_ENDED: 'all_ended',
  NOTIFICATION_HISTORY: 'notification_history',
  IMMINENT_NOTIFICATION_HISTORY: 'imminent_notification_history',
  PROCESSED_RSS_IDS: 'processed_rss_ids',
  LAST_MONITOR_RUN: 'last_monitor_run',
  LAST_YOUTUBE_SCAN: 'last_youtube_scan',
  UI_ERROR: 'ui_error'
});

export function createPostgresStateStore({ databaseUrl = env.databaseUrl, pool } = {}) {
  if (!pool) {
    if (!databaseUrl) requireEnv('DATABASE_URL');
    pool = new pg.Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false } });
  }

  return Object.freeze({
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_state (
          state_key TEXT PRIMARY KEY,
          state_value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS job_locks (
          lock_name TEXT PRIMARY KEY,
          locked_until TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    },

    async get(key, fallback = null) {
      const { rows } = await pool.query('SELECT state_value FROM app_state WHERE state_key = $1', [key]);
      return rows.length ? rows[0].state_value : fallback;
    },

    async set(key, value) {
      await pool.query(`
        INSERT INTO app_state (state_key, state_value) VALUES ($1, $2::jsonb)
        ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()
      `, [key, JSON.stringify(value)]);
    },

    async setMany(entries) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [key, value] of Object.entries(entries)) {
          await client.query(`
            INSERT INTO app_state (state_key, state_value) VALUES ($1, $2::jsonb)
            ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()
          `, [key, JSON.stringify(value)]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async delete(key) {
      await pool.query('DELETE FROM app_state WHERE state_key = $1', [key]);
    },

    async acquireLock(name, durationMs) {
      const { rows } = await pool.query(`
        INSERT INTO job_locks (lock_name, locked_until) VALUES ($1, NOW() + ($2 * INTERVAL '1 millisecond'))
        ON CONFLICT (lock_name) DO UPDATE SET locked_until = EXCLUDED.locked_until, updated_at = NOW()
        WHERE job_locks.locked_until < NOW()
        RETURNING lock_name
      `, [name, durationMs]);
      return rows.length === 1;
    },

    async releaseLock(name) {
      await pool.query('DELETE FROM job_locks WHERE lock_name = $1', [name]);
    },

    async close() {
      await pool.end();
    }
  });
}

