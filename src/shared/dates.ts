export function displayDay(day: string | null | undefined) {
  return day ? day.slice(0, 10).split('-').reverse().join('.') : '—';
}
export function displayUpdated(timestamp: string) {
  const parts = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  return `${get('day')}.${get('month')}.${get('year')}, ${get('hour')}:${get('minute')}`;
}
