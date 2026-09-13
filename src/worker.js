const TOKYO = 'Asia/Tokyo';
const HOLODEX = 'https://holodex.net/api/v2';
// Workers on the free plan limits the number of subrequests per invocation.
// RSS is a supplemental source, so scan it in small rotating batches.
const RSS_CHANNELS_PER_SCAN = 20;

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const esc = (value) => String(value || '').replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\n', '\\n');
const icalDate = (value) => new Date(value).toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}/, '');
const format = (value, dateOnly = false) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TOKYO, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return dateOnly ? `${parts.month}/${parts.day}` : `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
};

function calendarIcs(videos, { specialOnly = false } = {}) {
  const events = videos.filter((item) => item.startTimeRaw && (!specialOnly || item.isSpecial)).map((item) => {
    const start = new Date(item.startTimeRaw);
    const lines = ['BEGIN:VEVENT', `UID:${esc(`${specialOnly ? 'special-' : ''}${item.videoId}`)}@hololive-live-monitor`, `DTSTAMP:${icalDate(new Date())}`, `DTSTART:${icalDate(start)}`];
    if (specialOnly) lines.push(`DTEND:${icalDate(new Date(start.getTime() + 3600_000))}`);
    lines.push(`SUMMARY:${esc(item.title)}`, `DESCRIPTION:${esc(item.videoUrl)}`);
    if (item.channelTitle) lines.push(`LOCATION:${esc(item.channelTitle)}`);
    lines.push(`URL:${esc(item.videoUrl)}`, 'END:VEVENT');
    return lines.join('\r\n');
  });
  return new Response(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hololive Live Monitor//JP', ...events, 'END:VCALENDAR', ''].join('\r\n'), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="hololive-live.ics"' } });
}

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
  const cached = await getState(env, 'master_cache', null);
  if (cached?.expiresAt > Date.now() && cached.data) return cached.data;
  const [favorites, excludes, words, events, talent, global] = await sheetValues(env, ["'お気に入りチャンネル'!A:C", "'除外チャンネル'!A:B", "'除外ワード'!A:A", "'イベントキーワード'!A:ZZ", "'チャンネル置き換え'!A:B", "'全体チャンネル'!A:B"]);
  const favoriteMap = Object.fromEntries(favorites.slice(1).filter((row) => String(row[2] || '') === '1' && row[1]).map((row) => [String(row[1]).trim(), { name: String(row[0] || '').trim() }]));
  const eventKeywords = Object.fromEntries((events[0] || []).map((title, column) => [title, events.slice(1).map((row) => row[column]).filter(Boolean)]).filter(([title]) => title));
  const data = { favorites: favoriteMap, excludes: excludes.slice(1).map((row) => row[1]).filter(Boolean), excludeWords: words.map((row) => String(row[0] || '').toLowerCase()).filter(Boolean), eventKeywords, talentMap: Object.fromEntries(talent.slice(1).filter((row) => row[0] && row[1])), global: Object.fromEntries(global.slice(1).filter((row) => String(row[1] || '').startsWith('UC')).map((row) => [String(row[1]), { name: row[0] }])) };
  await setState(env, 'master_cache', { expiresAt: Date.now() + 5 * 60_000, data });
  return data;
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
  await setState(env, 'master_cache', null);
  return true;
}
function isSpecial(title, keywords) {
  const text = normalizeTitle(title).replaceAll('#', ' ');
  if ((keywords['その他'] || []).some((word) => text.includes(normalizeTitle(word)))) return null;
  return Object.entries(keywords).find(([category, words]) => category !== 'その他' && words.some((word) => text.includes(normalizeTitle(word))))?.[0] || null;
}
function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = Math.floor(total % 60);
  return [hours || null, hours ? String(minutes).padStart(2, '0') : String(minutes), String(remainingSeconds).padStart(2, '0')].filter((value) => value !== null).join(':');
}
function video(raw, globalIds, talentMap) {
  const start = raw.start_actual || raw.actual_start || raw.start_scheduled || raw.available_at;
  const external = globalIds && !globalIds.has(raw.channel?.id);
  const guests = (raw.mentions || []).filter((mention) => globalIds?.has(mention.id)).map((mention) => ({ name: normalizedTalentName(mention.name, talentMap || {}), icon: mention.photo || '' })).filter((guest, index, list) => list.findIndex((item) => item.name === guest.name) === index);
  return { videoId: raw.id, title: raw.title || '', channelTitle: external ? `(外) ${raw.channel?.name || ''}` : raw.channel?.name || '', channelId: raw.channel?.id || '', channelIcon: raw.channel?.photo || '', thumbnail: `https://i.ytimg.com/vi/${raw.id}/hqdefault.jpg`, videoUrl: `https://www.youtube.com/watch?v=${raw.id}`, viewers: raw.live_viewers || 0, liveViewersFormatted: raw.live_viewers ? Number(raw.live_viewers).toLocaleString() : null, startTimeRaw: start, startTime: start ? format(start) : '未定', dateKey: start ? format(start, true) : '', isLive: raw.status === 'live', isEnded: raw.status === 'past', durationLabel: formatDuration(raw.duration), mentions: raw.mentions || [], guests, source: 'holodex', priority: 1 };
}
async function holodex(env, path, parameters) {
  const url = new URL(`${HOLODEX}${path}`); Object.entries(parameters || {}).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { 'X-APIKEY': env.HOLODEX_API_KEY } }); if (!response.ok) throw new Error(`Holodex failed: ${response.status}`); return response.json();
}
function merge(videos) { const map = new Map(); videos.filter(Boolean).forEach((item) => { const prior = map.get(item.videoId); if (!prior || (item.priority || 1) < (prior.priority || 1)) map.set(item.videoId, { ...item, isSpecial: item.isSpecial || prior?.isSpecial }); }); return [...map.values()]; }
function primaryTarget(item, master) { const ids = new Set(Object.keys(master.favorites)); return Boolean(ids.has(item.channelId) || item.isSpecial || isSpecial(item.title, master.eventKeywords) || (item.mentions || []).some((mention) => ids.has(mention.id))); }
function target(item, master) { if (primaryTarget(item, master)) return true; return Object.values(master.favorites).some((favorite) => favorite.name && item.title?.includes(favorite.name)); }
function shouldInclude(item, master) { if (Object.hasOwn(master.favorites, item.channelId)) return true; const title = normalizeTitle(item.title); if ((master.excludeWords || []).some((word) => title.includes(normalizeTitle(word)))) return false; return !(master.excludes || []).includes(item.channelId); }
function isWithin72Hours(value, now) { const diff = new Date(value).getTime() - now; return diff >= -3 * 3600_000 && diff <= 72 * 3600_000; }
function normalizeTitle(value) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); }
function distance(left, right) { const a = String(left || ''); const b = String(right || ''); if (!a || !b) return Infinity; const row = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i += 1) { let previous = row[0]; row[0] = i; for (let j = 1; j <= b.length; j += 1) { const current = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = current; } } return row[b.length]; }
function changedFields(item, previous) { if (!previous) return []; const changes = []; if (distance(normalizeTitle(item.title), normalizeTitle(previous.title)) >= 3) changes.push('タイトル'); if (new Date(item.startTimeRaw).getTime() !== new Date(previous.startTimeRaw).getTime()) changes.push('開始時刻'); return changes; }
function isoDurationSeconds(value) { const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || ''); return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0; }
function tokyoHour(date = new Date()) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: TOKYO, hour: '2-digit', hourCycle: 'h23' }).format(date)); }
function youtubeInterval(now) { const hour = tokyoHour(now); return hour >= 2 && hour < 7 ? 50 * 60_000 : ((hour < 2 || hour < 15) ? 7.5 * 60_000 : 3.5 * 60_000); }
// Cloudflare Cron's free minimum interval is one minute.  Keep this below 60 seconds
// so each scheduled invocation during the active period performs a monitor run.
function monitorInterval(now) { const hour = tokyoHour(now); return hour >= 10 || hour < 2 ? 55_000 : 15 * 60_000; }
async function mapLimit(values, limit, fn) { let cursor = 0; await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { while (cursor < values.length) { const index = cursor++; await fn(values[index]); } })); }
async function rssIds(channelIds) { const ids = new Set(); await mapLimit(channelIds, 15, async (channelId) => { try { const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`); if (!response.ok) return; for (const match of (await response.text()).matchAll(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/g)) ids.add(match[1]); } catch { /* A single RSS failure is non-fatal. */ } }); return [...ids]; }
function rotatingBatch(values, cursor, size) {
  if (!values.length) return [];
  const start = ((Number(cursor) || 0) % values.length + values.length) % values.length;
  return Array.from({ length: Math.min(size, values.length) }, (_, index) => values[(start + index) % values.length]);
}
async function youtubeDetails(env, ids) { if (!env.YOUTUBE_API_KEY || !ids.length) return []; const chunks = Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) => ids.slice(i * 50, i * 50 + 50)); const cutoff = Date.now() + 14 * 86400000; const results = await Promise.all(chunks.map(async (chunk) => { const query = new URLSearchParams({ part: 'snippet,liveStreamingDetails', id: chunk.join(','), key: env.YOUTUBE_API_KEY }); const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${query}`); if (!response.ok) throw new Error(`YouTube API failed: ${response.status}`); return (await response.json()).items || []; })); return results.flat().flatMap((item) => { const details = item.liveStreamingDetails; const live = item.snippet?.liveBroadcastContent === 'live'; const ended = item.snippet?.liveBroadcastContent === 'none' && Boolean(details?.actualEndTime); if (!details || ended) return []; const startTimeRaw = details.actualStartTime || details.scheduledStartTime || item.snippet?.publishedAt; if (!live && new Date(startTimeRaw).getTime() > cutoff) return []; return [{ videoId: item.id, title: item.snippet?.title || '', channelTitle: item.snippet?.channelTitle || '', channelId: item.snippet?.channelId || '', channelIcon: item.snippet?.thumbnails?.default?.url || '', thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`, videoUrl: `https://www.youtube.com/watch?v=${item.id}`, viewers: Number(details.concurrentViewers || 0), liveViewersFormatted: details.concurrentViewers ? Number(details.concurrentViewers).toLocaleString() : null, startTimeRaw, startTime: format(startTimeRaw), dateKey: format(startTimeRaw, true), isLive: live, isEnded: false, mentions: [], guests: [], source: 'youtube_api', priority: 3 }]; }); }
function updateViewerBuffer(buffer, liveVideos, now) {
  const threshold = now - 12 * 3600_000;
  const next = Object.fromEntries(Object.entries(buffer || {}).filter(([, value]) => Number(value?.time || 0) >= threshold));
  liveVideos.forEach((item) => {
    const viewers = Number(item.viewers || String(item.liveViewersFormatted || '').replaceAll(',', '') || 0);
    const previous = next[item.videoId] || {};
    next[item.videoId] = { peak: Math.max(Number(previous.peak || 0), viewers), time: now };
  });
  return next;
}
async function syncViewerBufferSheet(env, liveVideos, now) {
  if (!liveVideos.length) return;
  try {
    const token = await googleToken(env);
    const range = "'同接バッファ'!A:D";
    const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEETS_ID)}/values/${encodeURIComponent(range)}`;
    const readResponse = await fetch(readUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!readResponse.ok) throw new Error(`Google Sheets buffer read failed: ${readResponse.status}`);
    const raw = (await readResponse.json()).values || [];
    const header = raw[0]?.length ? raw[0] : ['videoId', 'title', 'peakViewers', 'updatedAt'];
    const rows = raw.length > 1 ? raw.slice(1) : [];
    const indexByVideoId = new Map(rows.map((row, index) => [String(row[0] || ''), index]).filter(([videoId]) => videoId));
    const updatedAt = new Date(now).toLocaleString('ja-JP', { timeZone: TOKYO }); let changed = false;
    liveVideos.forEach((item) => {
      const videoId = String(item.videoId || ''); if (!videoId) return;
      const viewers = Number(item.viewers || String(item.liveViewersFormatted || '').replaceAll(',', '') || 0);
      const index = indexByVideoId.get(videoId);
      if (index === undefined) { rows.push([videoId, item.title || '不明な配信', viewers, updatedAt]); indexByVideoId.set(videoId, rows.length - 1); changed = true; return; }
      const previousPeak = Number(rows[index][2] || 0);
      if (viewers > previousPeak) { rows[index] = [videoId, item.title || '不明な配信', viewers, updatedAt]; changed = true; }
    });
    if (!changed) return;
    const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEETS_ID)}/values/${encodeURIComponent("'同接バッファ'!A1")}?valueInputOption=RAW`;
    const writeResponse = await fetch(writeUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ values: [header, ...rows] }) });
    if (!writeResponse.ok) throw new Error(`Google Sheets buffer write failed: ${writeResponse.status}`);
  } catch (error) { console.error('Viewer buffer sheet sync failed.', error); }
}
async function cleanupOldBufferSheet(env, now = Date.now()) {
  const token = await googleToken(env);
  const range = "'同接バッファ'!A:D";
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEETS_ID)}/values/${encodeURIComponent(range)}`;
  const readResponse = await fetch(baseUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!readResponse.ok) throw new Error(`Google Sheets buffer cleanup read failed: ${readResponse.status}`);
  const raw = (await readResponse.json()).values || [];
  if (raw.length <= 1) return;
  const header = raw[0];
  const border = now - 12 * 3600_000;
  // GAS kept rows whose timestamp could not be parsed; preserve that behavior.
  const remaining = raw.slice(1).filter((row) => {
    const timestamp = new Date(row[3]).getTime();
    return Number.isNaN(timestamp) || timestamp >= border;
  });
  if (remaining.length === raw.length - 1) return;
  const clearResponse = await fetch(`${baseUrl}:clear`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  if (!clearResponse.ok) throw new Error(`Google Sheets buffer cleanup clear failed: ${clearResponse.status}`);
  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEETS_ID)}/values/${encodeURIComponent("'同接バッファ'!A1")}?valueInputOption=RAW`;
  const writeResponse = await fetch(writeUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ values: [header, ...remaining] }) });
  if (!writeResponse.ok) throw new Error(`Google Sheets buffer cleanup write failed: ${writeResponse.status}`);
}
async function autoCleanupNotificationHistory(env, now = Date.now()) {
  const history = await getState(env, 'notification_history', {});
  const border = now - 3 * 86400_000;
  const cleaned = Object.fromEntries(Object.entries(history).filter(([, item]) => {
    const start = new Date(item?.startTimeRaw || item?.startTime || '').getTime();
    return Number.isFinite(start) && start >= border;
  }));
  if (Object.keys(cleaned).length !== Object.keys(history).length) await setState(env, 'notification_history', cleaned);
}
async function runPeriodicMaintenance(env, key, intervalMs, task, now = Date.now()) {
  const previous = await getState(env, key, 0);
  if (now - Number(previous || 0) < intervalMs) return false;
  await task();
  await setState(env, key, now);
  return true;
}
async function archiveStats(env, videoId, fallback, bufferedPeak = 0) { const [youtube, detail] = await Promise.allSettled([async () => { if (!env.YOUTUBE_API_KEY) return 0; const query = new URLSearchParams({ part: 'contentDetails', id: videoId, key: env.YOUTUBE_API_KEY }); const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${query}`); return response.ok ? isoDurationSeconds((await response.json()).items?.[0]?.contentDetails?.duration) : 0; }, holodex(env, `/videos/${encodeURIComponent(videoId)}`)]); const peak = Number(bufferedPeak) || Number(detail.status === 'fulfilled' ? detail.value?.live_viewers : 0) || Number(String(fallback.liveViewersFormatted || 0).replaceAll(',', '')) || 0; return { duration: youtube.status === 'fulfilled' ? youtube.value : 0, peak }; }
async function endedFrom(previous, current, env, keep, viewerBuffer = {}) { const currentIds = new Set(current.map((item) => item.videoId)); const candidates = previous.filter((item) => !currentIds.has(item.videoId) && new Date(item.startTimeRaw).getTime() <= Date.now()); return (await Promise.all(candidates.map(async (item) => { const stats = await archiveStats(env, item.videoId, item, viewerBuffer[item.videoId]?.peak); return { ...item, isLive: false, isEnded: true, liveViewersFormatted: stats.peak ? Number(stats.peak).toLocaleString() : item.liveViewersFormatted, durationLabel: stats.duration ? formatDuration(stats.duration) : item.durationLabel }; }))).filter((item) => new Date(item.startTimeRaw).getTime() >= keep); }
const html = (value) => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const formatDate = (value) => format(value, true);
const formatHour = (value) => format(value).slice(6, 8);
const normalizedTalentName = (name, talentMap = {}) => {
  const raw = String(name || '');
  if (talentMap[raw]) return talentMap[raw];
  const japanese = raw.match(/[ぁ-んァ-ン一-龥々〆ヵヶ]+/g);
  return japanese ? japanese.join('') : raw;
};

function notificationTarget(item, master) {
  const favoriteIds = new Set(Object.keys(master.favorites));
  return Boolean(item.isSpecial || favoriteIds.has(item.channelId) || (item.mentions || []).some((mention) => favoriteIds.has(mention.id)));
}

function shouldSendChanged(item, now) {
  if (item.changedFields?.includes('タイトル')) return true;
  if (!item.changedFields?.includes('開始時刻') || !item.startTimeRaw) return true;
  return new Date(item.startTimeRaw).getTime() > now;
}

function subjectSummary(items, kind, talentMap) {
  const names = items.map((item) => normalizedTalentName(item.channelTitle, talentMap));
  if (items.length === 1) {
    const item = items[0];
    if (kind === 'new') return `${names[0]} 「${item.title}」`;
    if (item.changedFields?.includes('開始時刻')) return `${names[0]} 開始時間変更 (${item.startTime})`;
    if (item.changedFields?.includes('タイトル')) return `${names[0]} タイトル変更`;
    return `${names[0]} 更新`;
  }
  const uniqueNames = [...new Set(names)].slice(0, 2);
  const more = new Set(names).size - uniqueNames.length;
  return `${uniqueNames.join('・')}${more > 0 ? ` ほか${more}名` : ''} 計${items.length}件`;
}

function specialKeyword(title, eventKeywords) {
  const lower = String(title || '').toLowerCase();
  for (const [category, words] of Object.entries(eventKeywords || {})) {
    if (category === 'その他') continue;
    const word = (words || []).find((value) => lower.includes(String(value).toLowerCase()));
    if (word) return word;
  }
  return '';
}

function changeDetail(item) {
  const previous = item.previous;
  if (!previous || !item.changedFields?.length) return '';
  const lines = [];
  if (item.changedFields.includes('タイトル')) lines.push(`タイトル: 「${previous.title || ''}」 → 「${item.title}」`);
  if (item.changedFields.includes('開始時刻')) lines.push(`開始時刻: ${format(previous.startTimeRaw)} → ${item.startTime}`);
  return lines.length ? `<div style="font-size:14px;color:#d00;margin:6px 0 10px;line-height:1.4">${lines.map(html).join('<br>')}</div>` : '';
}

function notificationCard(item, master) {
  const favoriteIds = new Set(Object.keys(master.favorites));
  const guestNames = (item.mentions || []).filter((mention) => favoriteIds.has(mention.id)).map((mention) => normalizedTalentName(mention.name, master.talentMap));
  const labels = `${item.notificationKind === 'new' ? '<span style="position:absolute;left:8px;top:8px;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;background:#fff;color:#2e7d32;border:1px solid #2e7d32">NEW</span>' : ''}${item.changedFields?.length ? '<span style="position:absolute;left:8px;top:8px;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;background:#fff9c4;color:#ef6c00;border:1px solid #ef6c00">変更</span>' : ''}`;
  const guests = guestNames.length ? `<div style="font-size:14px;color:#555;margin-bottom:6px">参加: ${html(guestNames.join('・'))}</div>` : '';
  const keyword = specialKeyword(item.title, master.eventKeywords);
  const special = keyword ? `<div style="display:inline-block;background:#ffebee;color:#c62828;padding:2px 8px;border-radius:4px;font-size:13px;margin-top:8px;font-weight:bold">${html(keyword)}</div>` : '';
  return `<a href="${html(item.videoUrl)}" target="_blank" style="text-decoration:none;color:inherit;display:block;margin-bottom:16px"><div style="background:#f0f7ff;padding:12px;border-radius:12px;border:1px solid #d1e9ff"><div style="background:#fff;border-radius:8px;overflow:hidden"><div style="position:relative;width:100%;line-height:0"><img src="${html(item.thumbnail)}" alt="" style="width:100%;height:auto;display:block">${labels}</div><div style="padding:12px"><div style="font-size:14px;font-weight:bold;color:#1976d2;margin-bottom:4px">${html(item.startTime)}</div><div style="font-size:16px;font-weight:bold;line-height:1.4;margin-bottom:8px;color:#333">${html(item.title)}</div>${changeDetail(item)}${guests}${special}</div></div></div></a>`;
}

function notificationHtml(items, master) {
  const byDate = new Map();
  items.forEach((item) => { const key = formatDate(item.startTimeRaw); byDate.set(key, [...(byDate.get(key) || []), item]); });
  const weekday = ['日', '月', '火', '水', '木', '金', '土'];
  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:500px;margin:0 auto;color:#333">${[...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, dateItems]) => {
    const [month, day] = date.split('/').map(Number);
    const dateWithYear = new Date(Date.UTC(new Date().getFullYear(), month - 1, day));
    const byHour = new Map(); dateItems.forEach((item) => { const hour = formatHour(item.startTimeRaw); byHour.set(hour, [...(byHour.get(hour) || []), item]); });
    return `<div style="background:#ff9800;color:#fff;padding:8px 12px;margin:24px 0 12px;border-radius:6px;font-size:16px;font-weight:bold;display:inline-block">📅 ${date}（${weekday[dateWithYear.getUTCDay()]}）</div>${[...byHour.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([hour, hourItems]) => `<div style="border-left:4px solid #4da3ff;padding-left:8px;margin:16px 0 12px;font-size:15px;font-weight:bold;color:#1976d2">${hour}:00 ～</div>${hourItems.map((item) => notificationCard(item, master)).join('')}`).join('')}`;
  }).join('')}<div style="text-align:center;margin-top:20px;padding-top:20px;border-top:1px solid #eee;font-size:12px;color:#999">※このメールは自動送信されています。</div></div>`;
}

async function sendEmail(env, subject, items, senderName, master) {
  if (!items.length || !env.RESEND_API_KEY || !env.EMAIL_FROM || !env.NOTIFICATION_EMAIL) return false;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: `${senderName} <${env.EMAIL_FROM}>`, to: [env.NOTIFICATION_EMAIL], subject, html: notificationHtml(items, master) }) });
  if (!response.ok) throw new Error(`Resend failed: ${response.status}`);
  return true;
}

function updateNotificationHistory(history, items) {
  const next = { ...history };
  items.forEach((item) => {
    const previous = next[item.videoId] || {};
    next[item.videoId] = { ...previous, title: item.title, startTimeRaw: item.startTimeRaw, channelTitle: item.channelTitle, channelPhoto: item.channelIcon || previous.channelPhoto || '', mentions: item.mentions || previous.mentions || [], isLive: Boolean(item.isLive), notified: true, everWentLive: Boolean(item.isLive || previous.everWentLive) };
  });
  const threshold = Date.now() - 7 * 86400000;
  return Object.fromEntries(Object.entries(next).filter(([, item]) => new Date(item.startTimeRaw).getTime() >= threshold));
}

async function notifyChanges(env, items, history, master) {
  const now = Date.now();
  const candidates = items.filter((item) => item.notificationKind && notificationTarget(item, master));
  const fresh = candidates.filter((item) => item.notificationKind === 'new');
  const changed = candidates.filter((item) => item.notificationKind === 'changed' && shouldSendChanged(item, now));
  const sentNew = await sendEmail(env, `新規：${subjectSummary(fresh, 'new', master.talentMap)}`, fresh, 'ホロライブ新規配信通知', master);
  const sentChanged = await sendEmail(env, `変更：${subjectSummary(changed, 'changed', master.talentMap)}`, changed, 'ホロライブ配信変更通知', master);
  if ((fresh.length && !sentNew) || (changed.length && !sentChanged)) return history;
  return updateNotificationHistory(history, items);
}

function tokyoMinute(date = new Date()) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: TOKYO, minute: '2-digit' }).format(date)); }
function startNotificationHtml(items) {
  const grouped = new Map();
  [...items].sort((left, right) => new Date(left.startTimeRaw) - new Date(right.startTimeRaw)).forEach((item) => {
    const key = format(item.startTimeRaw); grouped.set(key, [...(grouped.get(key) || []), item]);
  });
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">${[...grouped.entries()].map(([time, videos]) => `<div style="margin-top:20px;margin-bottom:10px"><span style="background:#00e6ff;border-left:6px solid #00acc1;padding:6px 12px;border-radius:6px;font-size:18px;font-weight:bold;color:#000">🕒 ${html(time)} 開始</span></div><div style="display:flex;flex-wrap:wrap;gap:10px;background:rgba(0,230,255,.05);padding:12px;border-radius:12px">${videos.map((item) => `<a href="${html(item.videoUrl)}" target="_blank" style="text-decoration:none;color:#000;width:48%;min-width:160px"><div style="background:#fff;border-radius:10px;overflow:hidden;border:1px solid #ddd;height:100%"><img src="https://i.ytimg.com/vi/${html(item.videoId)}/mqdefault.jpg" alt="" style="width:100%;display:block"><div style="padding:8px"><div style="font-size:12px;font-weight:bold;line-height:1.3;height:2.6em;overflow:hidden;margin-bottom:4px">${html(item.title)}</div><div style="font-size:11px;color:#666;margin-bottom:4px">${html(item.channelTitle)}</div><div style="font-size:10px;color:#d32f2f;background:#fff0f0;padding:2px 4px;border-radius:4px;display:inline-block">${html(item.passReason || '')}</div></div></div></a>`).join('')}</div>`).join('')}<p style="color:#999;font-size:12px">※このメールは自動送信されています。</p></div>`;
}
async function sendStartEmail(env, subject, items, senderName) {
  if (!items.length || !env.RESEND_API_KEY || !env.EMAIL_FROM || !env.NOTIFICATION_EMAIL) return false;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: `${senderName} <${env.EMAIL_FROM}>`, to: [env.NOTIFICATION_EMAIL], subject, html: startNotificationHtml(items) }) });
  if (!response.ok) throw new Error(`Resend failed: ${response.status}`);
  return true;
}
function imminentReason(item, master) {
  const favoriteIds = new Set(Object.keys(master.favorites));
  const reasons = [];
  if (favoriteIds.has(item.channelId)) reasons.push('★お気に入り');
  if (item.isSpecial || isSpecial(item.title, master.eventKeywords)) reasons.push('◆記念配信');
  const guests = (item.mentions || []).filter((mention) => favoriteIds.has(mention.id) && mention.id !== item.channelId);
  guests.forEach((guest) => reasons.push(`●ゲスト(連携:${guest.name})`));
  const ownerName = master.favorites[item.channelId]?.name || '';
  const namedGuest = Object.values(master.favorites).map(({ name }) => name).find((name) => name && name !== ownerName && item.title.includes(name));
  if (namedGuest && !guests.some((guest) => guest.name === namedGuest)) reasons.push(`●ゲスト(タイトル:${namedGuest})`);
  return reasons.join('');
}
async function notifyJustBeforeStart(env) {
  const now = Date.now(); const minute = tokyoMinute(new Date(now));
  const isTargetWindow = (minute >= 25 && minute <= 30) || minute >= 55 || minute === 0;
  if (!isTargetWindow) return;
  const isScheduledWindow = (minute >= 29 && minute <= 30) || minute >= 59 || minute === 0;
  try {
    const master = await masters(env); const favoriteIds = Object.keys(master.favorites);
    const [history, favoriteRaw, specialRaw] = await Promise.all([
      getState(env, 'imminent_notification_history', {}),
      favoriteIds.length ? holodex(env, '/users/live', { channels: favoriteIds.join(',') }) : [],
      holodex(env, '/live', { org: 'Hololive', max_upcoming_hours: '336' })
    ]);
    const cleanedHistory = Object.fromEntries(Object.entries(history).filter(([, value]) => Number(value?.time || 0) > now - 24 * 3600_000));
    const specials = specialRaw.filter((raw) => !master.excludes.includes(raw.channel?.id) && isSpecial(raw.title, master.eventKeywords)).map((raw) => ({ ...video(raw), isSpecial: true }));
    const candidates = merge([...favoriteRaw.map((raw) => video(raw)), ...specials]).sort((left, right) => new Date(left.startTimeRaw) - new Date(right.startTimeRaw));
    const early = []; const scheduled = [];
    candidates.forEach((item) => {
      const reason = imminentReason(item, master); if (!reason || cleanedHistory[item.videoId]?.notified_imminent) return;
      const diffMinutes = (new Date(item.startTimeRaw).getTime() - now) / 60_000; const withReason = { ...item, passReason: reason };
      if (item.isLive || (diffMinutes <= 0 && diffMinutes >= -15)) early.push(withReason);
      else if (diffMinutes > 0 && diffMinutes <= 20 && isScheduledWindow) scheduled.push(withReason);
    });
    const next = { ...cleanedHistory };
    for (const item of early) {
      const sent = await sendStartEmail(env, `⚡【開始済み通知】${item.channelTitle} が配信を開始しました（前倒し/フライング）`, [item], 'ホロライブ緊急通知');
      if (sent) next[item.videoId] = { time: now, notified_imminent: true };
    }
    if (scheduled.length) {
      const sent = await sendStartEmail(env, `🔔 配信開始: ${scheduled.length}件の注目配信`, scheduled, '配信開始通知');
      if (sent) scheduled.forEach((item) => { next[item.videoId] = { time: now, notified_imminent: true }; });
    }
    if (JSON.stringify(next) !== JSON.stringify(history)) await setState(env, 'imminent_notification_history', next);
  } catch (error) {
    console.error('Imminent notification failed.', error);
    await setState(env, 'imminent_notification_error', { message: error.message || 'Imminent notification failed', at: new Date(now).toISOString() });
  }
}
async function monitor(env) {
  const now = Date.now();
  const lastRun = await getState(env, 'last_monitor_run', 0);
  if (now - Number(lastRun || 0) < monitorInterval(new Date(now))) return;
  const master = await masters(env); const ids = Object.keys(master.global); const globalIds = new Set(ids);
  const chunks = Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) => ids.slice(index * 50, index * 50 + 50));
  const own = await Promise.all(chunks.map((chunk) => holodex(env, '/live', { channels: chunk.join(','), include: 'mentions', max_upcoming_hours: '336' })));
  const external = await holodex(env, '/live', { org: 'Hololive', include: 'mentions', limit: '50', max_upcoming_hours: '336' });
  const holodexVideos = [...own.flat(), ...external].map((raw) => video(raw, globalIds, master.talentMap)).filter((item) => (globalIds.has(item.channelId) || item.guests.length) && shouldInclude(item, master));
  const [previousAllLive, previousAllUpcoming, previousAllEnded, previousUiLive, previousUiUpcoming, previousUiEnded, notificationHistory, processedRssIds, lastYoutubeScan, rssCursor, viewerBuffer] = await Promise.all([
    getState(env, 'all_live', []), getState(env, 'all_upcoming', []), getState(env, 'all_ended', []), getState(env, 'ui_live', []), getState(env, 'ui_upcoming', []), getState(env, 'ui_ended', []), getState(env, 'notification_history', {}), getState(env, 'processed_rss_ids', []), getState(env, 'last_youtube_scan', 0), getState(env, 'rss_channel_cursor', 0), getState(env, 'viewer_buffer', {})
  ]);
  let youtubeVideos = []; let nextProcessed = processedRssIds; let nextRssCursor = rssCursor; let scannedYoutube = false;
  if (env.YOUTUBE_API_KEY && now - Number(lastYoutubeScan || 0) >= youtubeInterval(new Date(now))) {
    const holodexIds = new Set(holodexVideos.map((item) => item.videoId));
    const rssChannels = rotatingBatch(ids, rssCursor, RSS_CHANNELS_PER_SCAN);
    const rss = await rssIds(rssChannels);
    const candidates = new Set(rss.filter((id) => !holodexIds.has(id) && !processedRssIds.includes(id)));
    const oneDayAgo = now - 86400000;
    previousAllUpcoming.forEach((item) => { const time = new Date(item.startTimeRaw).getTime(); if (!holodexIds.has(item.videoId) && (time > now || time >= oneDayAgo)) candidates.add(item.videoId); });
    youtubeVideos = await youtubeDetails(env, [...candidates]);
    const valid = new Set(youtubeVideos.map((item) => item.videoId));
    nextProcessed = [...new Set([...processedRssIds, ...[...candidates].filter((id) => !valid.has(id))])].slice(-5000);
    nextRssCursor = ids.length ? (Number(rssCursor || 0) + rssChannels.length) % ids.length : 0;
    scannedYoutube = true;
  }
  const all = merge([...holodexVideos, ...youtubeVideos]).filter((item) => shouldInclude(item, master));
  const favRaw = Object.keys(master.favorites).length ? await holodex(env, '/users/live', { channels: Object.keys(master.favorites).join(',') }) : [];
  const specialRaw = await holodex(env, '/live', { org: 'Hololive', max_upcoming_hours: '336' });
  const favorites = merge([...favRaw.map((raw) => video(raw)), ...specialRaw.filter((raw) => !master.excludes.includes(raw.channel?.id) && isSpecial(raw.title, master.eventKeywords)).map((raw) => ({ ...video(raw), isSpecial: true })), ...all.filter((item) => primaryTarget(item, master))]);
  const keep = now - 2 * 86400000;
  const favoriteIds = new Set(Object.keys(master.favorites));
  const classify = (item) => {
    const previous = notificationHistory[item.videoId];
    if (!favoriteIds.has(item.channelId) && !item.isSpecial && !isWithin72Hours(item.startTimeRaw, now) && !item.isLive) return { ...item, previous, notificationKind: '', changedFields: [] };
    const changes = changedFields(item, previous);
    if (!previous?.notified) return { ...item, previous, notificationKind: 'new', changedFields: changes };
    return { ...item, previous, notificationKind: changes.length ? 'changed' : '', changedFields: changes };
  };
  const classifiedFavorites = favorites.map(classify);
  const split = async (items, previousLive, previousUpcoming, previousEnded) => {
    const live = items.filter((item) => item.isLive); const upcoming = items.filter((item) => !item.isLive && !item.isEnded);
    const disappeared = await endedFrom([...previousLive, ...previousUpcoming], items, env, keep, viewerBuffer);
    const ended = merge([...items.filter((item) => item.isEnded), ...disappeared, ...previousEnded]).filter((item) => new Date(item.startTimeRaw).getTime() >= keep).sort((a, b) => new Date(b.startTimeRaw) - new Date(a.startTimeRaw));
    return { live, upcoming, ended };
  };
  const [allState, uiState] = await Promise.all([split(all, previousAllLive, previousAllUpcoming, previousAllEnded), split(classifiedFavorites, previousUiLive, previousUiUpcoming, previousUiEnded)]);
  await syncViewerBufferSheet(env, allState.live, now);
  // A notification provider outage must never discard a successful monitor result.
  await setStates(env, { all_live: allState.live, all_upcoming: allState.upcoming, all_ended: allState.ended, ui_live: uiState.live, ui_upcoming: uiState.upcoming, ui_ended: uiState.ended, notification_history: notificationHistory, processed_rss_ids: nextProcessed, rss_channel_cursor: scannedYoutube ? nextRssCursor : rssCursor, last_youtube_scan: scannedYoutube ? now : lastYoutubeScan, viewer_buffer: updateViewerBuffer(viewerBuffer, allState.live, now), last_monitor_run: now, monitor_error: null });
  try {
    const nextHistory = await notifyChanges(env, classifiedFavorites, notificationHistory, master);
    if (nextHistory !== notificationHistory) await setState(env, 'notification_history', nextHistory);
  } catch (error) {
    console.error('Notification delivery failed after monitor state was saved.', error);
    await setState(env, 'notification_error', { message: error.message || 'Notification delivery failed', at: new Date(now).toISOString() });
  }
}
async function api(request, env, url) {
  const legacyAction = url.searchParams.get('action');
  const legacyAll = url.pathname === '/' && url.searchParams.get('mode') === 'all';
  if (url.pathname === '/api/videos' || legacyAll) {
    const all = url.searchParams.get('mode') === 'all'; const master = await masters(env);
    const [live, upcoming, ended, monitorError] = await Promise.all([getState(env, all ? 'all_live' : 'ui_live', []), getState(env, all ? 'all_upcoming' : 'ui_upcoming', []), getState(env, all ? 'all_ended' : 'ui_ended', []), getState(env, 'monitor_error', null)]);
    const videos = all ? [...live, ...upcoming] : [...live, ...upcoming, ...ended];
    if (!all && monitorError?.message) videos.unshift({ isSystemError: true, message: monitorError.message, timestamp: Date.now() });
    return json({ videos, live, upcoming, ended, favorites: Object.keys(master.favorites), ...(all ? { lastUpdate: new Date().toISOString() } : {}) });
  }
  if ((url.pathname === '/calendar.ics' || url.pathname === '/') && (url.pathname === '/calendar.ics' || url.searchParams.get('mode') === 'special' || url.searchParams.get('type') === 'ical')) {
    const upcoming = await getState(env, 'ui_upcoming', []);
    return calendarIcs(upcoming, { specialOnly: url.searchParams.get('mode') === 'special' || url.searchParams.get('type') === 'ical' });
  }
  if ((request.method === 'GET' && url.pathname === '/api/favorites') || legacyAction === 'getFavorites') {
    const master = await masters(env); return json(Object.keys(master.favorites));
  }
  const favoriteMatch = /^\/api\/favorites\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'PATCH' && favoriteMatch) { const body = await request.json(); if (typeof body.isFavorite !== 'boolean') return json({ error: 'isFavorite must be a boolean' }, 400); const channelId = decodeURIComponent(favoriteMatch[1]); const updated = await updateFavorite(env, channelId, body.isFavorite); return updated ? json({ status: 'success', channelId, isFavorite: body.isFavorite }) : json({ error: 'Channel not found' }, 404); }
  if (legacyAction === 'toggleFavorite') {
    const channelId = url.searchParams.get('channelId'); const isFavorite = url.searchParams.get('isFavorite') === 'true';
    if (!channelId) return json({ error: 'channelId is required' }, 400);
    const updated = await updateFavorite(env, channelId, isFavorite);
    return updated ? json({ status: 'success', channelId, isFavorite }) : json({ error: 'Channel not found' }, 404);
  }
  return null;
}
export default {
  async fetch(request, env) { const url = new URL(request.url); try { if (url.pathname === '/health') return json({ status: 'ok' }); if (url.pathname.startsWith('/api/') || url.pathname === '/calendar.ics' || (url.pathname === '/' && (url.searchParams.has('action') || url.searchParams.get('mode') === 'all' || url.searchParams.get('mode') === 'special' || url.searchParams.get('type') === 'ical'))) { const response = await api(request, env, url); if (response) return response; } return env.ASSETS.fetch(request); } catch (error) { return json({ error: error.message || 'Internal server error' }, 500); } },
  async scheduled(event, env, context) {
    context.waitUntil((async () => {
      const attemptedAt = new Date().toISOString();
      const now = Date.now();
      // These were separate GAS triggers.  Keep them independent of monitor
      // success so a temporary API outage cannot postpone housekeeping.
      for (const [key, interval, task] of [
        ['last_buffer_sheet_cleanup', 12 * 3600_000, () => cleanupOldBufferSheet(env, now)],
        ['last_notification_history_cleanup', 24 * 3600_000, () => autoCleanupNotificationHistory(env, now)]
      ]) {
        try { await runPeriodicMaintenance(env, key, interval, task, now); }
        catch (error) {
          console.error('Scheduled maintenance failed.', error);
          await setState(env, 'maintenance_error', { message: error.message || 'Scheduled maintenance failed', at: attemptedAt });
        }
      }
      try {
        // Keep a lightweight heartbeat so a failed first run is distinguishable
        // from a cron trigger that has not executed yet.
        await setState(env, 'last_monitor_attempt', { at: attemptedAt });
        await monitor(env);
        await notifyJustBeforeStart(env);
      } catch (error) {
        console.error('Scheduled monitor failed.', error);
        await setState(env, 'monitor_error', {
          message: error.message || 'Scheduled monitor failed',
          at: attemptedAt
        });
      }
    })());
  }
};
