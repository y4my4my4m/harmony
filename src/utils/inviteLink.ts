import type { Invite } from '@/services/inviteService'

/** Expiry choices in minutes; 0 never expires. */
export const EXPIRY_CHOICES: readonly number[] = [30, 60, 360, 720, 1440, 10080, 0]

/** Use caps; 0 is unlimited. */
export const MAX_USE_CHOICES: readonly number[] = [0, 1, 5, 10, 25, 50, 100]

/**
 * Expiry choices within a server's cap, in minutes. A cap of 0 allows every
 * choice; any other cap excludes "never".
 */
export function allowedExpiryChoices(maxExpiration: number): number[] {
  if (maxExpiration <= 0) return [...EXPIRY_CHOICES]
  return EXPIRY_CHOICES.filter((m) => m > 0 && m <= maxExpiration)
}

/** Use caps within a server's limit. A limit of 0 allows every choice. */
export function allowedMaxUseChoices(maxUses: number): number[] {
  if (maxUses <= 0) return [...MAX_USE_CHOICES]
  return MAX_USE_CHOICES.filter((n) => n > 0 && n <= maxUses)
}

/**
 * `wanted` when allowed, else the largest allowed finite choice below it, else
 * the first choice. 0 (never / unlimited) sorts above every finite value.
 */
export function pickChoice(choices: number[], wanted: number): number {
  if (choices.includes(wanted)) return wanted
  const rank = (n: number) => (n === 0 ? Infinity : n)
  const below = choices.filter((c) => rank(c) < rank(wanted)).sort((a, b) => rank(b) - rank(a))
  return below[0] ?? choices[0] ?? 0
}

export function isInviteExpired(invite: Pick<Invite, 'expires_at'>, now = Date.now()): boolean {
  return !!invite.expires_at && new Date(invite.expires_at).getTime() <= now
}

export function isInviteUsedUp(invite: Pick<Invite, 'uses' | 'max_uses'>): boolean {
  return !!invite.max_uses && (invite.uses ?? 0) >= invite.max_uses
}

/** Accepts joins: not revoked (revocation sets `used`), not expired, uses left. */
export function isInviteActive(
  invite: Pick<Invite, 'used' | 'expires_at' | 'uses' | 'max_uses'>,
  now = Date.now(),
): boolean {
  return !invite.used && !isInviteExpired(invite, now) && !isInviteUsedUp(invite)
}

/** A whole-minute duration in its largest exact unit: 1440 is 1 day, 90 is 90 minutes. */
export function durationParts(minutes: number): { unit: 'minute' | 'hour' | 'day'; count: number } {
  if (minutes >= 1440 && minutes % 1440 === 0) return { unit: 'day', count: minutes / 1440 }
  if (minutes >= 60 && minutes % 60 === 0) return { unit: 'hour', count: minutes / 60 }
  return { unit: 'minute', count: minutes }
}

/**
 * Time until `expiresAt` as a value and unit for Intl.RelativeTimeFormat, in
 * the largest unit whose rounded count is at least 1: a day-long link reads
 * "1 day" a minute after creation, not "23 hours".
 */
export function timeUntil(
  expiresAt: string,
  now = Date.now(),
): { value: number; unit: 'minute' | 'hour' | 'day' } {
  const minutes = Math.max(0, (new Date(expiresAt).getTime() - now) / 60000)
  if (Math.round(minutes / 60) >= 24) return { value: Math.round(minutes / 1440), unit: 'day' }
  if (Math.round(minutes) >= 60) return { value: Math.round(minutes / 60), unit: 'hour' }
  return { value: Math.max(1, Math.round(minutes)), unit: 'minute' }
}

export function buildInviteUrl(code: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${code}`
}

/** Invite code from a URL built by buildInviteUrl, or null. */
export function inviteCodeFromUrl(url: string): string | null {
  return /\/invite\/([^/?#]+)/.exec(url)?.[1] ?? null
}
