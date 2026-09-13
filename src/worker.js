const TOKYO = 'Asia/Tokyo';
const HOLODEX = 'https://holodex.net/api/v2';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const esc = (value) => String(value || '').replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\n', '\\n');
const format = (value, dateOnly = false) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TOKYO, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return dateOnly ? `${parts.month}/${parts.day}` : `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
};

async function getState(env, key, fallback) {
  const row = await env.DB.prepare('SELECT state_value FROM app_state WHERE state_key = ?').bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.state_value); } catch { return fallback; }
}
async function setState(env, key, value) {
  await env.DB.prepare('INSERT INTO app_state (state_key, state_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value, updated_at = CURRENT_TIMESTAMP').bind(key, JSON.stringify(value)).run();
}
async function setStates(env, values) {
  await env.DB.batch(Object.entries(values).map(([key, value]) => env.DB.prepare('INSERT INTO app_state (state_key, state_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value, updated_at = CURRENT_TIMESTAMP').bind(key, JSON.stringify(value))));
}

function pemBytes(pem) {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replaceAll(/\s/g, '');
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
async function googleToken(env) {
  const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = base64url(new TextEncoder().encode(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(account.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`))));
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${signature}` }) });
  if (!response.ok) throw new Error(`Google OAuth failed: ${response.status}`);
  return (await response.json()).access_token;
}
async function sheetValues(env, ranges) {
  const token = await googleToken(env);
  const query = new URLSearchParams(); ranges.forEach((range) => query.append('ranges', range));
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEETS_ID)}/values:batchGet?${query}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Google Sheets read failed: ${response.status}`);
  return (await response.json()).valueRanges.map((entry) => entry.values || []);
}
async function masters(env) {
  const [favorites, excludes, words, events, talent, global] = await sheetValues(env, ["'お気に入りチャンネル'!A:C", "'除外チャンネル'!A:B", "'除外ワード'!A:A", "'イベントキーワード'!A:ZZ", "'チャンネル置き換え'!A:B", "'全体チャンネル'!A:B"]);
  const favoriteMap = Object.fromEntries(favorites.slice(1).filter((row) => String(row[2] || '') === '1' && row[1]).map((row) => [String(row[1]).trim(), { name: String(row[0] || '').trim() }]));
  const eventKeywords = Object.fromEntries((events[0] || []).map((title, column) => [title, events.slice(1).map((row) => row[column]).filter(Boolean)]).filter(([title]) => title));
  return { favorites: favoriteMap, excludes: excludes.slice(1).map((row) => row[1]).filter(Boolean), excludeWords: words.map((row) => String(row[0] || '').toLowerCase()).filter(Boolean), eventKeywords, talentMap: Object.fromEntries(talent.slice(1).filter((row) => row[0] && row[1])), global: Object.fromEntries(global.slice(1).filter((row) => String(row[1] || '').startsWith('UC')).map((row) => [String(row[1]), { name: row[0] }])) };
}
async function updateFavorite(env, channelId, isFavorite) {
  const token = await googleToken(env);
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEETS_ID)}/values/${encodeURIComponent("'お気に入りチャンネル'!A:C")}`;
  const readResponse = await fetch(readUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!readResponse.ok) throw new Error(`Google Sheets read failed: ${readResponse.status}`);
  const rows = (await readResponse.json()).values || [];
  const index = rows.findIndex((row, rowIndex) => rowIndex > 0 && String(row[1] || '').trim() === channelId);
  if (index < 0) return false;
  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEETS_ID)}/values/${encodeURIComponent(`'お気に入りチャンネル'!C${index + 1}`)}?valueInputOption=RAW`;
  const writeResponse = await fetch(writeUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ values: [[isFavorite ? 1 : 0]] }) });
  if (!writeResponse.ok) throw new Error(`Google Sheets update failed: ${writeResponse.status}`);
  return true;
}
function isSpecial(title, keywords) {
  const text = String(title || '').toLowerCase().replaceAll('#', ' ');
  if ((keywords['その他'] || []).some((word) => text.includes(String(word).toLowerCase()))) return null;
  return Object.entries(keywords).find(([category, words]) => category !== 'その他' && words.some((word) => text.includes(String(word).toLowerCase())))?.[0] || null;
}
function video(raw, globalIds, talentMap) {
  const start = raw.start_actual || raw.actual_start || raw.start_scheduled || raw.available_at;
  const external = globalIds && !globalIds.has(raw.channel?.id);
  const guests = (raw.mentions || []).filter((mention) => globalIds?.has(mention.id)).map((mention) => ({ name: talentMap[mention.name] || mention.name, icon: mention.photo || '' }));
  return { videoId: raw.id, title: raw.title || '', channelTitle: external ? `(外) ${raw.channel?.name || ''}` : raw.channel?.name || '', channelId: raw.channel?.id || '', channelIcon: raw.channel?.photo || '', thumbnail: `https://i.ytimg.com/vi/${raw.id}/hqdefault.jpg`, videoUrl: `https://www.youtube.com/watch?v=${raw.id}`, viewers: raw.live_viewers || 0, liveViewersFormatted: raw.live_viewers ? Number(raw.live_viewers).toLocaleString() : null, startTimeRaw: start, startTime: start ? format(start) : '未定', dateKey: start ? format(start, true) : '', isLive: raw.status === 'live', isEnded: raw.status === 'past', durationLabel: raw.duration ? `${Math.floor(raw.duration / 60)}:${String(raw.duration % 60).padStart(2, '0')}` : '', mentions: raw.mentions || [], guests, source: 'holodex', priority: 1 };
}
async function holodex(env, path, parameters) {
  const url = new URL(`${HOLODEX}${path}`); Object.entries(parameters || {}).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { 'X-APIKEY': env.HOLODEX_API_KEY } }); if (!response.ok) throw new Error(`Holodex failed: ${response.status}`); return response.json();
}
function merge(videos) { const map = new Map(); videos.filter(Boolean).forEach((item) => { const prior = map.get(item.videoId); if (!prior || (item.priority || 1) < (prior.priority || 1)) map.set(item.videoId, { ...item, isSpecial: item.isSpecial || prior?.isSpecial }); }); return [...map.values()]; }
function target(item, master) { const ids = new Set(Object.keys(master.favorites)); if (ids.has(item.channelId)) return true; if (isSpecial(item.title, master.eventKeywords)) return true; if ((item.mentions || []).some((mention) => ids.has(mention.id))) return true; return Object.values(master.favorites).some((favorite) => favorite.name && item.title?.includes(favorite.name)); }
function normalizeTitle(value) { return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function distance(left, right) { const a = String(left || ''); const b = String(right || ''); const row = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i += 1) { let previous = row[0]; row[0] = i; for (let j = 1; j <= b.length; j += 1) { const current = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = current; } } return row[b.length]; }
function changedFields(item, previous) { if (!previous) return []; const changes = []; if (distance(normalizeTitle(item.title), normalizeTitle(previous.title)) >= 3) changes.push('タイトル'); if (new Date(item.startTimeRaw).getTime() !== new Date(previous.startTimeRaw).getTime()) changes.push('開始時刻'); return changes; }
function isoDurationSeconds(value) { const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || ''); return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0; }
function tokyoHour(date = new Date()) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: TOKYO, hour: '2-digit', hourCycle: 'h23' }).format(date)); }
function youtubeInterval(now) { const hour = tokyoHour(now); return hour >= 2 && hour < 7 ? 50 * 60_000 : ((hour < 2 || hour < 15) ? 7.5 * 60_000 : 3.5 * 60_000); }
// Cloudflare Cron's free minimum interval is one minute.  Keep this below 60 seconds
// so each scheduled invocation during the active period performs a monitor run.
function monitorInterval(now) { const hour = tokyoHour(now); return hour >= 10 || hour < 2 ? 55_000 : 15 * 60_000; }
async function mapLimit(values, limit, fn) { let cursor = 0; await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { while (cursor < values.length) { const index = cursor++; await fn(values[index]); } })); }
async function rssIds(channelIds) { const ids = new Set(); await mapLimit(channelIds, 15, async (channelId) => { try { const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`); if (!response.ok) return; for (const match of (await response.text()).matchAll(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/g)) ids.add(match[1]); } catch { /* A single RSS failure is non-fatal. */ } }); return [...ids]; }
async function youtubeDetails(env, ids) { if (!env.YOUTUBE_API_KEY || !ids.length) return []; const chunks = Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) => ids.slice(i * 50, i * 50 + 50)); const cutoff = Date.now() + 14 * 86400000; const results = await Promise.all(chunks.map(async (chunk) => { const query = new URLSearchParams({ part: 'snippet,liveStreamingDetails', id: chunk.join(','), key: env.YOUTUBE_API_KEY }); const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${query}`); if (!response.ok) throw new Error(`YouTube API failed: ${response.status}`); return (await response.json()).items || []; })); return results.flat().flatMap((item) => { const details = item.liveStreamingDetails; const live = item.snippet?.liveBroadcastContent === 'live'; const ended = item.snippet?.liveBroadcastContent === 'none' && Boolean(details?.actualEndTime); if (!details || ended) return []; const startTimeRaw = details.actualStartTime || details.scheduledStartTime || item.snippet?.publishedAt; if (!live && new Date(startTimeRaw).getTime() > cutoff) return []; return [{ videoId: item.id, title: item.snippet?.title || '', channelTitle: item.snippet?.channelTitle || '', channelId: item.snippet?.channelId || '', channelIcon: item.snippet?.thumbnails?.default?.url || '', thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`, videoUrl: `https://www.youtube.com/watch?v=${item.id}`, viewers: Number(details.concurrentViewers || 0), liveViewersFormatted: details.concurrentViewers ? Number(details.concurrentViewers).toLocaleString() : null, startTimeRaw, startTime: format(startTimeRaw), dateKey: format(startTimeRaw, true), isLive: live, isEnded: false, mentions: [], guests: [], source: 'youtube_api', priority: 3 }]; }); }
async function archiveStats(env, videoId, fallback) { const [youtube, detail] = await Promise.allSettled([async () => { if (!env.YOUTUBE_API_KEY) return 0; const query = new URLSearchParams({ part: 'contentDetails', id: videoId, key: env.YOUTUBE_API_KEY }); const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${query}`); return response.ok ? isoDurationSeconds((await response.json()).items?.[0]?.contentDetails?.duration) : 0; }, holodex(env, `/videos/${encodeURIComponent(videoId)}`)]); const peak = Number(detail.status === 'fulfilled' ? detail.value?.live_viewers : 0) || Number(String(fallback.liveViewersFormatted || 0).replaceAll(',', '')) || 0; return { duration: youtube.status === 'fulfilled' ? youtube.value : 0, peak }; }
async function endedFrom(previous, current, env, keep) { const currentIds = new Set(current.map((item) => item.videoId)); const candidates = previous.filter((item) => !currentIds.has(item.videoId)); return (await Promise.all(candidates.map(async (item) => { const stats = await archiveStats(env, item.videoId, item); return { ...item, isLive: false, isEnded: true, liveViewersFormatted: stats.peak ? Number(stats.peak).toLocaleString() : item.liveViewersFormatted, durationLabel: stats.duration ? `${Math.floor(stats.duration / 60)}:${String(stats.duration % 60).padStart(2, '0')}` : item.durationLabel }; }))).filter((item) => new Date(item.startTimeRaw).getTime() >= keep); }
const html = (value) => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function notificationHtml(items) { return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">${items.map((item) => `<a href="${html(item.videoUrl)}" style="display:block;color:#222;text-decoration:none;margin:16px 0"><div style="border:1px solid #d1e9ff;border-radius:12px;overflow:hidden"><img src="${html(item.thumbnail)}" alt="" style="display:block;width:100%"><div style="padding:12px"><strong>${html(item.startTime)}</strong><h3 style="margin:8px 0">${html(item.title)}</h3><p>${html(item.channelTitle)}</p>${item.changedFields?.length ? `<p style="color:#c62828">変更: ${html(item.changedFields.join('・'))}</p>` : ''}</div></div></a>`).join('')}<p style="color:#999;font-size:12px">※このメールは自動送信されています。</p></div>`; }
async function sendEmail(env, subject, items, senderName) { if (!items.length || !env.RESEND_API_KEY || !env.EMAIL_FROM || !env.NOTIFICATION_EMAIL) return false; const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: `${senderName} <${env.EMAIL_FROM}>`, to: [env.NOTIFICATION_EMAIL], subject, html: notificationHtml(items) }) }); if (!response.ok) throw new Error(`Resend failed: ${response.status}`); return true; }
async function notifyChanges(env, items, history) { const candidates = items.filter((item) => item.notificationKind); const fresh = candidates.filter((item) => item.notificationKind === 'new'); const changed = candidates.filter((item) => item.notificationKind === 'changed'); const sentNew = await sendEmail(env, `新規：${fresh.length}件の配信`, fresh, 'ホロライブ新規配信通知'); const sentChanged = await sendEmail(env, `変更：${changed.length}件の配信`, changed, 'ホロライブ配信変更通知'); if (!sentNew && !sentChanged) return history; const next = { ...history }; candidates.forEach((item) => { next[item.videoId] = { title: item.title, startTimeRaw: item.startTimeRaw, notified: true, everWentLive: Boolean(item.isLive || history[item.videoId]?.everWentLive) }; }); return next; }
async function monitor(env) {
  const now = Date.now();
  const lastRun = await getState(env, 'last_monitor_run', 0);
  if (now - Number(lastRun || 0) < monitorInterval(new Date(now))) return;
  const master = await masters(env); const ids = Object.keys(master.global); const globalIds = new Set(ids);
  const chunks = Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) => ids.slice(index * 50, index * 50 + 50));
  const own = await Promise.all(chunks.map((chunk) => holodex(env, '/live', { channels: chunk.join(','), include: 'mentions', max_upcoming_hours: '336' })));
  const external = await holodex(env, '/live', { org: 'Hololive', include: 'mentions', limit: '50', max_upcoming_hours: '336' });
  const holodexVideos = [...own.flat(), ...external].map((raw) => video(raw, globalIds, master.talentMap)).filter((item) => globalIds.has(item.channelId) || item.guests.length);
  const [previousAllLive, previousAllUpcoming, previousAllEnded, previousUiLive, previousUiUpcoming, previousUiEnded, notificationHistory, processedRssIds, lastYoutubeScan] = await Promise.all([
    getState(env, 'all_live', []), getState(env, 'all_upcoming', []), getState(env, 'all_ended', []), getState(env, 'ui_live', []), getState(env, 'ui_upcoming', []), getState(env, 'ui_ended', []), getState(env, 'notification_history', {}), getState(env, 'processed_rss_ids', []), getState(env, 'last_youtube_scan', 0)
  ]);
  let youtubeVideos = []; let nextProcessed = processedRssIds; let scannedYoutube = false;
  if (env.YOUTUBE_API_KEY && now - Number(lastYoutubeScan || 0) >= youtubeInterval(new Date(now))) {
    const holodexIds = new Set(holodexVideos.map((item) => item.videoId));
    const rss = await rssIds(ids);
    const candidates = new Set(rss.filter((id) => !holodexIds.has(id) && !processedRssIds.includes(id)));
    const oneDayAgo = now - 86400000;
    previousAllUpcoming.forEach((item) => { const time = new Date(item.startTimeRaw).getTime(); if (!holodexIds.has(item.videoId) && (time > now || time >= oneDayAgo)) candidates.add(item.videoId); });
    youtubeVideos = await youtubeDetails(env, [...candidates]);
    const valid = new Set(youtubeVideos.map((item) => item.videoId));
    nextProcessed = [...new Set([...processedRssIds, ...[...candidates].filter((id) => !valid.has(id))])].slice(-5000);
    scannedYoutube = true;
  }
  const all = merge([...holodexVideos, ...youtubeVideos]);
  const favRaw = Object.keys(master.favorites).length ? await holodex(env, '/users/live', { channels: Object.keys(master.favorites).join(',') }) : [];
  const specialRaw = await holodex(env, '/live', { org: 'Hololive', max_upcoming_hours: '336' });
  const favorites = merge([...favRaw.map((raw) => video(raw)), ...specialRaw.filter((raw) => !master.excludes.includes(raw.channel?.id) && isSpecial(raw.title, master.eventKeywords)).map((raw) => ({ ...video(raw), isSpecial: true })), ...all.filter((item) => target(item, master))]);
  const keep = now - 2 * 86400000;
  const classify = (item) => {
    if (!target(item, master)) return { ...item };
    const previous = notificationHistory[item.videoId]; const changes = changedFields(item, previous);
    if (!previous?.notified) return { ...item, notificationKind: 'new', changedFields: changes };
    return { ...item, notificationKind: changes.length ? 'changed' : '', changedFields: changes };
  };
  const classifiedFavorites = favorites.map(classify);
  const split = async (items, previousLive, previousUpcoming, previousEnded) => {
    const live = items.filter((item) => item.isLive); const upcoming = items.filter((item) => !item.isLive && !item.isEnded);
    const disappeared = await endedFrom([...previousLive, ...previousUpcoming], items, env, keep);
    const ended = merge([...items.filter((item) => item.isEnded), ...disappeared, ...previousEnded]).filter((item) => new Date(item.startTimeRaw).getTime() >= keep).sort((a, b) => new Date(b.startTimeRaw) - new Date(a.startTimeRaw));
    return { live, upcoming, ended };
  };
  const [allState, uiState] = await Promise.all([split(all, previousAllLive, previousAllUpcoming, previousAllEnded), split(classifiedFavorites, previousUiLive, previousUiUpcoming, previousUiEnded)]);
  // A notification provider outage must never discard a successful monitor result.
  await setStates(env, { all_live: allState.live, all_upcoming: allState.upcoming, all_ended: allState.ended, ui_live: uiState.live, ui_upcoming: uiState.upcoming, ui_ended: uiState.ended, notification_history: notificationHistory, processed_rss_ids: nextProcessed, last_youtube_scan: scannedYoutube ? now : lastYoutubeScan, last_monitor_run: now });
  try {
    const nextHistory = await notifyChanges(env, classifiedFavorites, notificationHistory);
    if (nextHistory !== notificationHistory) await setState(env, 'notification_history', nextHistory);
  } catch (error) {
    console.error('Notification delivery failed after monitor state was saved.', error);
    await setState(env, 'notification_error', { message: error.message || 'Notification delivery failed', at: new Date(now).toISOString() });
  }
}
async function api(request, env, url) {
  if (url.pathname === '/api/videos') { const all = url.searchParams.get('mode') === 'all'; const master = await masters(env); const [live, upcoming, ended] = await Promise.all([getState(env, all ? 'all_live' : 'ui_live', []), getState(env, all ? 'all_upcoming' : 'ui_upcoming', []), getState(env, all ? 'all_ended' : 'ui_ended', [])]); return json({ videos: all ? [...live, ...upcoming] : [...live, ...upcoming, ...ended], live, upcoming, ended, favorites: Object.keys(master.favorites), ...(all ? { lastUpdate: new Date().toISOString() } : {}) }); }
  if (url.pathname === '/calendar.ics') { const upcoming = await getState(env, 'ui_upcoming', []); const events = upcoming.filter((item) => item.startTimeRaw).map((item) => `BEGIN:VEVENT\r\nUID:${esc(item.videoId)}@hololive-live-monitor\r\nDTSTAMP:${new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}/, '')}\r\nDTSTART:${new Date(item.startTimeRaw).toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}/, '')}\r\nSUMMARY:${esc(item.title)}\r\nURL:${esc(item.videoUrl)}\r\nEND:VEVENT`); return new Response(['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR', ''].join('\r\n'), { headers: { 'content-type': 'text/calendar; charset=utf-8' } }); }
  const favoriteMatch = /^\/api\/favorites\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'PATCH' && favoriteMatch) { const body = await request.json(); if (typeof body.isFavorite !== 'boolean') return json({ error: 'isFavorite must be a boolean' }, 400); const channelId = decodeURIComponent(favoriteMatch[1]); const updated = await updateFavorite(env, channelId, body.isFavorite); return updated ? json({ status: 'success', channelId, isFavorite: body.isFavorite }) : json({ error: 'Channel not found' }, 404); }
  return null;
}
export default {
  async fetch(request, env) { const url = new URL(request.url); try { if (url.pathname === '/health') return json({ status: 'ok' }); if (url.pathname.startsWith('/api/') || url.pathname === '/calendar.ics') { const response = await api(request, env, url); if (response) return response; } return env.ASSETS.fetch(request); } catch (error) { return json({ error: error.message || 'Internal server error' }, 500); } },
  async scheduled(event, env, context) { context.waitUntil(monitor(env)); }
};
