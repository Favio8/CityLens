/** 通用格式化：坐标、年份、时间、数值。 */

export function formatCoord(coord: readonly [number, number] | null | undefined): string {
  if (!coord) return '待考';
  const [lng, lat] = coord;
  const latText = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
  const lngText = `${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
  return `${latText}, ${lngText}`;
}

export function formatYear(year: number | null | undefined): string {
  if (year === null || year === undefined) return '今';
  return year < 0 ? `公元前 ${Math.abs(year)} 年` : `${year} 年`;
}

export function formatPeriod(start: number, end: number | null): string {
  const startText = start < 0 ? `前${Math.abs(start)}` : `${start}`;
  if (end === null) return `${startText} 年至今`;
  const endText = end < 0 ? `前${Math.abs(end)}` : `${end}`;
  return `${startText}—${endText} 年`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '待考';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatRetry(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '稍后';
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}
