/**
 * Fediverse handles. `acct` is WebFinger's acct: form without the scheme, `user@domain`.
 * The display forms: `@user` for an account of this instance and `@user@domain` for one of
 * another, as in-text mentions read; the full form `@user@domain` for both, as profile
 * headers, search results, post headers and a copied handle read.
 */
import { runtimeConfig } from '@/services/runtimeConfig'

export interface HandleOwner {
  username?: string | null
  domain?: string | null
  is_local?: boolean | null
  /** `@user@domain` or `user@domain`; read when username or domain is absent. */
  handle?: string | null
}

/** This instance's domain, lower case; '' when the build names none. */
export function localDomain(): string {
  return (runtimeConfig.domain || '').trim().toLowerCase()
}

/** Username and domain of `account`, a `handle` string filling what the fields lack. */
function parts(account: HandleOwner | null | undefined): { username: string; domain: string | null; isLocal: boolean | null } | null {
  if (!account) return null
  let username = account.username?.trim() || ''
  let domain = account.domain?.trim() || ''
  const handle = /^@?([^@\s]+)(?:@([^@\s]+))?$/.exec(account.handle?.trim() || '')
  if (handle) {
    if (!username) username = handle[1]
    if (!domain && handle[2] && handle[1].toLowerCase() === username.toLowerCase()) domain = handle[2]
  }
  if (!username) return null
  return { username, domain: domain || null, isLocal: account.is_local ?? null }
}

/** An account of another instance: not marked local, with a domain other than this one. */
export function isRemoteAccount(account: HandleOwner | null | undefined): boolean {
  const p = parts(account)
  if (!p || p.isLocal === true || !p.domain) return false
  return p.domain.toLowerCase() !== localDomain()
}

/** Username, and the domain of a remote account (null for a local one); null without a username. */
export function handleParts(account: HandleOwner | null | undefined): { username: string; domain: string | null } | null {
  const p = parts(account)
  if (!p) return null
  return { username: p.username, domain: isRemoteAccount(account) ? p.domain : null }
}

/** `user@domain`, this instance's domain for a local account; null without a username. */
export function acct(account: HandleOwner | null | undefined): string | null {
  const p = parts(account)
  if (!p) return null
  const domain = isRemoteAccount(account) ? p.domain! : localDomain()
  return domain ? `${p.username}@${domain}` : p.username
}

/**
 * `@user` for a local account, `@user@domain` for a remote one; with `full`, `@user@domain`
 * for both. '' without a username.
 */
export function formatHandle(account: HandleOwner | null | undefined, options: { full?: boolean } = {}): string {
  const p = parts(account)
  if (!p) return ''
  if (options.full) return `@${acct(account)}`
  return isRemoteAccount(account) ? `@${p.username}@${p.domain}` : `@${p.username}`
}
