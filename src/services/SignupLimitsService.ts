import { supabase } from '@/supabase'
import { adminService } from '@/services/AdminService'

export interface SignupLimits {
  enabled: boolean
  ipCap: number
  mailboxCap: number
  domainCap: number
  enforceCaps: boolean
  blockDisposable: boolean
  blockedDomains: string[]
  blockedMailHosts: string[]
  blockedNetworks: string[]
  trustedDomains: string[]
}

export type SignupRefusalReason =
  | 'ip_cap'
  | 'domain_cap'
  | 'mailbox_cap'
  | 'blocked_domain'
  | 'mail_host'
  | 'blocked_network'
export interface SignupRefusals {
  refused: Record<SignupRefusalReason, number>
  /** Past an observing cap and allowed. */
  wouldRefuse: Record<SignupRefusalReason, number>
}

const KEYS: Record<keyof SignupLimits, string> = {
  enabled: 'signup_limits_enabled',
  ipCap: 'signup_daily_ip_cap',
  mailboxCap: 'signup_mailbox_cap',
  domainCap: 'signup_daily_domain_cap',
  enforceCaps: 'signup_enforce_caps',
  blockDisposable: 'signup_block_disposable_email',
  blockedDomains: 'signup_blocked_email_domains',
  blockedMailHosts: 'signup_blocked_mail_hosts',
  blockedNetworks: 'signup_blocked_networks',
  trustedDomains: 'signup_trusted_email_domains',
}

export const SIGNUP_LIMIT_DEFAULTS: Readonly<SignupLimits> = {
  enabled: true,
  ipCap: 5,
  mailboxCap: 5,
  domainCap: 10,
  enforceCaps: false,
  blockDisposable: true,
  blockedDomains: [],
  blockedMailHosts: [],
  blockedNetworks: [],
  trustedDomains: [],
}

function asFlag(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

function asCount(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

function asDomains(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string') : []
}

export async function loadSignupLimits(): Promise<SignupLimits> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_key, config_value')
    .in('config_key', Object.values(KEYS))
  if (error) throw error
  const stored = new Map((data ?? []).map((row) => [row.config_key, row.config_value as unknown]))
  return {
    enabled: asFlag(stored.get(KEYS.enabled), SIGNUP_LIMIT_DEFAULTS.enabled),
    ipCap: asCount(stored.get(KEYS.ipCap), SIGNUP_LIMIT_DEFAULTS.ipCap),
    mailboxCap: asCount(stored.get(KEYS.mailboxCap), SIGNUP_LIMIT_DEFAULTS.mailboxCap),
    domainCap: asCount(stored.get(KEYS.domainCap), SIGNUP_LIMIT_DEFAULTS.domainCap),
    enforceCaps: asFlag(stored.get(KEYS.enforceCaps), SIGNUP_LIMIT_DEFAULTS.enforceCaps),
    blockDisposable: asFlag(stored.get(KEYS.blockDisposable), SIGNUP_LIMIT_DEFAULTS.blockDisposable),
    blockedDomains: asDomains(stored.get(KEYS.blockedDomains)),
    blockedMailHosts: asDomains(stored.get(KEYS.blockedMailHosts)),
    blockedNetworks: asDomains(stored.get(KEYS.blockedNetworks)),
    trustedDomains: asDomains(stored.get(KEYS.trustedDomains)),
  }
}

/** Writes only what differs from `saved`: a value another admin stored meanwhile stays. */
export async function saveSignupLimits(
  next: SignupLimits,
  saved: SignupLimits,
  adminId: string,
): Promise<void> {
  const changes: Record<string, unknown> = {}
  for (const field of Object.keys(KEYS) as Array<keyof SignupLimits>) {
    if (JSON.stringify(next[field]) !== JSON.stringify(saved[field])) {
      changes[KEYS[field]] = next[field]
    }
  }
  await adminService.setInstanceConfigs(changes, adminId)
}

function noCounts(): Record<SignupRefusalReason, number> {
  return { ip_cap: 0, domain_cap: 0, mailbox_cap: 0, blocked_domain: 0, mail_host: 0, blocked_network: 0 }
}

/** Counts per reason over the last `days` UTC days, today included. */
export async function loadSignupRefusals(days = 7): Promise<SignupRefusals> {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('signup_refusal_counts')
    .select('reason, refusals, would_refuse')
    .gte('day', since)
  if (error) throw error
  const totals: SignupRefusals = { refused: noCounts(), wouldRefuse: noCounts() }
  for (const row of data ?? []) {
    const reason = row.reason as SignupRefusalReason
    if (reason in totals.refused) {
      totals.refused[reason] += Number(row.refusals) || 0
      totals.wouldRefuse[reason] += Number(row.would_refuse) || 0
    }
  }
  return totals
}
