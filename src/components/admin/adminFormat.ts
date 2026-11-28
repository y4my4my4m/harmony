import { i18n, getLocale } from '@/i18n'

const t = (key: string) => i18n.global.t(key)

export const formatNumber = (num: number | undefined) => {
  if (num === undefined || num === null) return '0'
  return new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(num)
}

/** An age in seconds: "just now", "4 minutes ago", "2 hours ago", "3 days ago". */
export const formatAge = (seconds: number): string => {
  const min = Math.floor(seconds / 60)
  if (min < 1) return t('time.justNow')
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always', style: 'long' })
  if (min < 60) return rtf.format(-min, 'minute')
  const hours = Math.floor(min / 60)
  if (hours < 24) return rtf.format(-hours, 'hour')
  return rtf.format(-Math.floor(hours / 24), 'day')
}

export const formatDate = (date: string) => {
  return new Date(date).toLocaleDateString(getLocale())
}

export const formatTime = (date: Date) => {
  return date.toLocaleTimeString(getLocale())
}

export const formatTimeAgo = (dateStr: string | null): string => {
  if (!dateStr) return t('admin.format.never')
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return t('admin.format.justNow')
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always', style: 'narrow' })
  if (diffMin < 60) return rtf.format(-diffMin, 'minute')
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return rtf.format(-diffHrs, 'hour')
  const diffDays = Math.floor(diffHrs / 24)
  if (diffDays < 30) return rtf.format(-diffDays, 'day')
  return date.toLocaleDateString(getLocale())
}

export const formatRelativeTime = (dateString: string) => {
  if (!dateString) return t('admin.format.never')
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return t('time.today')
  if (diffDays === 1) return t('time.yesterday')
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always' })
  if (diffDays < 7) return rtf.format(-diffDays, 'day')
  if (diffDays < 30) return rtf.format(-Math.floor(diffDays / 7), 'week')
  return rtf.format(-Math.floor(diffDays / 30), 'month')
}
