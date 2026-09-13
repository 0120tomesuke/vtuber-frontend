/**
 * Cloudflare Worker notification relay.
 *
 * Store a long random value as Script Property MAIL_RELAY_TOKEN, then deploy
 * this script as a Web App that executes as the deploying user.
 */
function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const expectedToken = PropertiesService.getScriptProperties().getProperty('MAIL_RELAY_TOKEN');
    if (!expectedToken || payload.token !== expectedToken) return json({ ok: false, error: 'unauthorized' });

    const recipient = String(payload.recipient || '').trim();
    const subject = String(payload.subject || '').trim();
    const htmlBody = String(payload.html || '');
    if (!recipient || !subject || !htmlBody) return json({ ok: false, error: 'missing required mail fields' });

    MailApp.sendEmail({
      to: recipient,
      subject,
      body: 'HTMLメールを表示できない環境です。',
      htmlBody,
      name: String(payload.senderName || 'Holo Alpha')
    });
    return json({ ok: true, remainingQuota: MailApp.getRemainingDailyQuota() });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: String(error && error.message || error) });
  }
}

function doGet() {
  return json({ ok: true, service: 'hololive-live-monitor-mail-relay' });
}

function json(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
