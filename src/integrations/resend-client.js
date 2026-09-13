import { env, requireEnv } from '../config/env.js';

export class EmailDeliveryError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'EmailDeliveryError';
    this.status = status;
  }
}

export function createResendClient({ apiKey = env.resendApiKey, from = env.emailFrom, to = env.notificationEmail, fetchFn = fetch } = {}) {
  return Object.freeze({
    async send({ subject, html, senderName }) {
      if (!apiKey) requireEnv('RESEND_API_KEY');
      if (!from) requireEnv('EMAIL_FROM');
      if (!to) requireEnv('NOTIFICATION_EMAIL');
      let response;
      try {
        response = await fetchFn('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: senderName ? `${senderName} <${from}>` : from, to: [to], subject, html })
        });
      } catch (cause) {
        throw new EmailDeliveryError('メール配信サービスへの接続に失敗しました', { cause });
      }
      if (!response.ok) throw new EmailDeliveryError(`メール配信サービスのエラー: HTTP ${response.status}`, { status: response.status });
      return response.json();
    }
  });
}

