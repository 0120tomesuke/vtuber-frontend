import test from 'node:test';
import assert from 'node:assert/strict';
import { appConfig } from '../src/config/app-config.js';
import { parseMasterData } from '../src/integrations/google-sheets-client.js';

const range = (sheet, columns) => `'${sheet}'!${columns}`;

test('parseMasterData preserves the current spreadsheet master rules', () => {
  const data = new Map([
    [range(appConfig.sheets.favorites, 'A:C'), [['name', 'channelId', 'enabled'], ['A', 'UC_A', '1'], ['B', 'UC_B', '0']]],
    [range(appConfig.sheets.excludes, 'A:C'), [['name', 'channelId'], ['X', 'UC_X']]],
    [range(appConfig.sheets.excludeWords, 'A:A'), [[' Spoiler ']]],
    [range(appConfig.sheets.eventKeywords, 'A:ZZ'), [['Birthday', 'Anniversary'], ['BD', 'Anniv']]],
    [range(appConfig.sheets.talentMap, 'A:B'), [['from', 'to'], ['Raw name', 'Display name']]]
  ]);
  const master = parseMasterData(data);
  assert.deepEqual(master.favorites, { UC_A: { name: 'A', isNotifyEnabled: true } });
  assert.deepEqual(master.excludes, ['UC_X']);
  assert.deepEqual(master.excludeWords, ['spoiler']);
  assert.deepEqual(master.eventKeywords, { Birthday: ['BD'], Anniversary: ['Anniv'] });
  assert.equal(master.talentMap['Raw name'], 'Display name');
});

