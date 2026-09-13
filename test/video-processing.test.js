import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVideos, findSpecialCategory, mergeWithPriority, processEndedHistory } from '../src/services/video-processing.js';

test('mergeWithPriority keeps Holodex data over lower-priority YouTube supplements', () => {
  const [video] = mergeWithPriority([{ videoId: 'id', source: 'youtube_api', title: 'YouTube', priority: 3 }, { videoId: 'id', source: 'holodex', title: 'Holodex', priority: 1, isSpecial: true }]);
  assert.equal(video.title, 'Holodex');
  assert.equal(video.isSpecial, true);
});

test('special categories honor the その他 exclusion list', () => {
  const keywords = { Birthday: ['birthday'], その他: ['archive'] };
  assert.equal(findSpecialCategory('Birthday stream', keywords), 'Birthday');
  assert.equal(findSpecialCategory('Birthday archive', keywords), null);
});

test('classifyVideos identifies new and changed favorite streams', () => {
  const context = { favorites: { UC1: { name: 'Talent' } }, notificationHistory: { old: { notified: true, title: 'old title', startTimeRaw: '2026-09-13T10:00:00Z' } }, now: new Date('2026-09-13T00:00:00Z') };
  const result = classifyVideos([{ videoId: 'new', channelId: 'UC1', title: 'new', startTimeRaw: '2026-09-13T10:00:00Z' }, { videoId: 'old', channelId: 'UC1', title: 'renamed stream', startTimeRaw: '2026-09-13T11:00:00Z' }], context);
  assert.equal(result.newVideos.length, 1);
  assert.deepEqual(result.changedVideos[0].changedFields, ['タイトル', '開始時刻']);
});

test('processEndedHistory retains only the configured recent period', () => {
  const result = processEndedHistory({ now: new Date('2026-09-13T12:00:00Z'), apiEnded: [{ videoId: 'recent', startTimeRaw: '2026-09-12T12:00:00Z' }, { videoId: 'old', startTimeRaw: '2026-09-09T12:00:00Z' }] });
  assert.deepEqual(result.map((video) => video.videoId), ['recent']);
});

