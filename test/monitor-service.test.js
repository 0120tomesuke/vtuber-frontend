import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorService, requiredYoutubeIntervalMs } from '../src/services/monitor-service.js';

test('RSS scan interval varies by Japan time', () => {
  assert.equal(requiredYoutubeIntervalMs(new Date('2026-09-13T18:00:00Z')), 50 * 60_000); // 03:00 JST
  assert.equal(requiredYoutubeIntervalMs(new Date('2026-09-13T08:00:00Z')), 3.5 * 60_000); // 17:00 JST
});

test('monitor does not call external services when another run owns the lock', async () => {
  const store = { acquireLock: async () => false };
  const service = createMonitorService({ stateStore: store, sheetsClient: {}, holodexClient: {}, youtubeClient: {} });
  assert.deepEqual(await service.run(), { skipped: true, reason: 'already_running' });
});

