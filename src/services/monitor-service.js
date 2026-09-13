import { appConfig } from '../config/app-config.js';
import { StateKey } from '../repositories/postgres-state-store.js';
import { checkStreamTarget, classifyVideos, detectEndedStreams, mergeWithPriority, processEndedHistory } from './video-processing.js';

const MONITOR_LOCK = 'main-live-monitor';

function tokyoHour(date) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(date));
}

export function requiredYoutubeIntervalMs(now) {
  const hour = tokyoHour(now);
  if (hour >= 2 && hour < 7) return 50 * 60_000;
  if ((hour >= 0 && hour < 2) || (hour >= 7 && hour < 15)) return 7.5 * 60_000;
  return 3.5 * 60_000;
}

function emptyUiState() {
  return { live: [], upcoming: [], ended: [] };
}

export function createMonitorService({ stateStore, sheetsClient, holodexClient, youtubeClient, notificationService, now = () => new Date(), logger = console }) {
  async function getArchiveStats(videoId, fallback = {}) {
    const [durationResult, detailResult] = await Promise.allSettled([
      youtubeClient.fetchArchiveDuration(videoId),
      holodexClient.fetchVideoDetail(videoId)
    ]);
    const duration = durationResult.status === 'fulfilled' ? durationResult.value : 0;
    const peak = Number(detailResult.status === 'fulfilled' ? detailResult.value?.live_viewers : 0) || Number(String(fallback.liveViewersFormatted || 0).replaceAll(',', '')) || 0;
    return { duration, peak };
  }

  async function runYoutubeSupplement({ globalChannels, currentHolodex, previousUpcoming, lastScan, processedIds, currentTime }) {
    if (currentTime.getTime() - Number(lastScan || 0) < requiredYoutubeIntervalMs(currentTime)) {
      return { videos: previousUpcoming.filter((video) => video.source === 'youtube_api'), processedIds, scanned: false };
    }
    const holodexIds = new Set(currentHolodex.map((video) => video.videoId));
    const candidates = new Set((await youtubeClient.fetchRssVideoIds(Object.keys(globalChannels))).filter((id) => !holodexIds.has(id) && !processedIds.includes(id)));
    const oneDayAgo = currentTime.getTime() - 24 * 60 * 60_000;
    previousUpcoming.forEach((video) => {
      const time = new Date(video.startTimeRaw).getTime();
      if (video.videoId && !holodexIds.has(video.videoId) && (time > currentTime.getTime() || time >= oneDayAgo)) candidates.add(video.videoId);
    });
    const videos = candidates.size ? await youtubeClient.fetchVideoDetails([...candidates]) : [];
    const validIds = new Set(videos.map((video) => video.videoId));
    const nextProcessed = [...new Set([...processedIds, ...[...candidates].filter((id) => !validIds.has(id))])].slice(-5000);
    return { videos, processedIds: nextProcessed, scanned: true };
  }

  async function performRun(currentTime) {
    const [master, globalChannels, previousGlobalLive, previousGlobalUpcoming, previousGlobalEnded, previousUiLive, previousUiUpcoming, notificationHistory, processedIds, lastYoutubeScan] = await Promise.all([
      sheetsClient.loadMasterData(),
      sheetsClient.loadGlobalChannels(),
      stateStore.get(StateKey.ALL_LIVE, []),
      stateStore.get(StateKey.ALL_UPCOMING, []),
      stateStore.get(StateKey.ALL_ENDED, []),
      stateStore.get(StateKey.UI_LIVE, []),
      stateStore.get(StateKey.UI_UPCOMING, []),
      stateStore.get(StateKey.NOTIFICATION_HISTORY, {}),
      stateStore.get(StateKey.PROCESSED_RSS_IDS, []),
      stateStore.get(StateKey.LAST_YOUTUBE_SCAN, 0)
    ]);

    const globalHolodex = await holodexClient.fetchGlobalStreams(Object.keys(globalChannels), { talentMap: master.talentMap });
    const supplement = await runYoutubeSupplement({ globalChannels, currentHolodex: globalHolodex, previousUpcoming: previousGlobalUpcoming, lastScan: lastYoutubeScan, processedIds, currentTime });
    const globalVideos = mergeWithPriority([...globalHolodex, ...supplement.videos]);
    const globalLive = globalVideos.filter((video) => video.isLive);
    const globalUpcoming = globalVideos.filter((video) => !video.isLive && !video.isEnded);
    const newlyGlobalEnded = await detectEndedStreams(previousGlobalLive, globalLive, { now: currentTime, getArchiveStats: (videoId) => getArchiveStats(videoId) });
    const globalEnded = processEndedHistory({ newlyEnded: newlyGlobalEnded, apiEnded: globalVideos.filter((video) => video.isEnded), previousEnded: previousGlobalEnded, now: currentTime, retentionDays: appConfig.retention.endedVideosDays });

    const [favoriteStreams, specialStreams] = await Promise.all([
      holodexClient.fetchFavoriteStreams(Object.keys(master.favorites)),
      holodexClient.fetchSpecialStreams({ excludedChannelIds: master.excludes, isSpecialStream: (title) => Boolean(checkStreamTarget({ title }, { favorites: {}, eventKeywords: master.eventKeywords }).reason) })
    ]);
    const cachedTargets = globalUpcoming.filter((video) => checkStreamTarget(video, { favorites: master.favorites, eventKeywords: master.eventKeywords }).isTarget);
    const favoriteVideos = mergeWithPriority([...cachedTargets, ...favoriteStreams, ...specialStreams]);
    const classification = classifyVideos(favoriteVideos, { favorites: master.favorites, eventKeywords: master.eventKeywords, notificationHistory, now: currentTime });
    const currentUi = [...classification.newVideos, ...classification.changedVideos, ...classification.rememberedVideos];
    const uiLive = currentUi.filter((video) => video.isLive);
    const uiUpcoming = currentUi.filter((video) => !video.isLive && !video.isEnded);
    const newlyUiEnded = await detectEndedStreams([...previousUiLive, ...previousUiUpcoming], currentUi, { now: currentTime, getArchiveStats: (videoId) => getArchiveStats(videoId) });
    const uiEnded = processEndedHistory({ newlyEnded: newlyUiEnded, apiEnded: currentUi.filter((video) => video.isEnded), now: currentTime, retentionDays: appConfig.retention.endedVideosDays });

    await stateStore.setMany({
      [StateKey.ALL_LIVE]: globalLive,
      [StateKey.ALL_UPCOMING]: globalUpcoming,
      [StateKey.ALL_ENDED]: globalEnded,
      [StateKey.UI_LIVE]: uiLive,
      [StateKey.UI_UPCOMING]: uiUpcoming,
      [StateKey.UI_ENDED]: uiEnded,
      [StateKey.PROCESSED_RSS_IDS]: supplement.processedIds,
      [StateKey.LAST_YOUTUBE_SCAN]: supplement.scanned ? currentTime.getTime() : lastYoutubeScan,
      [StateKey.LAST_MONITOR_RUN]: currentTime.getTime()
    });
    await stateStore.delete(StateKey.UI_ERROR);
    const notification = notificationService
      ? await notificationService.notifyChanges({ newVideos: classification.newVideos, changedVideos: classification.changedVideos })
      : { sent: 0 };
    return { skipped: false, notificationCandidates: { newVideos: classification.newVideos, changedVideos: classification.changedVideos }, notification, counts: { globalLive: globalLive.length, globalUpcoming: globalUpcoming.length, uiLive: uiLive.length, uiUpcoming: uiUpcoming.length }, youtubeScanned: supplement.scanned };
  }

  return Object.freeze({
    async run() {
      const currentTime = now();
      const locked = await stateStore.acquireLock(MONITOR_LOCK, 10 * 60_000);
      if (!locked) return { skipped: true, reason: 'already_running' };
      try {
        const lastRun = await stateStore.get(StateKey.LAST_MONITOR_RUN, 0);
        const interval = (() => { const hour = tokyoHour(currentTime); return hour >= appConfig.polling.activeStartHour || hour < appConfig.polling.activeEndHour ? appConfig.polling.activeIntervalMs : appConfig.polling.inactiveIntervalMs; })();
        if (currentTime.getTime() - Number(lastRun || 0) < interval) return { skipped: true, reason: 'interval' };
        await holodexClient.healthCheck();
        return await performRun(currentTime);
      } catch (error) {
        logger.error('Monitor failed; previous successful state was retained.', error);
        await stateStore.set(StateKey.UI_ERROR, { message: error.message, at: currentTime.toISOString() });
        return { skipped: false, failed: true, error: error.message };
      } finally {
        await stateStore.releaseLock(MONITOR_LOCK);
      }
    },
    getEmptyUiState: emptyUiState
  });
}

