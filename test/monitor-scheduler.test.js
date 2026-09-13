import test from 'node:test';
import assert from 'node:assert/strict';
import { startMonitorScheduler } from '../src/services/monitor-scheduler.js';

test('scheduler starts a monitoring attempt immediately', async () => {
  let calls = 0;
  const stop = startMonitorScheduler({ monitorService: { run: async () => { calls += 1; return { skipped: true }; } }, logger: { info() {}, error() {} }, tickMs: 60_000 });
  await new Promise((resolve) => setImmediate(resolve));
  stop();
  assert.equal(calls, 1);
});

