import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/web/api-server.js';

test('FAV video endpoint follows the existing frontend response contract', async () => {
  const state = { ui_live: [{ videoId: 'live' }], ui_upcoming: [{ videoId: 'upcoming' }], ui_ended: [{ videoId: 'ended' }] };
  const server = createApiServer({ stateStore: { get: async (key, fallback) => state[key] ?? fallback }, sheetsClient: { loadMasterData: async () => ({ favorites: { UC1: {} } }) } });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/videos?mode=fav`);
  const body = await response.json();
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(body.videos.map((video) => video.videoId), ['live', 'upcoming', 'ended']);
  assert.deepEqual(body.favorites, ['UC1']);
});

test('favorite updates require a boolean payload', async () => {
  const server = createApiServer({ stateStore: {}, sheetsClient: {} });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/favorites/UC1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isFavorite: 'true' }) });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(response.status, 400);
});

