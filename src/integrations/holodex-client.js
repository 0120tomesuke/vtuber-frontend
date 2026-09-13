import { env, requireEnv } from '../config/env.js';
import { dayDifference, formatTokyo } from '../lib/time.js';

const BASE_URL = 'https://holodex.net/api/v2';

export class HolodexApiError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'HolodexApiError';
    this.status = status;
  }
}

export function createHolodexClient({ apiKey = env.holodexApiKey, fetchFn = fetch, now = () => new Date() } = {}) {
  async function request(path, params = {}) {
    if (!apiKey) requireEnv('HOLODEX_API_KEY');
    const url = new URL(`${BASE_URL}${path}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    });

    let response;
    try {
      response = await fetchFn(url, { headers: { 'X-APIKEY': apiKey, Accept: 'application/json' } });
    } catch (cause) {
      throw new HolodexApiError('Holodexへの接続に失敗しました', { cause });
    }
    if (!response.ok) {
      throw new HolodexApiError(`Holodex HTTP error ${response.status}`, { status: response.status });
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new HolodexApiError('HolodexのレスポンスをJSONとして解析できません', { cause });
    }
  }

  function normalizeVideo(video, { talentMap = {}, globalChannelIds = new Set(), externalPrefix = false } = {}) {
    const startTimeRaw = video.start_actual || video.actual_start || video.start_scheduled || video.available_at || null;
    const startDate = startTimeRaw ? new Date(startTimeRaw) : null;
    const isExternal = externalPrefix && !globalChannelIds.has(video.channel?.id);
    const guests = (video.mentions || [])
      .filter((mention) => globalChannelIds.has(mention.id))
      .map((mention) => ({ name: talentMap[mention.name] || mention.name, icon: mention.photo || '' }))
      .filter((guest, index, list) => list.findIndex((item) => item.name === guest.name) === index);

    return {
      videoId: video.id,
      title: video.title || '',
      channelTitle: isExternal ? `(外) ${video.channel?.name || ''}` : video.channel?.name || '',
      channelId: video.channel?.id || '',
      channelIcon: video.channel?.photo || '',
      thumbnail: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
      videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
      viewers: video.live_viewers || 0,
      liveViewersFormatted: video.live_viewers ? Number(video.live_viewers).toLocaleString('en-US') : null,
      startTimeRaw,
      dateKey: startDate && !Number.isNaN(startDate.valueOf()) ? formatTokyo(startDate, 'MM/dd') : '',
      startTime: startDate && !Number.isNaN(startDate.valueOf()) ? formatTokyo(startDate) : '未定',
      isLive: video.status === 'live',
      isEnded: video.status === 'past',
      durationLabel: video.duration ? `${Math.floor(video.duration / 60)}:${String(video.duration % 60).padStart(2, '0')}` : '',
      mentions: video.mentions || [],
      guests,
      source: 'holodex',
      priority: 1
    };
  }

  return Object.freeze({
    async healthCheck() {
      await request('/live', { limit: 1 });
      return true;
    },

    async fetchFavoriteStreams(channelIds) {
      if (!channelIds.length) return [];
      const data = await request('/users/live', { channels: channelIds.join(',') });
      if (!Array.isArray(data)) throw new HolodexApiError('Holodexの動画一覧が配列ではありません');
      const current = now();
      return data
        .map((video) => normalizeVideo(video))
        .filter((video) => video.startTimeRaw && (video.isLive || (dayDifference(new Date(video.startTimeRaw), current) >= -2 && dayDifference(new Date(video.startTimeRaw), current) <= 3)));
    },

    async fetchSpecialStreams({ excludedChannelIds = [], isSpecialStream }) {
      const data = await request('/live', { org: 'Hololive', max_upcoming_hours: 336 });
      if (!Array.isArray(data)) throw new HolodexApiError('Holodexの動画一覧が配列ではありません');
      const excluded = new Set(excludedChannelIds);
      const current = now();
      return data
        .filter((video) => !excluded.has(video.channel?.id) && isSpecialStream(video.title || ''))
        .map((video) => ({ ...normalizeVideo(video), isSpecial: true, isNew: true }))
        .filter((video) => video.startTimeRaw && (video.isLive || (dayDifference(new Date(video.startTimeRaw), current) >= -2 && dayDifference(new Date(video.startTimeRaw), current) <= 3)));
    },

    async fetchGlobalStreams(channelIds, { talentMap = {} } = {}) {
      if (!channelIds.length) return [];
      const chunks = Array.from({ length: Math.ceil(channelIds.length / 50) }, (_, index) => channelIds.slice(index * 50, index * 50 + 50));
      const ownResponses = await Promise.all(chunks.map((chunk) => request('/live', { channels: chunk.join(','), include: 'mentions', max_upcoming_hours: 336 })));
      const external = await request('/live', { org: 'Hololive', include: 'mentions', limit: 50, max_upcoming_hours: 336 });
      const channelSet = new Set(channelIds);
      const deduplicated = new Map();
      [...ownResponses.flat(), ...(Array.isArray(external) ? external : [])].forEach((video) => {
        if (!video?.id || deduplicated.has(video.id)) return;
        const normalized = normalizeVideo(video, { talentMap, globalChannelIds: channelSet, externalPrefix: true });
        if (!channelSet.has(video.channel?.id) && normalized.guests.length === 0) return;
        deduplicated.set(video.id, normalized);
      });
      return [...deduplicated.values()];
    },

    async fetchVideoDetail(videoId) {
      const data = await request(`/videos/${encodeURIComponent(videoId)}`);
      return data || null;
    }
  });
}

