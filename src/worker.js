const TOKYO = 'Asia/Tokyo';
const HOLODEX = 'https://holodex.net/api/v2';
// Workers on the free plan limits the number of subrequests per invocation.
// RSS is a supplemental source, so scan it in small rotating batches.
const RSS_CHANNELS_PER_SCAN = 20;
// RSS discovers newly published videos. Holodex remains responsible for
// collaboration metadata, which can be added after a stream has started.
// Keep this modest because the free Worker also performs 20 RSS requests.
const HOLODEX_GUEST_DETAILS_PER_RUN = { live: 4, upcoming: 3, ended: 1 };

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
async function setStatesIfChanged(env, values, current = {}) {
  const changed = Object.entries(values).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key]));
  if (!changed.length) return;
  await env.DB.batch(changed.map(([key, value]) => env.DB.prepare('INSERT INTO app_state (state_key, state_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value, updated_at = CURRENT_TIMESTAMP').bind(key, JSON.stringify(value))));
}

// D1 is the source of truth for operational data. app_state is intentionally
// retained only for small cursors and compatibility during this migration.
async function queryAll(env, sql, ...bindings) { return (await env.DB.prepare(sql).bind(...bindings).all()).results || []; }
const operationalReadyCache = new WeakMap();
async function operationalReady(env) {
  // A single invocation used to issue this probe more than ten times. The
  // schema cannot change during an invocation, so one probe is enough.
  if (!operationalReadyCache.has(env)) operationalReadyCache.set(env, env.DB.prepare('SELECT 1 FROM channels LIMIT 1').first().then(() => true).catch(() => false));
  return operationalReadyCache.get(env);
}
const externalClassificationReadyCache = new WeakMap();
async function externalClassificationReady(env) {
  if (!externalClassificationReadyCache.has(env)) externalClassificationReadyCache.set(env, env.DB.prepare('SELECT 1 FROM external_channel_classifications LIMIT 1').first().then(() => true).catch(() => false));
  return externalClassificationReadyCache.get(env);
}
function statusOf(item) { return item.isEnded ? 'ended' : item.isLive ? 'live' : 'upcoming'; }
async function readVideoState(env, scope, status) {
  if (!await operationalReady(env)) return null;
  const rows = await queryAll(env, `SELECT v.data_json FROM video_states s JOIN videos v ON v.video_id = s.video_id WHERE s.scope = ? AND s.status = ? ORDER BY COALESCE(v.start_time, '') ${status === 'ended' ? 'DESC' : 'ASC'}`, scope, status);
  return rows.flatMap((row) => { try { return [JSON.parse(row.data_json)]; } catch { return []; } });
}
function durableVideo(item) {
  // These fields are used only while deciding whether to notify. Keeping them
  // in the canonical record makes the same video look changed in the all/ui
  // scopes and causes an unnecessary second write.
  const { previous, notificationKind, changedFields, passReason, ...video } = item;
  return video;
}
function upsertVideo(env, item, now, dataJson = JSON.stringify(durableVideo(item))) {
  const status = statusOf(item);
  const peak = Number(item.viewers || String(item.liveViewersFormatted || '').replaceAll(',', '') || 0);
  return env.DB.prepare(`INSERT INTO videos (video_id, title, channel_id, channel_title, video_url, thumbnail, start_time, status, is_special, peak_viewers, duration_seconds, data_json, first_seen_at, last_seen_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET title=excluded.title, channel_id=excluded.channel_id, channel_title=excluded.channel_title, video_url=excluded.video_url, thumbnail=excluded.thumbnail, start_time=excluded.start_time, status=excluded.status, is_special=excluded.is_special, peak_viewers=MAX(videos.peak_viewers, excluded.peak_viewers), data_json=excluded.data_json, last_seen_at=excluded.last_seen_at, ended_at=COALESCE(videos.ended_at, excluded.ended_at)`)
    .bind(item.videoId, item.title || '', item.channelId || '', item.channelTitle || '', item.videoUrl || '', item.thumbnail || '', item.startTimeRaw || null, status, item.isSpecial ? 1 : 0, peak, dataJson, now, now, status === 'ended' ? now : null);
}
async function storedVideos(env, ids) {
  const rows = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    if (!chunk.length) continue;
    rows.push(...await queryAll(env, `SELECT video_id, data_json FROM videos WHERE video_id IN (${chunk.map(() => '?').join(',')})`, ...chunk));
  }
  return new Map(rows.map((row) => [row.video_id, row.data_json]));
}
async function runStatements(env, statements) {
  // Keep individual D1 batches reasonably small even during the one-time
  // migration from the old full-rewrite layout.
  for (let offset = 0; offset < statements.length; offset += 80) await env.DB.batch(statements.slice(offset, offset + 80));
}
async function persistVideoScope(env, scope, groups, now) {
  const desired = new Map();
  Object.entries(groups).forEach(([status, items]) => (items || []).forEach((item) => { if (item?.videoId) desired.set(item.videoId, { item, status, dataJson: JSON.stringify(durableVideo(item)) }); }));
  const existingStates = new Map((await queryAll(env, 'SELECT video_id, status FROM video_states WHERE scope=?', scope)).map((row) => [row.video_id, row.status]));
  const existingVideos = await storedVideos(env, [...desired.keys()]);
  const statements = [];
  desired.forEach(({ item, status, dataJson }, videoId) => {
    // Live viewer count remains current: a live record is written only when
    // its actual payload changes, rather than once per scope every minute.
    if (existingVideos.get(videoId) !== dataJson) statements.push(upsertVideo(env, item, now, dataJson));
    if (existingStates.get(videoId) !== status) statements.push(env.DB.prepare('INSERT INTO video_states (scope, video_id, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, video_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at').bind(scope, videoId, status, now));
  });
  existingStates.forEach((_, videoId) => { if (!desired.has(videoId)) statements.push(env.DB.prepare('DELETE FROM video_states WHERE scope=? AND video_id=?').bind(scope, videoId)); });
  await runStatements(env, statements);
}
async function persistVideoStates(env, states, now) {
  if (!await operationalReady(env)) return;
  await persistVideoScope(env, 'all', { live: states.allLive, upcoming: states.allUpcoming, ended: states.allEnded }, now);
  await persistVideoScope(env, 'ui', { live: states.uiLive, upcoming: states.uiUpcoming, ended: states.uiEnded }, now);
}
async function recordViewerSamples(env, liveVideos, now) {
  if (!await operationalReady(env) || !liveVideos.length) return;
  // Five-minute buckets keep 90 days of charts practical on D1 Free. The
  // all-minute peak remains in videos.peak_viewers.
  const observedAt = Math.floor(now / (5 * 60_000)) * 5 * 60_000;
  // A bucket is an historical sample, not a per-minute counter. INSERT OR
  // IGNORE prevents five UPDATEs in the same bucket for every live stream.
  await env.DB.batch(liveVideos.filter((item) => item?.videoId).map((item) => env.DB.prepare('INSERT OR IGNORE INTO viewer_samples (video_id, observed_at, viewers, source) VALUES (?, ?, ?, ?)').bind(item.videoId, observedAt, Number(item.viewers || 0), item.source || 'holodex')));
}
async function readNotificationHistory(env) {
  if (!await operationalReady(env)) return null;
  const rows = await queryAll(env, 'SELECT video_id, state_json FROM notification_state');
  return Object.fromEntries(rows.flatMap((row) => { try { return [[row.video_id, JSON.parse(row.state_json)]]; } catch { return []; } }));
}
async function persistNotificationHistory(env, history, now = Date.now()) {
  if (!await operationalReady(env)) return;
  const existing = new Map((await queryAll(env, 'SELECT video_id, state_json FROM notification_state')).map((row) => [row.video_id, row.state_json]));
  const statements = [];
  Object.entries(history).forEach(([videoId, state]) => {
    const value = JSON.stringify(state);
    if (existing.get(videoId) !== value) statements.push(env.DB.prepare('INSERT INTO notification_state (video_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at').bind(videoId, value, now));
    existing.delete(videoId);
  });
  existing.forEach((_, videoId) => statements.push(env.DB.prepare('DELETE FROM notification_state WHERE video_id=?').bind(videoId)));
  await runStatements(env, statements);
}
async function logNotification(env, type, subject, items, status, detail = {}) {
  if (!await operationalReady(env)) return;
  const now = Date.now();
  const values = items.length ? items : [null];
  await env.DB.batch(values.map((item) => env.DB.prepare('INSERT INTO notification_log (video_id, notification_type, subject, status, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(item?.videoId || null, type, subject, status, JSON.stringify(detail), now)));
}
async function bootstrapOperationalState(env) {
  if (!await operationalReady(env)) return;
  const done = await env.DB.prepare("SELECT 1 FROM app_settings WHERE setting_key='operational_bootstrap' LIMIT 1").first();
  if (done) return;
  const [allLive, allUpcoming, allEnded, uiLive, uiUpcoming, uiEnded, notificationHistory] = await Promise.all([
    getState(env, 'all_live', []), getState(env, 'all_upcoming', []), getState(env, 'all_ended', []), getState(env, 'ui_live', []), getState(env, 'ui_upcoming', []), getState(env, 'ui_ended', []), getState(env, 'notification_history', {})
  ]);
  const now = Date.now();
  await persistVideoStates(env, { allLive, allUpcoming, allEnded, uiLive, uiUpcoming, uiEnded }, now);
  await persistNotificationHistory(env, notificationHistory, now);
  await env.DB.prepare("INSERT INTO app_settings (setting_key, setting_value) VALUES ('operational_bootstrap', ?) ON CONFLICT(setting_key) DO NOTHING").bind(String(now)).run();
}
async function startMonitorRun(env, type, batchStart = null) {
  if (!await operationalReady(env)) return null;
  const result = await env.DB.prepare("INSERT INTO monitor_runs (started_at, run_type, rss_batch_start, status) VALUES (?, ?, ?, 'running')").bind(Date.now(), type, batchStart).run();
  return result.meta?.last_row_id || null;
}
async function finishMonitorRun(env, id, status, discovered = 0, message = '') {
  if (id) await env.DB.prepare('UPDATE monitor_runs SET finished_at=?, status=?, discovered_count=?, message=? WHERE id=?').bind(Date.now(), status, discovered, String(message || '').slice(0, 1000), id).run();
}
async function recordFailedMonitorRun(env, batchStart, message) {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO monitor_runs (started_at, finished_at, run_type, rss_batch_start, status, discovered_count, message) VALUES (?, ?, 'monitor', ?, 'failed', 0, ?)").bind(now, now, batchStart, String(message || '').slice(0, 1000)).run();
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
async function importSheetMasters(env) {
  const [favorites, excludes, words, events, talent, global] = await sheetValues(env, ["'お気に入りチャンネル'!A:C", "'除外チャンネル'!A:B", "'除外ワード'!A:A", "'イベントキーワード'!A:ZZ", "'チャンネル置き換え'!A:B", "'全体チャンネル'!A:B"]);
  const channels = new Map();
  const add = (id, patch) => { const key = String(id || '').trim(); if (!key) return; channels.set(key, { ...(channels.get(key) || { name: '', isGlobal: 0, isFavorite: 0, isExcluded: 0 }), ...patch }); };
  favorites.slice(1).forEach((row) => add(row[1], { name: String(row[0] || '').trim(), isFavorite: String(row[2] || '') === '1' ? 1 : 0 }));
  excludes.slice(1).forEach((row) => add(row[1], { name: String(row[0] || '').trim(), isExcluded: 1 }));
  global.slice(1).filter((row) => String(row[1] || '').startsWith('UC')).forEach((row) => add(row[1], { name: String(row[0] || '').trim(), isGlobal: 1 }));
  if (await operationalReady(env)) {
    const statements = [];
    channels.forEach((item, id) => statements.push(env.DB.prepare('INSERT INTO channels (channel_id, name, is_global, is_favorite, is_excluded) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET name=CASE WHEN excluded.name <> \'\' THEN excluded.name ELSE channels.name END, is_global=MAX(channels.is_global, excluded.is_global), is_favorite=excluded.is_favorite, is_excluded=MAX(channels.is_excluded, excluded.is_excluded), updated_at=CURRENT_TIMESTAMP').bind(id, item.name, item.isGlobal, item.isFavorite, item.isExcluded)));
    words.filter((row) => row[0]).forEach((row) => statements.push(env.DB.prepare('INSERT OR IGNORE INTO exclude_words (keyword) VALUES (?)').bind(String(row[0]).trim())));
    (events[0] || []).forEach((category, column) => events.slice(1).forEach((row) => { if (category && row[column]) statements.push(env.DB.prepare('INSERT OR IGNORE INTO event_keywords (category, keyword) VALUES (?, ?)').bind(String(category), String(row[column]).trim())); }));
    talent.slice(1).filter((row) => row[0] && row[1]).forEach((row) => statements.push(env.DB.prepare('INSERT INTO talent_aliases (source_name, display_name) VALUES (?, ?) ON CONFLICT(source_name) DO UPDATE SET display_name=excluded.display_name').bind(String(row[0]), String(row[1]))));
    statements.push(env.DB.prepare("INSERT INTO app_settings (setting_key, setting_value) VALUES ('sheets_imported_at', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value, updated_at=CURRENT_TIMESTAMP").bind(String(Date.now())));
    if (statements.length) await env.DB.batch(statements);
  }
  const favoriteMap = Object.fromEntries(favorites.slice(1).filter((row) => String(row[2] || '') === '1' && row[1]).map((row) => [String(row[1]).trim(), { name: String(row[0] || '').trim() }]));
  const eventKeywords = Object.fromEntries((events[0] || []).map((title, column) => [title, events.slice(1).map((row) => row[column]).filter(Boolean)]).filter(([title]) => title));
  return { favorites: favoriteMap, excludes: excludes.slice(1).map((row) => row[1]).filter(Boolean), excludeWords: words.map((row) => String(row[0] || '').toLowerCase()).filter(Boolean), eventKeywords, talentMap: Object.fromEntries(talent.slice(1).filter((row) => row[0] && row[1])), global: Object.fromEntries(global.slice(1).filter((row) => String(row[1] || '').startsWith('UC')).map((row) => [String(row[1]), { name: row[0] }])) };
}
function normalizeYoutubeHandle(value) {
  const match = String(value || '').trim().match(/(?:youtube\.com\/)?@([a-z0-9._-]{3,})/i);
  return match ? match[1].toLowerCase() : '';
}
function masterFromRows(channels, words = [], events = [], aliases = []) {
  const values = channels instanceof Map ? [...channels.entries()].map(([channel_id, item]) => ({ channel_id, name: item.name, is_global: item.isGlobal, is_favorite: item.isFavorite, is_excluded: item.isExcluded })) : channels;
  const member = (item) => ({ name: item.name || '', priority: Number(item.priority || 0), handle: normalizeYoutubeHandle(item.youtube_handle || item.youtube_url), handleCheckedAt: Number(item.handle_checked_at || 0) });
  const favorites = Object.fromEntries(values.filter((item) => Number(item.is_favorite)).map((item) => [item.channel_id, member(item)]));
  const global = Object.fromEntries(values.filter((item) => Number(item.is_global)).map((item) => [item.channel_id, member(item)]));
  const eventKeywords = {};
  events.forEach((item) => { const category = Array.isArray(item) ? item.category : item.category; const keyword = Array.isArray(item) ? item.keyword : item.keyword; if (!category || !keyword) return; (eventKeywords[category] ||= []).push(keyword); });
  return { favorites, global, excludes: values.filter((item) => Number(item.is_excluded)).map((item) => item.channel_id), excludeWords: words.map((row) => String(Array.isArray(row) ? row[0] : row.keyword || row.setting_value || '').toLowerCase()).filter(Boolean), eventKeywords, talentMap: Object.fromEntries(aliases.filter((row) => (Array.isArray(row) ? row[0] : row.source_name) && (Array.isArray(row) ? row[1] : row.display_name)).map((row) => [Array.isArray(row) ? row[0] : row.source_name, Array.isArray(row) ? row[1] : row.display_name])) };
}
async function masters(env) {
  if (await operationalReady(env)) {
    const existing = await queryAll(env, 'SELECT channel_id, name, is_global, is_favorite, is_excluded, priority FROM channels');
    if (!existing.length) await importSheetMasters(env);
    await bootstrapOperationalState(env);
    const [channels, keywords, words, aliases] = await Promise.all([queryAll(env, 'SELECT c.channel_id, c.name, c.is_global, c.is_favorite, c.is_excluded, c.priority, c.youtube_url, h.handle AS youtube_handle, h.updated_at AS handle_checked_at FROM channels c LEFT JOIN channel_handles h ON h.channel_id=c.channel_id ORDER BY c.is_favorite DESC, c.priority DESC, c.name'), queryAll(env, 'SELECT category, keyword FROM event_keywords'), queryAll(env, 'SELECT keyword FROM exclude_words'), queryAll(env, 'SELECT source_name, display_name FROM talent_aliases')]);
    return masterFromRows(channels, words, keywords, aliases);
  }
  // Allows a safe deploy before the D1 migration has been applied.
  return importSheetMasters(env);
}
async function hydrateYoutubeHandles(env, master) {
  if (!env.YOUTUBE_API_KEY || !await operationalReady(env)) return;
  const now = Date.now();
  const missing = Object.keys(master.global).filter((channelId) => !master.global[channelId]?.handle && now - Number(master.global[channelId]?.handleCheckedAt || 0) > 7 * 86400000);
  if (!missing.length) return;
  const chunks = Array.from({ length: Math.ceil(missing.length / 50) }, (_, index) => missing.slice(index * 50, index * 50 + 50));
  const resolved = new Map();
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const query = new URLSearchParams({ part: 'snippet', id: chunk.join(','), key: env.YOUTUBE_API_KEY });
      const response = await fetch(`https://www.googleapis.com/youtube/v3/channels?${query}`);
      if (!response.ok) throw new Error(`YouTube channel lookup failed: ${response.status}`);
      for (const channel of (await response.json()).items || []) {
        const handle = normalizeYoutubeHandle(channel.snippet?.customUrl);
        if (handle) resolved.set(channel.id, handle);
      }
    } catch (error) { console.warn('YouTube handle lookup failed.', error.message || error); }
  }));
  await env.DB.batch(missing.map((channelId) => env.DB.prepare('INSERT INTO channel_handles (channel_id, handle, updated_at) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET handle=excluded.handle, updated_at=excluded.updated_at').bind(channelId, resolved.get(channelId) || '', now)));
  missing.forEach((channelId) => {
    const handle = resolved.get(channelId) || '';
    if (master.global[channelId]) master.global[channelId].handle = handle;
    if (master.favorites[channelId]) master.favorites[channelId].handle = handle;
    if (master.global[channelId]) master.global[channelId].handleCheckedAt = now;
    if (master.favorites[channelId]) master.favorites[channelId].handleCheckedAt = now;
  });
}
async function updateFavorite(env, channelId, isFavorite) {
  if (await operationalReady(env)) {
    const result = await env.DB.prepare('UPDATE channels SET is_favorite=?, updated_at=CURRENT_TIMESTAMP WHERE channel_id=?').bind(isFavorite ? 1 : 0, channelId).run();
    return Number(result.meta?.changes || 0) > 0;
  }
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
  return { videoId: raw.id, title: raw.title || '', description: String(raw.description || '').slice(0, 6000), channelTitle: external ? `(外) ${raw.channel?.name || ''}` : raw.channel?.name || '', channelId: raw.channel?.id || '', channelIcon: raw.channel?.photo || '', thumbnail: `https://i.ytimg.com/vi/${raw.id}/hqdefault.jpg`, videoUrl: `https://www.youtube.com/watch?v=${raw.id}`, viewers: raw.live_viewers || 0, liveViewersFormatted: raw.live_viewers ? Number(raw.live_viewers).toLocaleString() : null, startTimeRaw: start, startTime: start ? format(start) : '未定', dateKey: start ? format(start, true) : '', isLive: raw.status === 'live', isEnded: raw.status === 'past', durationLabel: formatDuration(raw.duration), mentions: raw.mentions || [], mentionsKnown: Array.isArray(raw.mentions), guests, source: 'holodex', priority: 1 };
}
async function holodex(env, path, parameters) {
  const url = new URL(`${HOLODEX}${path}`); Object.entries(parameters || {}).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { 'X-APIKEY': env.HOLODEX_API_KEY } }); if (!response.ok) throw new Error(`Holodex failed: ${response.status}`); return response.json();
}
function mergePeople(...lists) {
  const map = new Map();
  lists.flat().filter(Boolean).forEach((person) => {
    const key = String(person.id || person.name || '').trim();
    if (key) map.set(key, { ...map.get(key), ...person });
  });
  return [...map.values()];
}
function merge(videos) {
  const map = new Map();
  videos.filter(Boolean).forEach((item) => {
    const prior = map.get(item.videoId);
    if (!prior) { map.set(item.videoId, item); return; }
    // Equal-priority Holodex data is newer when it arrives later in the
    // monitor run. Preserve the union of guests either way.
    const preferIncoming = (item.priority || 1) <= (prior.priority || 1);
    const preferred = preferIncoming ? item : prior;
    const mentionSource = preferIncoming && item.mentionsKnown ? item : prior.mentionsKnown ? prior : null;
    map.set(item.videoId, {
      ...preferred,
      isSpecial: Boolean(item.isSpecial || prior.isSpecial),
      mentions: mentionSource ? mentionSource.mentions : mergePeople(prior.mentions || [], item.mentions || []),
      guests: mentionSource ? mentionSource.guests : mergePeople(prior.guests || [], item.guests || []),
      mentionsKnown: Boolean(prior.mentionsKnown || item.mentionsKnown)
    });
  });
  return [...map.values()];
}
function rotateItems(items, cursor, limit) {
  const unique = [...new Map(items.filter((item) => item?.videoId).map((item) => [item.videoId, item])).values()];
  if (!unique.length || !limit) return { items: [], nextCursor: 0 };
  const start = ((Number(cursor) || 0) % unique.length + unique.length) % unique.length;
  const selected = Array.from({ length: Math.min(limit, unique.length) }, (_, index) => unique[(start + index) % unique.length]);
  return { items: selected, nextCursor: (start + selected.length) % unique.length };
}
async function refreshTrackedGuests(env, states, globalIds, talentMap, cursors) {
  if (!env.HOLODEX_API_KEY) return { videos: [], cursors };
  const live = rotateItems(states.live || [], cursors.live, HOLODEX_GUEST_DETAILS_PER_RUN.live);
  const upcoming = rotateItems([...(states.upcoming || [])].sort((a, b) => new Date(a.startTimeRaw) - new Date(b.startTimeRaw)), cursors.upcoming, HOLODEX_GUEST_DETAILS_PER_RUN.upcoming);
  const ended = rotateItems([...(states.ended || [])].sort((a, b) => new Date(b.startTimeRaw) - new Date(a.startTimeRaw)), cursors.ended, HOLODEX_GUEST_DETAILS_PER_RUN.ended);
  const targets = [...live.items, ...upcoming.items, ...ended.items];
  const videos = [];
  await mapLimit(targets, 4, async (item) => {
    try {
      const raw = await holodex(env, `/videos/${encodeURIComponent(item.videoId)}`, { include: 'mentions,description' });
      if (raw?.id) videos.push({ ...video(raw, globalIds, talentMap), isSpecial: Boolean(item.isSpecial) });
    } catch (error) {
      // A deleted/private video must not abort the rest of this monitor run.
      console.warn('Holodex guest refresh failed.', item.videoId, error.message || error);
    }
  });
  return { videos, cursors: { live: live.nextCursor, upcoming: upcoming.nextCursor, ended: ended.nextCursor } };
}
function primaryTarget(item, master) { const ids = new Set(Object.keys(master.favorites)); return Boolean(ids.has(item.channelId) || item.isSpecial || isSpecial(item.title, master.eventKeywords) || (item.mentions || []).some((mention) => ids.has(mention.id)) || (item.detectedMemberIds || []).some((id) => ids.has(id))); }
function target(item, master) { if (primaryTarget(item, master)) return true; return Object.values(master.favorites).some((favorite) => favorite.name && item.title?.includes(favorite.name)); }
function shouldInclude(item, master) { if (Object.hasOwn(master.favorites, item.channelId)) return true; const title = normalizeTitle(item.title); if ((master.excludeWords || []).some((word) => title.includes(normalizeTitle(word)))) return false; return !(master.excludes || []).includes(item.channelId); }
function isWithin72Hours(value, now) { const diff = new Date(value).getTime() - now; return diff >= -3 * 3600_000 && diff <= 72 * 3600_000; }
function normalizeTitle(value) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); }
function descriptionHandles(value) {
  const handles = new Set();
  for (const match of String(value || '').matchAll(/(^|[^a-z0-9._-])@([a-z0-9._-]{3,})/gi)) handles.add(match[2].toLowerCase());
  return handles;
}
function enrichGuestSignals(item, master) {
  const roster = master.global || {};
  // Title/description inference only decides whether an outside stream matters.
  // It must never become a displayed guest: event titles and credits often list
  // many members who are not actually participating in the stream.
  const mentions = new Map((item.mentions || []).filter((mention) => mention?.id && !mention.inferred_from).map((mention) => [mention.id, mention]));
  const normalizedTitle = normalizeTitle(item.title);
  const handles = descriptionHandles(item.description);
  const detectedMemberIds = new Set(item.detectedMemberIds || []);
  Object.entries(roster).forEach(([channelId, channel]) => {
    if (channelId === item.channelId || mentions.has(channelId)) return;
    const name = String(channel?.name || '').trim();
    const mentionedByTitle = name.length >= 3 && normalizedTitle.includes(normalizeTitle(name));
    const mentionedByDescriptionHandle = Boolean(channel?.handle && handles.has(channel.handle));
    if (mentionedByTitle || mentionedByDescriptionHandle) detectedMemberIds.add(channelId);
  });
  const allMentions = [...mentions.values()];
  const guests = allMentions.filter((mention) => mention.id !== item.channelId && roster[mention.id]).map((mention) => ({ name: String(roster[mention.id]?.name || normalizedTalentName(mention.name, master.talentMap)).trim(), icon: mention.photo || '' })).filter((guest, index, list) => guest.name && list.findIndex((entry) => entry.name === guest.name) === index);
  return { ...item, mentions: allMentions, guests, detectedMemberIds: [...detectedMemberIds], mentionsKnown: Boolean(item.mentionsKnown) };
}
function hasRosterConnection(item, globalIds) { return globalIds.has(item.channelId) || (item.guests || []).length > 0 || (item.detectedMemberIds || []).length > 0; }
function isHolostarsChannel(channel) { return /holostars|ホロスターズ/i.test(`${channel?.org || ''} ${channel?.group || ''}`); }
async function allowedExternalChannelIds(env, rawVideos, globalIds) {
  const externalIds = [...new Set(rawVideos.map((raw) => raw.channel?.id).filter((id) => id && !globalIds.has(id)))];
  if (!externalIds.length) return new Set();
  if (!await externalClassificationReady(env)) return new Set();
  const rows = await queryAll(env, `SELECT channel_id, is_holostars FROM external_channel_classifications WHERE channel_id IN (${externalIds.map(() => '?').join(',')})`, ...externalIds);
  const decisions = new Map(rows.map((row) => [row.channel_id, Number(row.is_holostars)]));
  const unknown = externalIds.filter((id) => !decisions.has(id)).slice(0, 4);
  const statements = [];
  await mapLimit(unknown, 4, async (channelId) => {
    try {
      const channel = await holodex(env, `/channels/${encodeURIComponent(channelId)}`);
      const isHolostars = isHolostarsChannel(channel) ? 1 : 0;
      decisions.set(channelId, isHolostars);
      statements.push(env.DB.prepare('INSERT INTO external_channel_classifications (channel_id, org, group_name, is_holostars, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_id) DO NOTHING').bind(channelId, String(channel?.org || ''), String(channel?.group || ''), isHolostars, Date.now()));
    } catch (error) { console.warn('External channel classification failed.', channelId, error.message || error); }
  });
  if (statements.length) await env.DB.batch(statements);
  return new Set(externalIds.filter((id) => decisions.get(id) === 0));
}
function distance(left, right) { const a = String(left || ''); const b = String(right || ''); if (!a || !b) return Infinity; const row = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i += 1) { let previous = row[0]; row[0] = i; for (let j = 1; j <= b.length; j += 1) { const current = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = current; } } return row[b.length]; }
function changedFields(item, previous) {
  if (!previous) return [];
  const changes = [];
  if (distance(normalizeTitle(item.title), normalizeTitle(previous.title)) >= 3) changes.push('タイトル');
  if (new Date(item.startTimeRaw).getTime() !== new Date(previous.startTimeRaw).getTime()) changes.push('開始時刻');
  const signature = (mentions) => [...new Set((mentions || []).map((mention) => String(mention.id || mention.name || '')).filter(Boolean))].sort().join(',');
  if (signature(item.mentions) !== signature(previous.mentions)) changes.push('ゲスト');
  return changes;
}
function isoDurationSeconds(value) { const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value || ''); return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0; }
function tokyoHour(date = new Date()) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: TOKYO, hour: '2-digit', hourCycle: 'h23' }).format(date)); }
function youtubeInterval() { return 55_000; }
// One 20-channel RSS batch per minute means roughly 100 channels are swept in
// five minutes without exceeding Workers Free's 50 external-subrequest limit.
function monitorInterval() { return 55_000; }
async function mapLimit(values, limit, fn) { let cursor = 0; await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { while (cursor < values.length) { const index = cursor++; await fn(values[index]); } })); }
async function rssIds(channelIds) { const ids = new Set(); await mapLimit(channelIds, 6, async (channelId) => { try { const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`); if (!response.ok) return; for (const match of (await response.text()).matchAll(/<yt:videoId>([a-zA-Z0-9_-]{11})<\/yt:videoId>/g)) ids.add(match[1]); } catch { /* A single RSS failure is non-fatal. */ } }); return [...ids]; }
function rotatingBatch(values, cursor, size) {
  if (!values.length) return [];
  const start = ((Number(cursor) || 0) % values.length + values.length) % values.length;
  return Array.from({ length: Math.min(size, values.length) }, (_, index) => values[(start + index) % values.length]);
}
function prioritizedRssBatch(channelIds, master, cursor, size) {
  const priority = channelIds.filter((id) => master.favorites[id] || Number(master.global[id]?.priority || 0) > 0);
  const regular = channelIds.filter((id) => !priority.includes(id));
  const priorityPart = priority.slice(0, Math.min(5, size));
  const regularPart = rotatingBatch(regular, cursor, size - priorityPart.length);
  return { channels: [...priorityPart, ...regularPart], nextCursor: regular.length ? (Number(cursor || 0) + regularPart.length) % regular.length : 0 };
}
async function youtubeDetails(env, ids) { if (!env.YOUTUBE_API_KEY || !ids.length) return []; const chunks = Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) => ids.slice(i * 50, i * 50 + 50)); const cutoff = Date.now() + 14 * 86400000; const results = await Promise.all(chunks.map(async (chunk) => { const query = new URLSearchParams({ part: 'snippet,liveStreamingDetails', id: chunk.join(','), key: env.YOUTUBE_API_KEY }); const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${query}`); if (!response.ok) throw new Error(`YouTube API failed: ${response.status}`); return (await response.json()).items || []; })); return results.flat().flatMap((item) => { const details = item.liveStreamingDetails; const live = item.snippet?.liveBroadcastContent === 'live'; const ended = item.snippet?.liveBroadcastContent === 'none' && Boolean(details?.actualEndTime); if (!details || ended) return []; const startTimeRaw = details.actualStartTime || details.scheduledStartTime || item.snippet?.publishedAt; if (!live && new Date(startTimeRaw).getTime() > cutoff) return []; return [{ videoId: item.id, title: item.snippet?.title || '', description: String(item.snippet?.description || '').slice(0, 6000), channelTitle: item.snippet?.channelTitle || '', channelId: item.snippet?.channelId || '', channelIcon: item.snippet?.thumbnails?.default?.url || '', thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`, videoUrl: `https://www.youtube.com/watch?v=${item.id}`, viewers: Number(details.concurrentViewers || 0), liveViewersFormatted: details.concurrentViewers ? Number(details.concurrentViewers).toLocaleString() : null, startTimeRaw, startTime: format(startTimeRaw), dateKey: format(startTimeRaw, true), isLive: live, isEnded: false, mentions: [], guests: [], source: 'youtube_api', priority: 3 }]; }); }
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
  // After migration D1 owns viewer history.  Do not grow or repeatedly rewrite
  // the spreadsheet during normal monitoring.
  if (await operationalReady(env)) return;
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
  if (await operationalReady(env)) return;
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
  const history = (await readNotificationHistory(env)) ?? await getState(env, 'notification_history', {});
  const border = now - 3 * 86400_000;
  const cleaned = Object.fromEntries(Object.entries(history).filter(([, item]) => {
    const start = new Date(item?.startTimeRaw || item?.startTime || '').getTime();
    return Number.isFinite(start) && start >= border;
  }));
  if (Object.keys(cleaned).length !== Object.keys(history).length) (await operationalReady(env)) ? await persistNotificationHistory(env, cleaned, now) : await setState(env, 'notification_history', cleaned);
}
async function runPeriodicMaintenance(env, key, intervalMs, task, now = Date.now()) {
  const previous = await getState(env, key, 0);
  if (now - Number(previous || 0) < intervalMs) return false;
  await task();
  await setState(env, key, now);
  return true;
}
async function cleanupOperationalData(env, now = Date.now()) {
  if (!await operationalReady(env)) return;
  const ninetyDays = now - 90 * 86400_000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM viewer_samples WHERE observed_at < ?').bind(ninetyDays),
    env.DB.prepare('DELETE FROM notification_log WHERE created_at < ?').bind(ninetyDays),
    env.DB.prepare('DELETE FROM monitor_runs WHERE started_at < ?').bind(ninetyDays),
    env.DB.prepare('DELETE FROM rss_seen WHERE last_seen_at < ?').bind(ninetyDays)
  ]);
}
async function archiveStats(env, videoId, fallback, bufferedPeak = 0) { const storedPeak = await operationalReady(env) ? await env.DB.prepare('SELECT peak_viewers FROM videos WHERE video_id=?').bind(videoId).first() : null; const [youtube, detail] = await Promise.allSettled([async () => { if (!env.YOUTUBE_API_KEY) return 0; const query = new URLSearchParams({ part: 'contentDetails', id: videoId, key: env.YOUTUBE_API_KEY }); const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${query}`); return response.ok ? isoDurationSeconds((await response.json()).items?.[0]?.contentDetails?.duration) : 0; }, holodex(env, `/videos/${encodeURIComponent(videoId)}`)]); const peak = Number(storedPeak?.peak_viewers || 0) || Number(bufferedPeak) || Number(detail.status === 'fulfilled' ? detail.value?.live_viewers : 0) || Number(String(fallback.liveViewersFormatted || 0).replaceAll(',', '')) || 0; return { duration: youtube.status === 'fulfilled' ? youtube.value : 0, peak }; }
async function endedFrom(previous, current, env, keep, viewerBuffer = {}) { const currentIds = new Set(current.map((item) => item.videoId)); const candidates = previous.filter((item) => !currentIds.has(item.videoId) && new Date(item.startTimeRaw).getTime() <= Date.now()); return (await Promise.all(candidates.map(async (item) => { const stats = await archiveStats(env, item.videoId, item, viewerBuffer[item.videoId]?.peak); return { ...item, isLive: false, isEnded: true, liveViewersFormatted: stats.peak ? Number(stats.peak).toLocaleString() : item.liveViewersFormatted, durationLabel: stats.duration ? formatDuration(stats.duration) : item.durationLabel }; }))).filter((item) => new Date(item.startTimeRaw).getTime() >= keep); }
const html = (value) => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const formatDate = (value) => format(value, true);
const formatHour = (value) => format(value).slice(6, 8);
const normalizedTalentName = (name, talentMap = {}) => {
  const raw = String(name || '').trim();
  if (talentMap[raw]) return talentMap[raw];
  const japanese = raw.match(/[ぁ-んァ-ン一-龥々〆ヵヶ]+/g);
  // Holodex occasionally appends a generation label such as "3期生" to a
  // talent name. Digits are removed by the Japanese-only fallback below,
  // which used to leave the misleading suffix "期生" in notification mail.
  return (japanese ? japanese.join('') : raw).replace(/(?:[〇一二三四五六七八九十0-9０-９]+)?期生/g, '').trim() || raw;
};
const mentionDisplayName = (mention, master) => String(
  master?.favorites?.[mention?.id]?.name || master?.global?.[mention?.id]?.name || normalizedTalentName(mention?.name, master?.talentMap)
).trim();

function notificationTarget(item, master) {
  const favoriteIds = new Set(Object.keys(master.favorites));
  return Boolean(item.isSpecial || favoriteIds.has(item.channelId) || (item.mentions || []).some((mention) => favoriteIds.has(mention.id)) || (item.detectedMemberIds || []).some((id) => favoriteIds.has(id)));
}

function shouldSendChanged(item, now) {
  if (item.changedFields?.includes('タイトル')) return true;
  if (item.changedFields?.includes('ゲスト')) return true;
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
    if (item.changedFields?.includes('ゲスト')) return `${names[0]} ゲスト情報更新`;
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

function changeDetail(item, master) {
  const previous = item.previous;
  if (!previous || !item.changedFields?.length) return '';
  const lines = [];
  if (item.changedFields.includes('タイトル')) lines.push(`タイトル: 「${previous.title || ''}」 → 「${item.title}」`);
  if (item.changedFields.includes('開始時刻')) lines.push(`開始時刻: ${format(previous.startTimeRaw)} → ${item.startTime}`);
  if (item.changedFields.includes('ゲスト')) {
    const names = (mentions) => [...new Set((mentions || []).map((mention) => mentionDisplayName(mention, master)).filter(Boolean))].join('・') || 'なし';
    lines.push(`ゲスト: ${names(previous.mentions)} → ${names(item.mentions)}`);
  }
  return lines.length ? `<div style="font-size:14px;color:#d00;margin:6px 0 10px;line-height:1.4">${lines.map(html).join('<br>')}</div>` : '';
}

function notificationCard(item, master) {
  const favoriteIds = new Set(Object.keys(master.favorites));
  const guestNames = (item.mentions || []).filter((mention) => favoriteIds.has(mention.id)).map((mention) => mentionDisplayName(mention, master));
  const labels = `${item.notificationKind === 'new' ? '<span style="position:absolute;left:8px;top:8px;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;background:#fff;color:#2e7d32;border:1px solid #2e7d32">NEW</span>' : ''}${item.changedFields?.length ? '<span style="position:absolute;left:8px;top:8px;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;background:#fff9c4;color:#ef6c00;border:1px solid #ef6c00">変更</span>' : ''}`;
  const guests = guestNames.length ? `<div style="font-size:14px;color:#555;margin-bottom:6px">参加: ${html(guestNames.join('・'))}</div>` : '';
  const keyword = specialKeyword(item.title, master.eventKeywords);
  const special = keyword ? `<div style="display:inline-block;background:#ffebee;color:#c62828;padding:2px 8px;border-radius:4px;font-size:13px;margin-top:8px;font-weight:bold">${html(keyword)}</div>` : '';
  return `<a href="${html(item.videoUrl)}" target="_blank" style="text-decoration:none;color:inherit;display:block;margin-bottom:16px"><div style="background:#f0f7ff;padding:12px;border-radius:12px;border:1px solid #d1e9ff"><div style="background:#fff;border-radius:8px;overflow:hidden"><div style="position:relative;width:100%;line-height:0"><img src="${html(item.thumbnail)}" alt="" style="width:100%;height:auto;display:block">${labels}</div><div style="padding:12px"><div style="font-size:14px;font-weight:bold;color:#1976d2;margin-bottom:4px">${html(item.startTime)}</div><div style="font-size:16px;font-weight:bold;line-height:1.4;margin-bottom:8px;color:#333">${html(item.title)}</div>${changeDetail(item, master)}${guests}${special}</div></div></div></a>`;
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

async function resendSend(env, payload) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      // Resend rejects some Cloudflare Worker requests without this header.
      'User-Agent': 'hololive-live-monitor/1.0'
    },
    body: JSON.stringify(payload)
  });
  if (response.ok) return true;
  const detail = (await response.text()).replaceAll(/\s+/g, ' ').slice(0, 500);
  throw new Error(`Resend failed: ${response.status}${detail ? ` ${detail}` : ''}`);
}
function resendReady(env) {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}
function gasRelayReady(env) {
  return Boolean(env.GAS_MAIL_RELAY_URL && env.GAS_MAIL_RELAY_TOKEN);
}
async function gasRelaySend(env, { senderName, recipient, subject, html: htmlBody }) {
  const response = await fetch(env.GAS_MAIL_RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: env.GAS_MAIL_RELAY_TOKEN,
      senderName,
      recipient,
      subject,
      html: htmlBody
    })
  });
  const detail = await response.text();
  if (!response.ok) throw new Error(`GAS mail relay failed: ${response.status} ${detail.slice(0, 500)}`);
  let result;
  try {
    result = JSON.parse(detail);
  } catch {
    throw new Error(`GAS mail relay returned invalid JSON: ${detail.slice(0, 500)}`);
  }
  if (!result.ok) throw new Error(`GAS mail relay rejected delivery: ${String(result.error || 'unknown error').slice(0, 500)}`);
  return true;
}
function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
function gmailReady(env) {
  return Boolean(env.GMAIL_OAUTH_CLIENT_ID && env.GMAIL_OAUTH_CLIENT_SECRET && env.GMAIL_OAUTH_REFRESH_TOKEN && env.GMAIL_SENDER_EMAIL);
}
async function gmailAccessToken(env) {
  const body = new URLSearchParams({
    client_id: env.GMAIL_OAUTH_CLIENT_ID,
    client_secret: env.GMAIL_OAUTH_CLIENT_SECRET,
    refresh_token: env.GMAIL_OAUTH_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const detail = await response.text();
  if (!response.ok) throw new Error(`Gmail OAuth failed: ${response.status} ${detail.slice(0, 500)}`);
  const token = JSON.parse(detail).access_token;
  if (!token) throw new Error('Gmail OAuth failed: access token was not returned');
  return token;
}
function gmailMime({ senderName, senderEmail, recipient, subject, html: htmlBody }) {
  const header = (value) => `=?UTF-8?B?${base64Utf8(value)}?=`;
  const address = senderName ? `${header(senderName)} <${senderEmail}>` : senderEmail;
  const body = base64Utf8(htmlBody).match(/.{1,76}/g)?.join('\r\n') || '';
  return [
    `From: ${address}`,
    `To: ${recipient}`,
    `Subject: ${header(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body
  ].join('\r\n');
}
async function gmailSend(env, { senderName, recipient, subject, html: htmlBody }) {
  const token = await gmailAccessToken(env);
  const mime = gmailMime({ senderName, senderEmail: env.GMAIL_SENDER_EMAIL, recipient, subject, html: htmlBody });
  const raw = base64Utf8(mime).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  const detail = await response.text();
  if (!response.ok) throw new Error(`Gmail send failed: ${response.status} ${detail.slice(0, 500)}`);
  return true;
}
async function deliverMail(providers) {
  if (!providers.length) return { sent: false, partial: false, providers: {}, errors: [] };
  const results = await Promise.allSettled(providers.map((provider) => provider.send()));
  const providerStatus = {};
  const errors = [];
  let succeeded = 0;
  results.forEach((result, index) => {
    const name = providers[index].name;
    if (result.status === 'fulfilled') { providerStatus[name] = 'sent'; succeeded += 1; }
    else { providerStatus[name] = 'failed'; errors.push(`${name}: ${String(result.reason?.message || result.reason || 'unknown error').slice(0, 500)}`); }
  });
  if (!succeeded) throw new Error(`All mail providers failed. ${errors.join(' | ')}`);
  return { sent: true, partial: succeeded !== providers.length, providers: providerStatus, errors };
}
async function sendMail(env, { senderName, recipient, subject, html: htmlBody }) {
  const gas = () => gasRelaySend(env, { senderName, recipient, subject, html: htmlBody });
  const gmail = () => gmailSend(env, { senderName, recipient, subject, html: htmlBody });
  const resend = () => resendSend(env, { from: `${senderName} <${env.EMAIL_FROM}>`, to: [recipient], subject, html: htmlBody });
  const mode = String(env.MAIL_DELIVERY_MODE || '').toLowerCase();
  if (mode === 'dual') {
    // One successful path marks the event notified. This avoids repeat mails
    // from the healthy provider if the other route is temporarily unavailable.
    const providers = [];
    if (gasRelayReady(env)) providers.push({ name: 'gas', send: gas });
    if (resendReady(env)) providers.push({ name: 'resend', send: resend });
    const result = await deliverMail(providers);
    if (!gasRelayReady(env) || !resendReady(env)) {
      result.partial = true;
      if (!gasRelayReady(env)) result.errors.push('gas: not configured');
      if (!resendReady(env)) result.errors.push('resend: not configured');
    }
    return result;
  }
  if (mode === 'resend_fallback_gas') {
    try {
      return await deliverMail(resendReady(env) ? [{ name: 'resend', send: resend }] : []);
    } catch (error) {
      if (!gasRelayReady(env)) throw error;
      const fallback = await deliverMail([{ name: 'gas', send: gas }]);
      fallback.partial = true;
      fallback.providers = { resend: 'failed', ...fallback.providers };
      fallback.errors.unshift(`resend: ${String(error.message || error).slice(0, 500)}`);
      return fallback;
    }
  }
  if (mode === 'resend') return deliverMail(resendReady(env) ? [{ name: 'resend', send: resend }] : []);
  if (mode === 'gmail') return deliverMail(gmailReady(env) ? [{ name: 'gmail', send: gmail }] : []);
  // Default and explicit "gas": retain the permanent relay until cutover.
  if (gasRelayReady(env)) return deliverMail([{ name: 'gas', send: gas }]);
  if (gmailReady(env)) return deliverMail([{ name: 'gmail', send: gmail }]);
  return deliverMail(resendReady(env) ? [{ name: 'resend', send: resend }] : []);
}
async function sendAndLog(env, type, subject, items, send) {
  try {
    const delivery = await send();
    const result = typeof delivery === 'boolean' ? { sent: delivery, partial: false, providers: {}, errors: [] } : delivery;
    await logNotification(env, type, subject, items, result.sent ? (result.partial ? 'sent_partial' : 'sent') : 'skipped', { providers: result.providers, errors: result.errors });
    return result.sent;
  } catch (error) {
    await logNotification(env, type, subject, items, 'failed', { error: String(error.message || error).slice(0, 1000) });
    throw error;
  }
}
async function sendEmail(env, subject, items, senderName, master) {
  const recipient = (await notificationSettings(env)).notification_email || env.NOTIFICATION_EMAIL;
  if (!items.length || !recipient) return false;
  return sendMail(env, { senderName, recipient, subject, html: notificationHtml(items, master) });
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
  const settings = await notificationSettings(env);
  if (!settings.notifications_enabled) return updateNotificationHistory(history, items);
  const candidates = items.filter((item) => item.notificationKind && notificationTarget(item, master));
  const fresh = settings.notify_new ? candidates.filter((item) => item.notificationKind === 'new') : [];
  const changed = settings.notify_changed ? candidates.filter((item) => item.notificationKind === 'changed' && shouldSendChanged(item, now)) : [];
  const newSubject = `新規：${subjectSummary(fresh, 'new', master.talentMap)}`;
  const changedSubject = `変更：${subjectSummary(changed, 'changed', master.talentMap)}`;
  const sentNew = fresh.length ? await sendAndLog(env, 'new', newSubject, fresh, () => sendEmail(env, newSubject, fresh, 'ホロライブ新規配信通知', master)) : false;
  const sentChanged = changed.length ? await sendAndLog(env, 'changed', changedSubject, changed, () => sendEmail(env, changedSubject, changed, 'ホロライブ配信通知', master)) : false;
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
  const recipient = (await notificationSettings(env)).notification_email || env.NOTIFICATION_EMAIL;
  if (!items.length || !recipient) return false;
  return sendMail(env, { senderName, recipient, subject, html: startNotificationHtml(items) });
}
function imminentReason(item, master) {
  const favoriteIds = new Set(Object.keys(master.favorites));
  const reasons = [];
  if (favoriteIds.has(item.channelId)) reasons.push('★お気に入り');
  if (item.isSpecial || isSpecial(item.title, master.eventKeywords)) reasons.push('◆記念配信');
  const guests = (item.mentions || []).filter((mention) => favoriteIds.has(mention.id) && mention.id !== item.channelId);
  guests.forEach((guest) => reasons.push(`●ゲスト(連携:${mentionDisplayName(guest, master)})`));
  const inferredGuests = (item.detectedMemberIds || []).filter((id) => favoriteIds.has(id) && id !== item.channelId);
  inferredGuests.forEach((id) => reasons.push(`●関連メンバー(タイトル・概要欄:${master.favorites[id]?.name || master.global[id]?.name || id})`));
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
    const settings = await notificationSettings(env); if (!settings.notifications_enabled || !settings.notify_imminent) return;
    const master = await masters(env); await hydrateYoutubeHandles(env, master); const favoriteIds = Object.keys(master.favorites); const globalIds = new Set(Object.keys(master.global));
    const [history, favoriteRaw, specialRaw] = await Promise.all([
      getState(env, 'imminent_notification_history', {}),
      favoriteIds.length ? holodex(env, '/users/live', { channels: favoriteIds.join(',') }) : [],
      holodex(env, '/live', { org: 'Hololive', include: 'mentions,description', max_upcoming_hours: '336' })
    ]);
    const cleanedHistory = Object.fromEntries(Object.entries(history).filter(([, value]) => Number(value?.time || 0) > now - 24 * 3600_000));
    const specialCandidates = specialRaw.filter((raw) => isSpecial(raw.title, master.eventKeywords));
    const allowedExternalIds = await allowedExternalChannelIds(env, specialCandidates, globalIds);
    const specials = specialCandidates.filter((raw) => globalIds.has(raw.channel?.id) || allowedExternalIds.has(raw.channel?.id)).map((raw) => ({ ...enrichGuestSignals(video(raw, globalIds, master.talentMap), master), isSpecial: true })).filter((item) => hasRosterConnection(item, globalIds));
    const candidates = merge([...favoriteRaw.map((raw) => enrichGuestSignals(video(raw, globalIds, master.talentMap), master)), ...specials]).sort((left, right) => new Date(left.startTimeRaw) - new Date(right.startTimeRaw));
    const early = []; const scheduled = [];
    candidates.forEach((item) => {
      const reason = imminentReason(item, master); if (!reason || cleanedHistory[item.videoId]?.notified_imminent) return;
      const diffMinutes = (new Date(item.startTimeRaw).getTime() - now) / 60_000; const withReason = { ...item, passReason: reason };
      if (item.isLive || (diffMinutes <= 0 && diffMinutes >= -15)) early.push(withReason);
      else if (diffMinutes > 0 && diffMinutes <= 20 && isScheduledWindow) scheduled.push(withReason);
    });
    const next = { ...cleanedHistory };
    for (const item of early) {
      const subject = `⚡【開始済み通知】${item.channelTitle} が配信を開始しました（前倒し/フライング）`;
      const sent = await sendAndLog(env, 'imminent_early', subject, [item], () => sendStartEmail(env, subject, [item], 'ホロライブ緊急通知'));
      if (sent) next[item.videoId] = { time: now, notified_imminent: true };
    }
    if (scheduled.length) {
      const subject = `🔔 配信開始: ${scheduled.length}件の注目配信`;
      const sent = await sendAndLog(env, 'imminent_scheduled', subject, scheduled, () => sendStartEmail(env, subject, scheduled, '配信開始通知'));
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
  // Consolidating hot cursors into one state row saves several writes every
  // minute. The legacy keys are read only once after deploying this change.
  let runtime = await getState(env, 'monitor_runtime', null);
  if (!runtime) {
    const [lastRun, processedRssIds, lastYoutubeScan, rssCursor, guestRefreshCursors] = await Promise.all([
      getState(env, 'last_monitor_run', 0), getState(env, 'processed_rss_ids', []), getState(env, 'last_youtube_scan', 0), getState(env, 'rss_channel_cursor', 0), getState(env, 'holodex_guest_refresh_cursor', { live: 0, upcoming: 0, ended: 0 })
    ]);
    runtime = { lastRun, processedRssIds, lastYoutubeScan, rssCursor, guestRefreshCursors };
  }
  const lastRun = runtime.lastRun || 0;
  if (now - Number(lastRun || 0) < monitorInterval(new Date(now))) return { ran: false, discovered: 0 };
  const master = await masters(env); await hydrateYoutubeHandles(env, master); const ids = Object.keys(master.global); const globalIds = new Set(ids);
  const relationalStore = await operationalReady(env);
  const chunks = Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) => ids.slice(index * 50, index * 50 + 50));
  const own = await Promise.all(chunks.map((chunk) => holodex(env, '/live', { channels: chunk.join(','), include: 'mentions,description', max_upcoming_hours: '336' })));
  const external = await holodex(env, '/live', { org: 'Hololive', include: 'mentions,description', limit: '50', max_upcoming_hours: '336' });
  const allowedExternalIds = await allowedExternalChannelIds(env, external, globalIds);
  const permittedExternal = external.filter((raw) => globalIds.has(raw.channel?.id) || allowedExternalIds.has(raw.channel?.id));
  const holodexVideos = [...own.flat(), ...permittedExternal].map((raw) => enrichGuestSignals(video(raw, globalIds, master.talentMap), master)).filter((item) => hasRosterConnection(item, globalIds) && shouldInclude(item, master));
  const [dbAllLive, dbAllUpcoming, dbAllEnded, dbUiLive, dbUiUpcoming, dbUiEnded, dbNotificationHistory, legacyAllLive, legacyAllUpcoming, legacyAllEnded, legacyUiLive, legacyUiUpcoming, legacyUiEnded, legacyNotificationHistory, viewerBuffer, monitorError] = await Promise.all([
    readVideoState(env, 'all', 'live'), readVideoState(env, 'all', 'upcoming'), readVideoState(env, 'all', 'ended'), readVideoState(env, 'ui', 'live'), readVideoState(env, 'ui', 'upcoming'), readVideoState(env, 'ui', 'ended'), readNotificationHistory(env),
    getState(env, 'all_live', []), getState(env, 'all_upcoming', []), getState(env, 'all_ended', []), getState(env, 'ui_live', []), getState(env, 'ui_upcoming', []), getState(env, 'ui_ended', []), getState(env, 'notification_history', {}), getState(env, 'viewer_buffer', {}), getState(env, 'monitor_error', null)
  ]);
  const processedRssIds = runtime.processedRssIds || [];
  const lastYoutubeScan = runtime.lastYoutubeScan || 0;
  const rssCursor = runtime.rssCursor || 0;
  const guestRefreshCursors = runtime.guestRefreshCursors || { live: 0, upcoming: 0, ended: 0 };
  const previousAllLive = dbAllLive ?? legacyAllLive; const previousAllUpcoming = dbAllUpcoming ?? legacyAllUpcoming; const previousAllEnded = dbAllEnded ?? legacyAllEnded;
  const previousUiLive = dbUiLive ?? legacyUiLive; const previousUiUpcoming = dbUiUpcoming ?? legacyUiUpcoming; const previousUiEnded = dbUiEnded ?? legacyUiEnded;
  const notificationHistory = dbNotificationHistory ?? legacyNotificationHistory;
  // Holodex can add mentions while a stream is already running (for example,
  // a surprise guest in a 凸待ち). Refresh tracked videos separately from RSS.
  const guestRefresh = await refreshTrackedGuests(env, { live: previousAllLive, upcoming: previousAllUpcoming, ended: previousAllEnded }, globalIds, master.talentMap, guestRefreshCursors || {});
  let youtubeVideos = []; let nextProcessed = processedRssIds; let nextRssCursor = rssCursor; let scannedYoutube = false;
  if (env.YOUTUBE_API_KEY && now - Number(lastYoutubeScan || 0) >= youtubeInterval(new Date(now))) {
    const holodexIds = new Set(holodexVideos.map((item) => item.videoId));
    const rssBatch = prioritizedRssBatch(ids, master, rssCursor, RSS_CHANNELS_PER_SCAN);
    const rssChannels = rssBatch.channels;
    const rss = await rssIds(rssChannels);
    const candidates = new Set(rss.filter((id) => !holodexIds.has(id) && !processedRssIds.includes(id)));
    const oneDayAgo = now - 86400000;
    previousAllUpcoming.forEach((item) => { const time = new Date(item.startTimeRaw).getTime(); if (!holodexIds.has(item.videoId) && (time > now || time >= oneDayAgo)) candidates.add(item.videoId); });
    youtubeVideos = await youtubeDetails(env, [...candidates]);
    const valid = new Set(youtubeVideos.map((item) => item.videoId));
    nextProcessed = [...new Set([...processedRssIds, ...[...candidates].filter((id) => !valid.has(id))])].slice(-5000);
    nextRssCursor = rssBatch.nextCursor;
    scannedYoutube = true;
  }
  const all = merge([...holodexVideos, ...youtubeVideos, ...guestRefresh.videos]).map((item) => enrichGuestSignals(item, master)).filter((item) => shouldInclude(item, master));
  const favRaw = Object.keys(master.favorites).length ? await holodex(env, '/users/live', { channels: Object.keys(master.favorites).join(',') }) : [];
  const specialRaw = await holodex(env, '/live', { org: 'Hololive', include: 'mentions,description', max_upcoming_hours: '336' });
  const specialCandidates = specialRaw.filter((raw) => isSpecial(raw.title, master.eventKeywords));
  const allowedSpecialExternalIds = await allowedExternalChannelIds(env, specialCandidates, globalIds);
  const specials = specialCandidates.filter((raw) => globalIds.has(raw.channel?.id) || allowedSpecialExternalIds.has(raw.channel?.id)).map((raw) => ({ ...enrichGuestSignals(video(raw, globalIds, master.talentMap), master), isSpecial: true })).filter((item) => hasRosterConnection(item, globalIds));
  const favorites = merge([...favRaw.map((raw) => enrichGuestSignals(video(raw, globalIds, master.talentMap), master)), ...specials, ...all.filter((item) => primaryTarget(item, master))]);
  const keep = now - 90 * 86400000;
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
    // Current Holodex details come last so they replace stale guest data in
    // the 90-day archive instead of being overwritten by the old D1 copy.
    const ended = merge([...previousEnded, ...disappeared, ...items.filter((item) => item.isEnded)]).filter((item) => new Date(item.startTimeRaw).getTime() >= keep).sort((a, b) => new Date(b.startTimeRaw) - new Date(a.startTimeRaw));
    return { live, upcoming, ended };
  };
  const [allState, uiState] = await Promise.all([split(all, previousAllLive, previousAllUpcoming, previousAllEnded), split(classifiedFavorites, previousUiLive, previousUiUpcoming, previousUiEnded)]);
  await syncViewerBufferSheet(env, allState.live, now);
  // A notification provider outage must never discard a successful monitor result.
  const relational = relationalStore;
  await persistVideoStates(env, { allLive: allState.live, allUpcoming: allState.upcoming, allEnded: allState.ended, uiLive: uiState.live, uiUpcoming: uiState.upcoming, uiEnded: uiState.ended }, now);
  await recordViewerSamples(env, allState.live, now);
  const nextRuntime = { lastRun: now, processedRssIds: nextProcessed, rssCursor: scannedYoutube ? nextRssCursor : rssCursor, guestRefreshCursors: guestRefresh.cursors, lastYoutubeScan: scannedYoutube ? now : lastYoutubeScan };
  await setStatesIfChanged(env, { ...(relational ? {} : { all_live: allState.live, all_upcoming: allState.upcoming, all_ended: allState.ended, ui_live: uiState.live, ui_upcoming: uiState.upcoming, ui_ended: uiState.ended, notification_history: notificationHistory, viewer_buffer: updateViewerBuffer(viewerBuffer, allState.live, now) }), monitor_runtime: nextRuntime, ...(monitorError ? { monitor_error: null } : {}) }, { ...(relational ? {} : { all_live: legacyAllLive, all_upcoming: legacyAllUpcoming, all_ended: legacyAllEnded, ui_live: legacyUiLive, ui_upcoming: legacyUiUpcoming, ui_ended: legacyUiEnded, notification_history: legacyNotificationHistory, viewer_buffer: viewerBuffer }), monitor_runtime: runtime, monitor_error: monitorError });
  try {
    const nextHistory = await notifyChanges(env, classifiedFavorites, notificationHistory, master);
    if (nextHistory !== notificationHistory) relational ? await persistNotificationHistory(env, nextHistory, now) : await setState(env, 'notification_history', nextHistory);
  } catch (error) {
    console.error('Notification delivery failed after monitor state was saved.', error);
    await setState(env, 'notification_error', { message: error.message || 'Notification delivery failed', at: new Date(now).toISOString() });
  }
  return { ran: true, discovered: all.length };
}
async function runScheduledMonitor(env) {
  const attemptedAt = new Date().toISOString();
  const now = Date.now();
  let monitorRunId = null;
  // These were separate GAS triggers. Keeping them with the queue consumer
  // removes their D1 work from the 10 ms Free-plan cron invocation.
  for (const [key, interval, task] of [
    ['last_buffer_sheet_cleanup', 12 * 3600_000, () => cleanupOldBufferSheet(env, now)],
    ['last_notification_history_cleanup', 24 * 3600_000, () => autoCleanupNotificationHistory(env, now)],
    ['last_operational_data_cleanup', 24 * 3600_000, () => cleanupOperationalData(env, now)]
  ]) {
    try { await runPeriodicMaintenance(env, key, interval, task, now); }
    catch (error) {
      console.error('Scheduled maintenance failed.', error);
      await setState(env, 'maintenance_error', { message: error.message || 'Scheduled maintenance failed', at: attemptedAt });
    }
  }
  try {
    const runtime = await getState(env, 'monitor_runtime', null);
    const batchStart = Number(runtime?.rssCursor || await getState(env, 'rss_channel_cursor', 0));
    // The history screen remains useful without charging two D1 writes for
    // every healthy minute. Failures are still recorded individually.
    const lastRecorded = await getState(env, 'last_successful_monitor_log', 0);
    const monitorDue = now - Number(runtime?.lastRun || 0) >= monitorInterval(new Date(now));
    const recordSuccess = monitorDue && now - Number(lastRecorded || 0) >= 15 * 60_000;
    if (recordSuccess) monitorRunId = await startMonitorRun(env, 'monitor', batchStart);
    const result = await monitor(env);
    await finishMonitorRun(env, monitorRunId, result?.ran ? 'success' : 'skipped', result?.discovered || 0);
    if (monitorRunId && result?.ran) await setState(env, 'last_successful_monitor_log', now);
    await notifyJustBeforeStart(env);
  } catch (error) {
    console.error('Scheduled monitor failed.', error);
    if (monitorRunId) await finishMonitorRun(env, monitorRunId, 'failed', 0, error.message || 'Scheduled monitor failed');
    else await recordFailedMonitorRun(env, Number((await getState(env, 'monitor_runtime', {}))?.rssCursor || 0), error.message || 'Scheduled monitor failed');
    await setState(env, 'monitor_error', {
      message: error.message || 'Scheduled monitor failed',
      at: attemptedAt
    });
  }
}
function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const bearer = request.headers.get('authorization') || '';
  return bearer === `Bearer ${env.ADMIN_PASSWORD}` || request.headers.get('x-admin-password') === env.ADMIN_PASSWORD;
}
function adminError(env) { return json({ error: env.ADMIN_PASSWORD ? '管理者認証が必要です。' : 'ADMIN_PASSWORD が未設定です。' }, env.ADMIN_PASSWORD ? 401 : 503); }
async function adminApi(request, env, url) {
  if (!isAdmin(request, env)) return adminError(env);
  if (!await operationalReady(env)) return json({ error: 'D1 migration 0002 must be applied first.' }, 503);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/api/admin/overview') {
    const [channels, keywords, words, settings, notifications, runs, errors] = await Promise.all([
      queryAll(env, 'SELECT channel_id, name, group_name, youtube_url, is_global, is_favorite, is_excluded, priority FROM channels ORDER BY is_favorite DESC, priority DESC, name'),
      queryAll(env, 'SELECT category, keyword FROM event_keywords ORDER BY category, keyword'), queryAll(env, 'SELECT keyword FROM exclude_words ORDER BY keyword'),
      queryAll(env, 'SELECT setting_key, setting_value, updated_at FROM app_settings ORDER BY setting_key'),
      queryAll(env, 'SELECT id, video_id, notification_type, subject, status, detail_json, created_at FROM notification_log ORDER BY id DESC LIMIT 100'),
      queryAll(env, 'SELECT id, started_at, finished_at, run_type, rss_batch_start, status, discovered_count, message FROM monitor_runs ORDER BY id DESC LIMIT 100'),
      queryAll(env, "SELECT state_key, state_value, updated_at FROM app_state WHERE state_key IN ('notification_error', 'imminent_notification_error') ORDER BY updated_at DESC")
    ]);
    return json({ channels, keywords, excludeWords: words.map((row) => row.keyword), settings, notifications, runs, errors });
  }
  if (request.method === 'PUT' && path === '/api/admin/channels') {
    const body = await request.json(); const id = String(body.channelId || '').trim();
    if (!/^UC[\w-]+$/.test(id)) return json({ error: '有効なYouTubeチャンネルIDが必要です。' }, 400);
    await env.DB.prepare('INSERT INTO channels (channel_id, name, group_name, youtube_url, is_global, is_favorite, is_excluded, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET name=excluded.name, group_name=excluded.group_name, youtube_url=excluded.youtube_url, is_global=excluded.is_global, is_favorite=excluded.is_favorite, is_excluded=excluded.is_excluded, priority=excluded.priority, updated_at=CURRENT_TIMESTAMP').bind(id, String(body.name || '').trim(), String(body.groupName || '').trim(), String(body.youtubeUrl || '').trim(), body.isGlobal ? 1 : 0, body.isFavorite ? 1 : 0, body.isExcluded ? 1 : 0, Math.max(0, Math.min(10, Number(body.priority || 0)))).run();
    return json({ status: 'ok' });
  }
  const channelMatch = /^\/api\/admin\/channels\/([^/]+)$/.exec(path);
  if (request.method === 'DELETE' && channelMatch) { await env.DB.prepare('DELETE FROM channels WHERE channel_id=?').bind(decodeURIComponent(channelMatch[1])).run(); return json({ status: 'ok' }); }
  if (request.method === 'PUT' && path === '/api/admin/event-keywords') {
    const body = await request.json(); const category = String(body.category || '').trim(); const keyword = String(body.keyword || '').trim();
    if (!category || !keyword) return json({ error: 'カテゴリとキーワードが必要です。' }, 400);
    await env.DB.prepare('INSERT OR IGNORE INTO event_keywords (category, keyword) VALUES (?, ?)').bind(category, keyword).run(); return json({ status: 'ok' });
  }
  const keywordMatch = /^\/api\/admin\/event-keywords\/(.+)\/(.+)$/.exec(path);
  if (request.method === 'DELETE' && keywordMatch) { await env.DB.prepare('DELETE FROM event_keywords WHERE category=? AND keyword=?').bind(decodeURIComponent(keywordMatch[1]), decodeURIComponent(keywordMatch[2])).run(); return json({ status: 'ok' }); }
  if (request.method === 'PUT' && path === '/api/admin/exclude-words') {
    const body = await request.json(); const keyword = String(body.keyword || '').trim(); if (!keyword) return json({ error: '除外ワードが必要です。' }, 400);
    await env.DB.prepare('INSERT OR IGNORE INTO exclude_words (keyword) VALUES (?)').bind(keyword).run(); return json({ status: 'ok' });
  }
  const wordMatch = /^\/api\/admin\/exclude-words\/(.+)$/.exec(path);
  if (request.method === 'DELETE' && wordMatch) { await env.DB.prepare('DELETE FROM exclude_words WHERE keyword=?').bind(decodeURIComponent(wordMatch[1])).run(); return json({ status: 'ok' }); }
  if (request.method === 'PUT' && path === '/api/admin/settings') {
    const body = await request.json(); const allowed = new Set(['notifications_enabled', 'notify_new', 'notify_changed', 'notify_imminent', 'notification_email']);
    if (body.notification_email !== undefined && body.notification_email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.notification_email))) return json({ error: '通知先メールアドレスの形式が正しくありません。' }, 400);
    const entries = Object.entries(body || {}).filter(([key]) => allowed.has(key));
    if (!entries.length) return json({ error: '変更可能な設定がありません。' }, 400);
    await env.DB.batch(entries.map(([key, value]) => env.DB.prepare('INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value, updated_at=CURRENT_TIMESTAMP').bind(key, key === 'notification_email' ? String(value || '') : value ? '1' : '0')));
    return json({ status: 'ok' });
  }
  return json({ error: 'Not found' }, 404);
}
async function notificationSettings(env) {
  if (!await operationalReady(env)) return { notifications_enabled: true, notify_new: true, notify_changed: true, notify_imminent: true, notification_email: '' };
  const rows = await queryAll(env, "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('notifications_enabled', 'notify_new', 'notify_changed', 'notify_imminent', 'notification_email')");
  const values = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  return { notifications_enabled: values.notifications_enabled !== '0', notify_new: values.notify_new !== '0', notify_changed: values.notify_changed !== '0', notify_imminent: values.notify_imminent !== '0', notification_email: values.notification_email || '' };
}
async function api(request, env, url) {
  if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url);
  const legacyAction = url.searchParams.get('action');
  const legacyAll = url.pathname === '/' && url.searchParams.get('mode') === 'all';
  if (url.pathname === '/api/videos' || legacyAll) {
    const all = url.searchParams.get('mode') === 'all'; const master = await masters(env);
    const scope = all ? 'all' : 'ui';
    const [dbLive, dbUpcoming, dbEnded, monitorError] = await Promise.all([readVideoState(env, scope, 'live'), readVideoState(env, scope, 'upcoming'), readVideoState(env, scope, 'ended'), getState(env, 'monitor_error', null)]);
    const [legacyLive, legacyUpcoming, legacyEnded] = dbLive === null ? await Promise.all([getState(env, all ? 'all_live' : 'ui_live', []), getState(env, all ? 'all_upcoming' : 'ui_upcoming', []), getState(env, all ? 'all_ended' : 'ui_ended', [])]) : [[], [], []];
    const live = dbLive ?? legacyLive; const upcoming = dbUpcoming ?? legacyUpcoming; const ended = dbEnded ?? legacyEnded;
    const videos = all ? [...live, ...upcoming] : [...live, ...upcoming, ...ended];
    if (!all && monitorError?.message) videos.unshift({ isSystemError: true, message: monitorError.message, timestamp: Date.now() });
    return json({ videos, live, upcoming, ended, favorites: Object.keys(master.favorites), ...(all ? { lastUpdate: new Date().toISOString() } : {}) });
  }
  const viewerMatch = /^\/api\/videos\/([^/]+)\/viewers$/.exec(url.pathname);
  if (request.method === 'GET' && viewerMatch) {
    if (!await operationalReady(env)) return json({ samples: [] });
    const videoId = decodeURIComponent(viewerMatch[1]); const since = Number(url.searchParams.get('since') || Date.now() - 90 * 86400_000);
    const samples = await queryAll(env, 'SELECT observed_at, viewers FROM viewer_samples WHERE video_id=? AND observed_at>=? ORDER BY observed_at ASC LIMIT 3000', videoId, since);
    return json({ videoId, samples });
  }
  if (request.method === 'GET' && url.pathname === '/api/history') {
    if (!await operationalReady(env)) return json({ videos: [] });
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50))); const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const rows = await queryAll(env, "SELECT data_json FROM videos WHERE status='ended' AND ended_at>=? ORDER BY ended_at DESC LIMIT ? OFFSET ?", Date.now() - 90 * 86400_000, limit, offset);
    return json({ videos: rows.flatMap((row) => { try { return [JSON.parse(row.data_json)]; } catch { return []; } }), limit, offset });
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
    // Workers Free allows only 10 ms of CPU for Cron Triggers. Queueing a
    // tiny job here keeps the schedule reliable; the Queue consumer performs
    // the network-heavy monitor work with its own longer execution budget.
    context.waitUntil(env.MONITOR_QUEUE.send({ requestedAt: event.scheduledTime || Date.now() }));
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      await runScheduledMonitor(env);
      message.ack();
    }
  }
};
