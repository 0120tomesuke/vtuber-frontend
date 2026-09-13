import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StateKey } from '../repositories/postgres-state-store.js';

function json(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function icalEscape(value) {
  return String(value || '').replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\n', '\\n');
}

function icalDate(value) {
  return new Date(value).toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const mimeTypes = Object.freeze({ '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' });

export function createApiServer({ stateStore, sheetsClient, staticDir }) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { status: 'ok' });
      }

      if (request.method === 'GET' && staticDir) {
        const requestedPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const extension = path.extname(requestedPath).toLowerCase();
        const resolvedPath = path.resolve(staticDir, requestedPath);
        if (mimeTypes[extension] && resolvedPath.startsWith(`${path.resolve(staticDir)}${path.sep}`)) {
          try {
            const content = await readFile(resolvedPath);
            response.writeHead(200, { 'content-type': mimeTypes[extension] });
            return response.end(content);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/videos') {
        const mode = url.searchParams.get('mode') || 'fav';
        const [uiLive, uiUpcoming, uiEnded, allLive, allUpcoming, allEnded, master, error] = await Promise.all([
          stateStore.get(StateKey.UI_LIVE, []), stateStore.get(StateKey.UI_UPCOMING, []), stateStore.get(StateKey.UI_ENDED, []),
          stateStore.get(StateKey.ALL_LIVE, []), stateStore.get(StateKey.ALL_UPCOMING, []), stateStore.get(StateKey.ALL_ENDED, []),
          sheetsClient.loadMasterData(), stateStore.get(StateKey.UI_ERROR, null)
        ]);
        const isAll = mode === 'all';
        const live = isAll ? allLive : uiLive;
        const upcoming = isAll ? allUpcoming : uiUpcoming;
        const ended = isAll ? allEnded : uiEnded;
        const videos = isAll ? [...live, ...upcoming] : [...live, ...upcoming, ...ended];
        if (error && !isAll) videos.unshift({ isSystemError: true, message: error.message || 'データ更新中にエラーが発生しました。', timestamp: Date.now() });
        return json(response, 200, {
          videos,
          live, upcoming, ended,
          favorites: Object.keys(master.favorites),
          ...(isAll ? { lastUpdate: new Date().toISOString() } : {})
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/favorites') {
        const master = await sheetsClient.loadMasterData();
        return json(response, 200, Object.keys(master.favorites));
      }

      const favoriteMatch = /^\/api\/favorites\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'PATCH' && favoriteMatch) {
        const body = await readBody(request);
        if (typeof body.isFavorite !== 'boolean') return json(response, 400, { error: 'isFavorite must be a boolean' });
        const channelId = decodeURIComponent(favoriteMatch[1]);
        const updated = await sheetsClient.updateFavorite(channelId, body.isFavorite);
        return updated ? json(response, 200, { status: 'success', channelId, isFavorite: body.isFavorite }) : json(response, 404, { error: 'Channel not found' });
      }

      if (request.method === 'GET' && url.pathname === '/calendar.ics') {
        const upcoming = await stateStore.get(StateKey.UI_UPCOMING, []);
        const events = upcoming.filter((video) => video.startTimeRaw).map((video) => [
          'BEGIN:VEVENT', `UID:${icalEscape(video.videoId)}@hololive-live-monitor`, `DTSTAMP:${icalDate(new Date())}`,
          `DTSTART:${icalDate(video.startTimeRaw)}`, `SUMMARY:${icalEscape(video.title)}`,
          `DESCRIPTION:${icalEscape(`${video.channelTitle}\\n${video.videoUrl}`)}`, `URL:${icalEscape(video.videoUrl)}`, 'END:VEVENT'
        ].join('\r\n'));
        response.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="hololive-live.ics"' });
        return response.end(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hololive Live Monitor//JP', ...events, 'END:VCALENDAR', ''].join('\r\n'));
      }

      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      return json(response, error instanceof SyntaxError ? 400 : 500, { error: error.message || 'Internal server error' });
    }
  });
}

