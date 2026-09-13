import { google } from 'googleapis';
import { env, requireEnv } from '../config/env.js';
import { appConfig } from '../config/app-config.js';

const range = (sheetName, columns) => `'${sheetName}'!${columns}`;

function enabled(value) {
  return String(value ?? '').trim() === '1';
}

export function parseMasterData(valuesByRange) {
  const sheets = appConfig.sheets;
  const values = (sheetName) => valuesByRange.get(range(sheetName, sheetName === sheets.eventKeywords ? 'A:ZZ' : sheetName === sheets.excludeWords ? 'A:A' : sheetName === sheets.talentMap ? 'A:B' : 'A:C')) || [];
  const favorites = {};
  const favoriteRows = values(sheets.favorites);
  favoriteRows.slice(1).forEach(([name, channelId, notifyEnabled]) => {
    const id = String(channelId ?? '').trim();
    if (id && enabled(notifyEnabled)) favorites[id] = { name: String(name ?? '').trim(), isNotifyEnabled: true };
  });

  const excludes = values(sheets.excludes).slice(1).map((row) => String(row[1] ?? '').trim()).filter(Boolean);
  const excludeWords = values(sheets.excludeWords).map(([word]) => String(word ?? '').trim().toLowerCase()).filter(Boolean);
  const talentMap = Object.fromEntries(values(sheets.talentMap).slice(1).map(([from, to]) => [String(from ?? '').trim(), String(to ?? '').trim()]).filter(([from, to]) => from && to));
  const [headers = [], ...keywordRows] = values(sheets.eventKeywords);
  const eventKeywords = Object.fromEntries(headers.map((header, columnIndex) => [String(header ?? '').trim(), keywordRows.map((row) => row[columnIndex]).filter(Boolean)]).filter(([header]) => header));

  return { favorites, excludes, excludeWords, talentMap, eventKeywords };
}

export function createGoogleSheetsClient({
  spreadsheetId = env.googleSheetsId,
  serviceAccountJson = env.googleServiceAccountJson,
  sheetsApi
} = {}) {
  let api = sheetsApi;
  const masterRanges = [
    range(appConfig.sheets.favorites, 'A:C'),
    range(appConfig.sheets.excludes, 'A:C'),
    range(appConfig.sheets.excludeWords, 'A:A'),
    range(appConfig.sheets.eventKeywords, 'A:ZZ'),
    range(appConfig.sheets.talentMap, 'A:B'),
    range(appConfig.sheets.global, 'A:B')
  ];

  function getSpreadsheetId() {
    if (!spreadsheetId) requireEnv('GOOGLE_SHEETS_ID');
    return spreadsheetId;
  }

  function getApi() {
    if (api) return api;
    if (!serviceAccountJson) requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON');
    let credentials;
    try {
      credentials = JSON.parse(serviceAccountJson);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON');
    }
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    api = google.sheets({ version: 'v4', auth });
    return api;
  }

  return Object.freeze({
    async loadMasterData() {
      const response = await getApi().spreadsheets.values.batchGet({ spreadsheetId: getSpreadsheetId(), ranges: masterRanges });
      const valuesByRange = new Map(response.data.valueRanges.map((item) => [item.range, item.values || []]));
      // Google may normalize quoted ranges; map them back to the requested logical sheet name.
      masterRanges.forEach((requested, index) => valuesByRange.set(requested, response.data.valueRanges[index]?.values || []));
      return parseMasterData(valuesByRange);
    },

    async loadGlobalChannels() {
      const response = await getApi().spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: range(appConfig.sheets.global, 'A:B') });
      return Object.fromEntries((response.data.values || []).slice(1).map(([name, channelId]) => [String(channelId ?? '').trim(), { name: String(name ?? '').trim() }]).filter(([id]) => id.startsWith('UC')));
    },

    async updateFavorite(channelId, isFavorite) {
      const target = String(channelId);
      const sheetRange = range(appConfig.sheets.favorites, 'A:C');
      const response = await getApi().spreadsheets.values.get({ spreadsheetId: getSpreadsheetId(), range: sheetRange });
      const rowIndex = (response.data.values || []).findIndex((row, index) => index > 0 && String(row[1] ?? '').trim() === target);
      if (rowIndex < 0) return false;
      await getApi().spreadsheets.values.update({
        spreadsheetId: getSpreadsheetId(),
        range: range(appConfig.sheets.favorites, `C${rowIndex + 1}`),
        valueInputOption: 'RAW',
        requestBody: { values: [[isFavorite ? 1 : 0]] }
      });
      return true;
    }
  });
}

