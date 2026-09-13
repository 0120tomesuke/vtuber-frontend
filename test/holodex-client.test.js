import test from 'node:test';
import assert from 'node:assert/strict';
import { createHolodexClient, HolodexApiError } from '../src/integrations/holodex-client.js';

const video = {
  id: 'abcdefghijk', title: 'Test stream', status: 'live', live_viewers: 1234,
  start_actual: '2026-09-13T10:00:00Z', channel: { id: 'UC123', name: 'Test Channel', photo: 'https://example.com/icon.png' }
};

test('fetchFavoriteStreams normalizes Holodex data for the existing UI contract', async () => {
  const client = createHolodexClient({ apiKey: 'test', now: () => new Date('2026-09-13T12:00:00Z'), fetchFn: async () => new Response(JSON.stringify([video]), { status: 200 }) });
  const streams = await client.fetchFavoriteStreams(['UC123']);
  assert.equal(streams[0].videoId, video.id);
  assert.equal(streams[0].isLive, true);
  assert.equal(streams[0].liveViewersFormatted, '1,234');
});

test('HTTP failures are raised instead of becoming an empty successful result', async () => {
  const client = createHolodexClient({ apiKey: 'test', fetchFn: async () => new Response('', { status: 503 }) });
  await assert.rejects(() => client.fetchFavoriteStreams(['UC123']), HolodexApiError);
});

