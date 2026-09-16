/**
 * Cloudflare Worker notification relay.
 *
 * Store a long random value as Script Property MAIL_RELAY_TOKEN, then deploy
 * this script as a Web App that executes as the deploying user.
 */
function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const properties = PropertiesService.getScriptProperties();
    const expectedToken = properties.getProperty('MAIL_RELAY_TOKEN');
    if (!expectedToken || payload.token !== expectedToken) return json({ ok: false, error: 'unauthorized' });

    const recipient = String(payload.recipient || '').trim();
    const subject = String(payload.subject || '').trim();
    const htmlBody = String(payload.html || '');
    if (!recipient || !subject || !htmlBody) return json({ ok: false, error: 'missing required mail fields' });

    // A Worker may receive a 404 while following GAS's response redirect even
    // though MailApp already sent. Keep a durable receipt for retry attempts.
    const deliveryId = String(payload.deliveryId || '').trim();
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const key = deliveryId ? relayReceiptKey(recipient, deliveryId) : '';
      if (key && properties.getProperty(key)) return json({ ok: true, duplicate: true });
      cleanupRelayReceipts(properties);
      MailApp.sendEmail({
        to: recipient,
        subject,
        body: 'HTMLメールを表示できない環境です。',
        htmlBody,
        name: String(payload.senderName || 'Holo Alpha')
      });
      if (key) properties.setProperty(key, String(Date.now()));
      return json({ ok: true, remainingQuota: MailApp.getRemainingDailyQuota() });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: String(error && error.message || error) });
  }
}

function relayReceiptKey(recipient, deliveryId) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, recipient + '\n' + deliveryId);
  return 'MAIL_RELAY_SENT_' + bytes.map(function (byte) {
    return ('0' + (byte & 255).toString(16)).slice(-2);
  }).join('');
}

function cleanupRelayReceipts(properties) {
  const now = Date.now();
  const marker = 'MAIL_RELAY_CLEANED_AT';
  if (now - Number(properties.getProperty(marker) || 0) < 86400000) return;
  const cutoff = now - 8 * 86400000;
  const entries = properties.getProperties();
  Object.keys(entries).forEach(function (key) {
    if (key.indexOf('MAIL_RELAY_SENT_') === 0 && Number(entries[key]) < cutoff) properties.deleteProperty(key);
  });
  properties.setProperty(marker, String(now));
}

function doGet() {
  return json({ ok: true, service: 'hololive-live-monitor-mail-relay' });
}

function json(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
