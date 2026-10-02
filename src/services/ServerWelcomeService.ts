/**
 * Instance welcome server and server welcome screens (RPCs from
 * 20261006300001_welcome_server_and_rules.sql).
 *
 * Rules acceptance is enforced by a BEFORE INSERT trigger on messages that raises
 * RULES_NOT_ACCEPTED:<server id>, mapped by moderationRejectionFromError in AutoModService.
 * Nothing here decides whether a message may be sent.
 */
import { supabase } from '@/supabase'

export interface WelcomeRule {
  title: string
  description: string
}

export interface ServerWelcome {
  server_id: string
  name: string
  description: string | null
  icon: string | null
  banner: string | null
  is_local: boolean
  /** A server_welcome_screens row exists. */
  configured: boolean
  enabled: boolean
  /** Empty for members while the screen is disabled. */
  message: string
  rules: WelcomeRule[]
  require_acceptance: boolean
  can_manage: boolean
  is_member: boolean
  joined_at: string | null
  welcome_seen_at: string | null
  rules_accepted_at: string | null
  /** The caller's messages are refused until they accept. */
  must_accept: boolean
  /** Open the screen on the caller's next visit. */
  should_show: boolean
}

export interface ServerWelcomeInput {
  enabled: boolean
  message: string
  rules: WelcomeRule[]
  requireAcceptance: boolean
}

export interface OnboardingServer {
  id: string
  name: string
  description: string | null
  icon: string | null
  banner: string | null
  member_count: number
}

export interface OnboardingSuggestions {
  source: 'welcome' | 'featured' | 'none'
  servers: OnboardingServer[]
}

/** Limits enforced by set_server_welcome. */
export const WELCOME_LIMITS = {
  message: 2000,
  rules: 20,
  ruleTitle: 100,
  ruleDescription: 500,
} as const

function unwrap<T>(result: { data: any; error: any }): T {
  if (result.error) {
    throw new Error(cleanWelcomeError(result.error.message || 'Request failed'))
  }
  return result.data as T
}

/** Strips the WELCOME_INVALID: style prefix the database puts on validation errors. */
export function cleanWelcomeError(message: string): string {
  return message.replace(/^(WELCOME_INVALID|WELCOME_SERVER_INVALID):\s*/, '')
}

function normalizeRules(raw: unknown): WelcomeRule[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((r: any) => ({
      title: typeof r?.title === 'string' ? r.title : '',
      description: typeof r?.description === 'string' ? r.description : '',
    }))
    .filter((r) => r.title.trim().length > 0)
}

function normalizeWelcome(raw: any): ServerWelcome {
  return { ...raw, message: raw?.message ?? '', rules: normalizeRules(raw?.rules) }
}

export async function getServerWelcome(serverId: string): Promise<ServerWelcome> {
  return normalizeWelcome(unwrap(await supabase.rpc('get_server_welcome', { p_server_id: serverId })))
}

export async function setServerWelcome(serverId: string, input: ServerWelcomeInput): Promise<ServerWelcome> {
  const rules = input.rules
    .map((r) => ({ title: r.title.trim(), description: r.description.trim() }))
    .filter((r) => r.title.length > 0)
  return normalizeWelcome(unwrap(await supabase.rpc('set_server_welcome', {
    p_server_id: serverId,
    p_enabled: input.enabled,
    p_message: input.message,
    p_rules: rules,
    p_require_acceptance: input.requireAcceptance,
  })))
}

export async function markServerWelcomeSeen(serverId: string): Promise<ServerWelcome> {
  return normalizeWelcome(unwrap(await supabase.rpc('mark_server_welcome_seen', { p_server_id: serverId })))
}

export async function acceptServerRules(serverId: string): Promise<ServerWelcome> {
  return normalizeWelcome(unwrap(await supabase.rpc('accept_server_rules', { p_server_id: serverId })))
}

export async function getOnboardingServers(): Promise<OnboardingSuggestions> {
  const data = unwrap<any>(await supabase.rpc('get_onboarding_servers'))
  const servers = Array.isArray(data?.servers) ? data.servers : []
  return {
    source: data?.source === 'welcome' || data?.source === 'featured' ? data.source : 'none',
    servers: servers.map((s: any) => ({ ...s, member_count: Number(s.member_count) || 0 })),
  }
}

/** Instance admins only. null clears the setting. */
export async function setWelcomeServer(serverId: string | null): Promise<void> {
  unwrap(await supabase.rpc('set_welcome_server', { p_server_id: serverId }))
}
