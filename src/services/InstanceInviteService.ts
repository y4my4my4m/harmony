/**
 * Instance invitations: the federation backend's /admin/invites routes, instance admins only
 * (migration 20261105980001_instance_invites.sql). An invitation is a GoTrue user made for the
 * address; its single-use link lands on /reset-password, where the person chooses a password.
 * Failures throw InviteError with the backend's code.
 */

import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'removed'
export type InviteSource = 'admin' | 'cli' | 'other'
export type InviteDelivery = 'link' | 'email'

export interface InstanceInvite {
  /** Null for a GoTrue invitation no record names. */
  id: string | null
  email: string
  auth_user_id: string
  source: InviteSource
  delivery: InviteDelivery | null
  invited_by_username: string | null
  created_at: string
  links_issued: number
  link_sent_at: string | null
  accepted_at: string | null
  account_username: string | null
  revoked_at: string | null
  revoked_by_username: string | null
  status: InviteStatus
  /** Pending invitations only. */
  expires_at: string | null
  expired: boolean
}

export interface InviteOverview {
  registration: {
    /** GoTrue's sign-up switch. */
    signup: 'open' | 'closed' | 'unknown'
    /** instance_config.open_registration, which NodeInfo announces. */
    advertised_open: boolean
  }
  email_available: boolean
  link_lifetime_seconds: number
  invites: InstanceInvite[]
}

export interface IssuedInvite {
  invite: { id: string | null; auth_user_id: string; email: string; delivery: InviteDelivery; recorded: boolean }
  /** Null when GoTrue emailed it. */
  link: string | null
  expires_at: string | null
}

export class InviteError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: string,
    /** The open invitation of an address already invited (invite_pending). */
    public readonly authUserId?: string,
  ) {
    super(code)
  }
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new InviteError('not_authenticated')
  let response: Response
  try {
    response = await fetch(apiUrl(`/api/federation/admin/invites${path}`), {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new InviteError('network_error')
  }
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    // The backend's rate limiter answers { error: 'Too Many Requests' }.
    const code = json.error === 'Too Many Requests' ? 'rate_limited' : json.error
    throw new InviteError(
      typeof code === 'string' ? code : `http_${response.status}`,
      typeof json.detail === 'string' ? json.detail : undefined,
      typeof json.auth_user_id === 'string' ? json.auth_user_id : undefined,
    )
  }
  return json as T
}

export const instanceInvites = {
  overview(): Promise<InviteOverview> {
    return call('GET', '')
  },
  create(email: string, send: boolean): Promise<IssuedInvite> {
    return call('POST', '', { email, send })
  },
  /** A new link; the one before stops working. */
  reissue(authUserId: string): Promise<IssuedInvite> {
    return call('POST', `/${encodeURIComponent(authUserId)}/link`)
  },
  revoke(authUserId: string): Promise<void> {
    return call<void>('DELETE', `/${encodeURIComponent(authUserId)}`)
  },
}
