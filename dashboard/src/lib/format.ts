export function formatDuration(seconds: number | null | undefined) {
  const safeSeconds = Math.max(0, Math.floor(seconds ?? 0));
  if (safeSeconds < 60) {
    return `${safeSeconds}s`;
  }
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

export function formatTokenCount(value: number | null | undefined) {
  const safeValue = Math.max(0, Math.floor(value ?? 0));
  if (safeValue >= 1_000_000) {
    return `${new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 1
    }).format(safeValue / 1_000_000)}M`;
  }
  return formatNumber(safeValue);
}

export function formatUsd(value: number | null | undefined) {
  return new Intl.NumberFormat('en-US', {
    currency: 'USD',
    maximumFractionDigits: 4,
    style: 'currency'
  }).format(value ?? 0);
}

export function formatPercent(value: number | null | undefined) {
  if (value == null) return '-';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 1,
    style: 'percent'
  }).format(value);
}

export function formatDate(value: number | null | undefined) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit'
  }).format(value);
}

export function formatDateTime(value: number | null | undefined) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value);
}

export function formatRelativeTime(value: number | null | undefined, now = Date.now()) {
  if (!value) return '尚未采集';
  const minutes = Math.max(0, Math.floor((now - value) / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
