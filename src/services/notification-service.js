import { StateKey } from '../repositories/postgres-state-store.js';

const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function card(video) {
  const changes = video.changedFields?.length ? `<p style="color:#c62828">変更: ${escapeHtml(video.changedFields.join('・'))}</p>` : '';
  return `<a href="${escapeHtml(video.videoUrl)}" style="display:block;color:#222;text-decoration:none;margin:16px 0"><div style="border:1px solid #d1e9ff;border-radius:12px;overflow:hidden"><img src="${escapeHtml(video.thumbnail)}" alt="" style="display:block;width:100%"><div style="padding:12px"><strong>${escapeHtml(video.startTime)}</strong><h3 style="margin:8px 0">${escapeHtml(video.title)}</h3><p>${escapeHtml(video.channelTitle)}</p>${changes}</div></div></a>`;
}

function emailHtml(videos) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">${videos.map(card).join('')}<p style="color:#999;font-size:12px">※このメールは自動送信されています。</p></div>`;
}

function updateHistory(history, videos) {
  const next = { ...history };
  videos.forEach((video) => {
    const previous = next[video.videoId] || {};
    next[video.videoId] = {
      ...previous,
      title: video.title,
      startTimeRaw: video.startTimeRaw,
      channelTitle: video.channelTitle,
      channelPhoto: video.channelPhoto || previous.channelPhoto || '',
      mentions: video.mentions || previous.mentions || [],
      isLive: video.isLive,
      notified: true,
      everWentLive: Boolean(video.isLive || previous.everWentLive)
    };
  });
  return next;
}

export function createNotificationService({ stateStore, emailClient, now = () => new Date() }) {
  return Object.freeze({
    async notifyChanges({ newVideos = [], changedVideos = [] }) {
      const sent = [];
      if (newVideos.length) {
        await emailClient.send({ subject: `新規：${newVideos.length}件の配信`, senderName: 'ホロライブ新規配信通知', html: emailHtml(newVideos) });
        sent.push(...newVideos);
      }
      if (changedVideos.length) {
        await emailClient.send({ subject: `変更：${changedVideos.length}件の配信`, senderName: 'ホロライブ配信変更通知', html: emailHtml(changedVideos) });
        sent.push(...changedVideos);
      }
      if (sent.length) {
        const history = await stateStore.get(StateKey.NOTIFICATION_HISTORY, {});
        await stateStore.set(StateKey.NOTIFICATION_HISTORY, updateHistory(history, sent));
      }
      return { sent: sent.length };
    },

    async notifyImminent(videos) {
      const currentTime = now();
      const history = await stateStore.get(StateKey.IMMINENT_NOTIFICATION_HISTORY, {});
      const unsent = videos.filter((video) => !history[video.videoId]?.notified_imminent);
      if (!unsent.length) return { sent: 0 };
      await emailClient.send({ subject: `🔔 配信開始: ${unsent.length}件の注目配信`, senderName: '配信開始通知', html: emailHtml(unsent) });
      const threshold = currentTime.getTime() - 24 * 60 * 60_000;
      const nextHistory = Object.fromEntries(Object.entries(history).filter(([, value]) => value.time > threshold));
      unsent.forEach((video) => { nextHistory[video.videoId] = { time: currentTime.getTime(), notified_imminent: true }; });
      await stateStore.set(StateKey.IMMINENT_NOTIFICATION_HISTORY, nextHistory);
      return { sent: unsent.length };
    }
  });
}

