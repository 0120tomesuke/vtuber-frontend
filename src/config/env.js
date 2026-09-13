const optional = (name) => process.env[name]?.trim() || undefined;

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  timeZone: process.env.APP_TIME_ZONE || 'Asia/Tokyo',
  holodexApiKey: optional('HOLODEX_API_KEY'),
  youtubeApiKey: optional('YOUTUBE_API_KEY'),
  googleSheetsId: optional('GOOGLE_SHEETS_ID'),
  googleServiceAccountJson: optional('GOOGLE_SERVICE_ACCOUNT_JSON'),
  databaseUrl: optional('DATABASE_URL'),
  resendApiKey: optional('RESEND_API_KEY'),
  notificationEmail: optional('NOTIFICATION_EMAIL'),
  emailFrom: optional('EMAIL_FROM')
});

export function requireEnv(...names) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

