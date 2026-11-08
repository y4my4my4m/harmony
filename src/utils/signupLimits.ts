/**
 * Sign-up limits: the text GoTrue relays from public.before_user_created_hook
 * (20261109100001_signup_limits.sql) and the values of its settings in instance_config.
 *
 * A hook error carries a status and text, no code, so the text keys the translation. A client
 * without this table, or a hook text that differs, shows the English text GoTrue sent.
 */
const REFUSALS: Readonly<Record<string, string>> = {
  'Too many accounts were created from this network today. Try again tomorrow, or ask this instance\'s admin for an invitation.':
    'auth.signupRefused.ipCap',
  'Too many accounts were created with this email domain today. Try again tomorrow, or ask this instance\'s admin for an invitation.':
    'auth.signupRefused.domainCap',
  'This email inbox has reached the limit of accounts on this instance.':
    'auth.signupRefused.mailboxCap',
  'This email provider cannot be used to sign up on this instance. Use another address.':
    'auth.signupRefused.blockedDomain',
}

export function signupRefusalKey(error: unknown): string | null {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? (REFUSALS[message.trim()] ?? null) : null
}

export const SIGNUP_CAP_MAX = 1000

/** A whole number from 0 (no cap) to SIGNUP_CAP_MAX, or null. */
export function parseSignupCap(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return value <= SIGNUP_CAP_MAX ? value : null
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/

export interface ParsedDomains {
  domains: string[]
  /** The first entry that is not a domain name. */
  invalid: string | null
}

/** One domain per line (commas and spaces also separate); `@` prefix and case dropped, sorted. */
export function parseBlockedDomains(text: string): ParsedDomains {
  const seen = new Set<string>()
  for (const entry of text.split(/[\s,]+/)) {
    const domain = entry.trim().toLowerCase().replace(/^@/, '')
    if (!domain) continue
    if (!DOMAIN.test(domain)) return { domains: [], invalid: entry.trim() }
    seen.add(domain)
  }
  return { domains: [...seen].sort(), invalid: null }
}
