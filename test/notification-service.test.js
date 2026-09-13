import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationService } from '../src/services/notification-service.js';

test('notification history is stored only after a successful delivery', async () => {
  const writes = [];
  const service = createNotificationService({ stateStore: { get: async () => ({}), set: async (...args) => writes.push(args) }, emailClient: { send: async () => ({ id: 'mail' }) } });
  const result = await service.notifyChanges({ newVideos: [{ videoId: 'id', title: '<title>', startTime: '09/13 12:00', videoUrl: 'https://example.com', thumbnail: 'https://example.com/a.jpg' }] });
  assert.equal(result.sent, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].id.notified, true);
});

test('failed delivery does not mark a video as notified', async () => {
  const service = createNotificationService({ stateStore: { get: async () => ({}), set: async () => assert.fail('history must not be written') }, emailClient: { send: async () => { throw new Error('delivery failed'); } } });
  await assert.rejects(() => service.notifyChanges({ newVideos: [{ videoId: 'id' }] }), /delivery failed/);
});

