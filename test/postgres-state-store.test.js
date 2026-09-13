import test from 'node:test';
import assert from 'node:assert/strict';
import { StateKey, createPostgresStateStore } from '../src/repositories/postgres-state-store.js';

test('state store writes and reads JSON values through its database boundary', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    return sql.includes('SELECT') ? { rows: [{ state_value: ['video'] }] } : { rows: [] };
  } };
  const store = createPostgresStateStore({ pool });
  await store.set(StateKey.UI_LIVE, [{ videoId: 'id' }]);
  assert.equal(calls[0].values[0], StateKey.UI_LIVE);
  assert.equal(calls[0].values[1], '[{"videoId":"id"}]');
  assert.deepEqual(await store.get(StateKey.UI_LIVE, []), ['video']);
});

test('state keys keep GAS state categories distinct', () => {
  assert.notEqual(StateKey.UI_LIVE, StateKey.ALL_LIVE);
  assert.equal(StateKey.NOTIFICATION_HISTORY, 'notification_history');
});

