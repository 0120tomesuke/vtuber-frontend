import test from 'node:test';
import assert from 'node:assert/strict';
import { createYouTubeClient, extractVideoIdsFromRss, parseIso8601Duration } from '../src/integrations/youtube-client.js';

test('extractVideoIdsFromRss returns valid YouTube IDs only', () => {
  const xml = '<yt:videoId>abcdefghijk</yt:videoId><yt:videoId>invalid</yt:videoId>';
  assert.deepEqual(extractVideoIdsFromRss(xml), ['abcdefghijk']);
});

test('parseIso8601Duration converts YouTube durations to seconds', () => {
  assert.equal(parseIso8601Duration('PT1H2M3S'), 3723);
  assert.equal(parseIso8601Duration('PT45M'), 2700);
});

test('fetchVideoDetails preserves the UI video contract', async () => {
  const client = createYouTubeClient({
    apiKey: 'test',
    now: () => new Date('2026-09-13T00:00:00Z'),
    fetchFn: async () => new Response(JSON.stringify({ items: [{
      id: 'abcdefghijk',
      snippet: { title: 'Stream', channelTitle: 'Channel', channelId: 'UC123', liveBroadcastContent: 'live', publishedAt: '2026-09-13T00:00:00Z', thumbnails: {} },
      liveStreamingDetails: { actualStartTime: '2026-09-13T00:00:00Z', concurrentViewers: '456' }
    }] }), { status: 200 })
  });
  const videos = await client.fetchVideoDetails(['abcdefghijk']);
  assert.equal(videos[0].videoId, 'abcdefghijk');
  assert.equal(videos[0].viewers, 456);
  assert.equal(videos[0].isLive, true);
});

