import { formatTokyo } from '../lib/time.js';

export function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function levenshteinDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[right.length];
}

export function findSpecialCategory(title, eventKeywords = {}) {
  const normalized = normalizeTitle(title).replaceAll('#', ' ');
  const excluded = eventKeywords['その他'] || [];
  if (excluded.some((word) => normalized.includes(normalizeTitle(word)))) return null;
  for (const [category, keywords] of Object.entries(eventKeywords)) {
    if (category === 'その他' || !Array.isArray(keywords)) continue;
    if (keywords.some((word) => normalized.includes(normalizeTitle(word)))) return category;
  }
  return null;
}

export function mergeWithPriority(videos) {
  const byId = new Map();
  for (const video of videos.filter(Boolean)) {
    if (!video.videoId) continue;
    const priority = video.priority ?? (video.source === 'youtube_api' ? 3 : video.source === 'hololive_special' ? 2 : 1);
    const candidate = { ...video, priority };
    const current = byId.get(video.videoId);
    if (!current || priority < current.priority) {
      byId.set(video.videoId, { ...candidate, isSpecial: candidate.isSpecial || current?.isSpecial });
    } else if (candidate.isSpecial && !current.isSpecial) {
      byId.set(video.videoId, { ...current, isSpecial: true });
    }
  }
  return [...byId.values()];
}

export function getChangedFields(video, previous) {
  if (!previous) return [];
  const changes = [];
  if (levenshteinDistance(normalizeTitle(video.title), normalizeTitle(previous.title)) >= 3) changes.push('タイトル');
  if (new Date(video.startTimeRaw).getTime() !== new Date(previous.startTimeRaw).getTime()) changes.push('開始時刻');
  return changes;
}

export function checkStreamTarget(video, { favorites = {}, eventKeywords = {} }) {
  const favoriteIds = new Set(Object.keys(favorites));
  if (favoriteIds.has(video.channelId)) return { isTarget: true, reason: '主' };
  if (findSpecialCategory(video.title, eventKeywords)) return { isTarget: true, reason: '記念' };
  const mentioned = (video.mentions || []).find((mention) => favoriteIds.has(mention.id));
  if (mentioned) return { isTarget: true, reason: `ゲスト(連携:${mentioned.name})` };
  const namedGuest = Object.values(favorites).map(({ name }) => name).find((name) => name && video.title?.includes(name));
  return namedGuest ? { isTarget: true, reason: `ゲスト(タイトル:${namedGuest})` } : { isTarget: false, reason: '' };
}

export function classifyVideos(videos, { favorites = {}, eventKeywords = {}, notificationHistory = {}, now = new Date() }) {
  const newVideos = [];
  const changedVideos = [];
  const rememberedVideos = [];
  const favoriteIds = new Set(Object.keys(favorites));

  for (const original of videos) {
    const target = checkStreamTarget(original, { favorites, eventKeywords });
    if (!target.isTarget) continue;
    const video = { ...original, previous: notificationHistory[original.videoId] || null, passReason: target.reason };
    const within72Hours = new Date(video.startTimeRaw).getTime() >= now.getTime() - 72 * 60 * 60 * 1000;
    if (!favoriteIds.has(video.channelId) && !video.isSpecial && !within72Hours && !video.isLive) {
      rememberedVideos.push(video);
      continue;
    }
    video.changedFields = getChangedFields(video, video.previous);
    if (!video.previous?.notified) {
      video.isNew = true;
      newVideos.push(video);
    } else if (video.changedFields.length) {
      video.isNew = false;
      changedVideos.push(video);
    } else {
      video.isNew = false;
      rememberedVideos.push(video);
    }
  }
  return { newVideos, changedVideos, rememberedVideos };
}

export function shouldIncludeVideo(video, { favoriteChannelIds = [], excludeWords = [], excludeChannelIds = [] }) {
  if (favoriteChannelIds.includes(video.channelId)) return true;
  if (excludeWords.some((word) => normalizeTitle(video.title).includes(normalizeTitle(word)))) return false;
  return !excludeChannelIds.includes(video.channelId);
}

export async function detectEndedStreams(previousVideos, currentVideos, { getArchiveStats, now = new Date(), retentionDays = 2 } = {}) {
  const currentIds = new Set(currentVideos.map(({ videoId }) => videoId));
  const retentionStart = new Date(now);
  retentionStart.setDate(retentionStart.getDate() - retentionDays);
  retentionStart.setHours(0, 0, 0, 0);
  const ended = await Promise.all(previousVideos.filter(({ videoId }) => !currentIds.has(videoId)).map(async (previous) => {
    const stats = await getArchiveStats(previous.videoId);
    return {
      ...previous,
      isLive: false,
      isEnded: true,
      liveViewersFormatted: stats.peak > 0 ? Number(stats.peak).toLocaleString('en-US') : previous.liveViewersFormatted,
      durationLabel: stats.duration > 0 ? `${Math.floor(stats.duration / 60)}:${String(stats.duration % 60).padStart(2, '0')}` : previous.durationLabel
    };
  }));
  return ended.filter((video) => new Date(video.startTimeRaw).getTime() >= retentionStart.getTime()).sort((a, b) => new Date(b.startTimeRaw) - new Date(a.startTimeRaw));
}

export function processEndedHistory({ newlyEnded = [], apiEnded = [], previousEnded = [], now = new Date(), retentionDays = 2 }) {
  const retentionStart = new Date(now);
  retentionStart.setDate(retentionStart.getDate() - retentionDays);
  retentionStart.setHours(0, 0, 0, 0);
  return mergeWithPriority([...newlyEnded, ...apiEnded, ...previousEnded])
    .map((video) => ({ ...video, dateKey: video.dateKey || (video.startTimeRaw ? formatTokyo(new Date(video.startTimeRaw), 'MM/dd') : '') }))
    .filter((video) => new Date(video.startTimeRaw).getTime() >= retentionStart.getTime())
    .sort((a, b) => new Date(b.startTimeRaw) - new Date(a.startTimeRaw));
}

export function buildUiState(videos, ended = []) {
  const active = mergeWithPriority(videos);
  return {
    live: active.filter((video) => video.isLive),
    upcoming: active.filter((video) => !video.isLive && !video.isEnded),
    ended: processEndedHistory({ apiEnded: [...active.filter((video) => video.isEnded), ...ended] })
  };
}

