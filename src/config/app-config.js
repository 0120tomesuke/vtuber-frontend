export const appConfig = Object.freeze({
  sheets: {
    favorites: 'お気に入りチャンネル',
    excludes: '除外チャンネル',
    eventKeywords: 'イベントキーワード',
    global: '全体チャンネル',
    excludeWords: '除外ワード',
    talentMap: 'チャンネル置き換え',
    statsBuffer: '同接バッファ'
  },
  polling: {
    activeIntervalMs: 80_000,
    inactiveIntervalMs: 900_000,
    activeStartHour: 10,
    activeEndHour: 2
  },
  retention: {
    endedVideosDays: 2,
    notificationHistoryDays: 7,
    imminentNotificationHours: 24,
    viewerBufferHours: 12
  }
});

