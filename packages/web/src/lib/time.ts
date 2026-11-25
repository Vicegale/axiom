const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

export function hm(iso: string): string {
  const t = new Date(iso);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

export function dateShort(iso: string): string {
  const t = new Date(iso);
  return `${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

export function dayKey(iso: string): string {
  const t = new Date(iso);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today, 25 Nov", "Yesterday, 24 Nov", "Mon 23 Nov". */
export function dayLabel(iso: string, now: Date): string {
  const t = new Date(iso);
  const diff = Math.round((dayStart(now) - dayStart(t)) / DAY);
  if (diff === 0) return `Today, ${dateShort(iso)}`;
  if (diff === 1) return `Yesterday, ${dateShort(iso)}`;
  return `${WEEKDAYS[t.getDay()]} ${dateShort(iso)}`;
}

/** Time when on the same day as `now`, otherwise date plus time. */
export function stamp(iso: string, now: Date): string {
  return dayKey(iso) === dayKey(now.toISOString()) ? hm(iso) : `${dateShort(iso)} ${hm(iso)}`;
}

export function fullStamp(iso: string): string {
  return `${dateShort(iso)} ${hm(iso)}`;
}

/** "9 min ago" (or compact "9 min", "3 h", "21 d"); older than 30 days falls back to a date. */
export function ago(iso: string, now: Date, compact = false): string {
  const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  const tail = compact ? "" : " ago";
  if (m < 1) return "now";
  if (m < 60) return `${m} min${tail}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h${tail}`;
  const days = Math.round(m / 1440);
  if (days < 30) return `${days} d${tail}`;
  return dateShort(iso);
}

export function idleDays(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / DAY);
}
