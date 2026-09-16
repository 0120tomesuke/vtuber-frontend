import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

test('GAS relay sends each delivery ID only once, including after a lost response', () => {
  const properties = new Map([['MAIL_RELAY_TOKEN', 'secret']]);
  const sent = [];
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: (key) => properties.delete(key),
      getProperties: () => Object.fromEntries(properties)
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_algorithm, value) => [...createHash('sha256').update(value).digest()]
    },
    MailApp: { sendEmail: (mail) => sent.push(mail), getRemainingDailyQuota: () => 99 },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ text, setMimeType() { return this; } }) },
    console
  });
  vm.runInContext(readFileSync(new URL('../gas/mail-relay.gs', import.meta.url), 'utf8'), context);
  const post = (deliveryId) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({
    token: 'secret', deliveryId, recipient: 'recipient@example.com', subject: 'Test', html: '<p>Test</p>'
  }) } }).text);

  assert.equal(post('new:video-1').ok, true);
  assert.equal(post('new:video-1').duplicate, true);
  assert.equal(sent.length, 1);
  assert.equal(post('new:video-2').ok, true);
  assert.equal(sent.length, 2);
});
