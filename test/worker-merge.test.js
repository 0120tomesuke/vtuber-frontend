import test from 'node:test';
import assert from 'node:assert/strict';
import { merge } from '../src/worker.js';

test('worker merge never regresses a LIVE stream to upcoming', () => {
  const [stream] = merge([
    { videoId: 'stream', source: 'holodex-list', priority: 1, title: 'latest', isLive: true, isEnded: false, mentionsKnown: true },
    { videoId: 'stream', source: 'holodex-detail', priority: 1, title: 'stale detail', isLive: false, isEnded: false, mentionsKnown: true }
  ]);
  assert.equal(stream.isLive, true);
  assert.equal(stream.title, 'latest');
});

test('worker merge permits an explicit ended state to replace LIVE', () => {
  const [stream] = merge([
    { videoId: 'stream', priority: 1, isLive: true, isEnded: false },
    { videoId: 'stream', priority: 1, isLive: false, isEnded: true }
  ]);
  assert.equal(stream.isLive, false);
  assert.equal(stream.isEnded, true);
});
