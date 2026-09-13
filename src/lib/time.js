export function formatTokyo(date, format = 'MM/dd HH:mm') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return format === 'MM/dd'
    ? `${values.month}/${values.day}`
    : `${values.month}/${values.day} ${values.hour}:${values.minute}`;
}

export function dayDifference(target, base = new Date()) {
  const targetTokyo = formatTokyo(target, 'MM/dd');
  const baseTokyo = formatTokyo(base, 'MM/dd');
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric' }).format(base);
  const targetMs = Date.parse(`${year}-${targetTokyo.replace('/', '-')}T00:00:00Z`);
  const baseMs = Date.parse(`${year}-${baseTokyo.replace('/', '-')}T00:00:00Z`);
  return Math.round((targetMs - baseMs) / 86_400_000);
}

