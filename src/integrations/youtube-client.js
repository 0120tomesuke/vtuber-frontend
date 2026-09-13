import { env, requireEnv } from '../config/env.js';
import { formatTokyo } from '../lib/time.js';

const API_BASE_URL = 'https://www.googleapis.com/youtube/v3';
const RSS_BASE_URL = 'https://www.youtube.com/feeds/videos.xml';

export class YouTubeApiError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'YouTubeApiError';
    this.status = status;
  }
}

export function extractVideoIdsFromRss(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/g)].map((match) => match[1]);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

export function parseIso8601Duration(duration) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration || '');
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

export function createYouTubeClient({ apiKey = env.youtubeApiKey, fetchFn = fetch, now = () => new Date() } = {}) {
  async function apiRequest(path, params = {}) {
    if (!apiKey) requireEnv('YOUTUBE_API_KEY');
    const url = new URL(`${API_BASE_URL}${path}`);
    Object.entries({ ...params, key: apiKey }).forEach(([key, value]) => url.searchParams.set(key, value));
    let response;
    try {
      response = await fetchFn(url);
    } catch (cause) {
      throw new YouTubeApiError('YouTube APIへの接続に失敗しました', { cause });
    }
    if (!response.ok) throw new YouTubeApiError(`YouTube API HTTP error ${response.status}`, { status: response.status });
    return response.json();
  }

  return Object.freeze({
    async fetchRssVideoIds(channelIds, { concurrency = 15 } = {}) {
      const ids = new Set();
      await mapWithConcurrency(channelIds, concurrency, async (channelId) => {
        try {
          const url = new URL(RSS_BASE_URL);
          url.searchParams.set('channel_id', channelId);
          const response = await fetchFn(url);
          if (!response.ok) return;
          extractVideoIdsFromRss(await response.text()).forEach((id) => ids.add(id));
        } catch {
          // An individual feed outage must not cancel the remaining channel scan.
        }
      });
      return [...ids];
    },

    async fetchVideoDetails(videoIds) {
      const chunks = Array.from({ length: Math.ceil(videoIds.length / 50) }, (_, index) => videoIds.slice(index * 50, index * 50 + 50));
      const cutoff = now().getTime() + 14 * 24 * 60 * 60 * 1000;
      const responses = await Promise.all(chunks.map((chunk) => apiRequest('/videos', { part: 'snippet,liveStreamingDetails', id: chunk.join(',') })));
      return responses.flatMap((response) => response.items || []).flatMap((item) => {
        const live = item.snippet?.liveBroadcastContent === 'live';
        const details = item.liveStreamingDetails;
        const ended = item.snippet?.liveBroadcastContent === 'none' && Boolean(details?.actualEndTime);
        if (!details || ended) return [];
        const startTimeRaw = details.actualStartTime || details.scheduledStartTime || item.snippet?.publishedAt;
        const startDate = new Date(startTimeRaw);
        if (!live && startDate.getTime() > cutoff) return [];
        return [{
          videoId: item.id,
          title: item.snippet?.title || '',
          channelTitle: item.snippet?.channelTitle || '',
          channelId: item.snippet?.channelId || '',
          channelIcon: item.snippet?.thumbnails?.default?.url || '',
          thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          videoUrl: `https://www.youtube.com/watch?v=${item.id}`,
          viewers: Number(details.concurrentViewers || 0),
          startTimeRaw,
          dateKey: formatTokyo(startDate, 'MM/dd'),
          startTime: formatTokyo(startDate),
          isLive: live,
          isEnded: false,
          source: 'youtube_api',
          priority: 3,
          supplementReason: 'rss_or_disappeared_supplement'
        }];
      });
    },

    async fetchArchiveDuration(videoId) {
      const response = await apiRequest('/videos', { part: 'contentDetails', id: videoId });
      return parseIso8601Duration(response.items?.[0]?.contentDetails?.duration);
    }
  });
}

