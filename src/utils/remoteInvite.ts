// Invite links to servers on other Harmony instances and their cards (provider
// harmony-remote-invite). A card holds what another instance answered and is read as
// untrusted: the host and code come from the link itself, text is one capped line, counts are
// non-negative integers, images are https and the Group id is on the link's host. Caps are
// those of federation-backend/src/services/remoteInvitePreview.ts.

import type { RemoteInviteSummary } from '@/types'
import { toRemoteInviteUrl } from '@/utils/internalLinks'

const MAX_SERVER_NAME = 100
const MAX_DESCRIPTION = 300
const MAX_INSTANCE_NAME = 100
const MAX_URL = 2048

const STATUSES = new Set<RemoteInviteSummary['status']>(['valid', 'invalid', 'closed'])

/** C0/C1 controls, zero-width characters, bidi embeddings, overrides and isolates. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g

export interface RemoteInviteLink {
  href: string
  /** URL.host, lowercased. */
  domain: string
  code: string
}

/** An https invite link on another host, or null. */
export function remoteInviteLink(raw: string | null | undefined): RemoteInviteLink | null {
  if (!raw) return null
  const href = toRemoteInviteUrl(raw)
  if (!href) return null
  const url = new URL(href)
  if (url.protocol !== 'https:' || url.username || url.password) return null
  return { href, domain: url.host.toLowerCase(), code: url.pathname.split('/')[2] }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const line = value.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return null
  const points = Array.from(line)
  return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}…` : line
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

/** The card of `url` from a stored or fetched answer, or null when there is none to show. */
export function readRemoteInvite(url: string | null | undefined, raw: unknown): RemoteInviteSummary | null {
  const link = remoteInviteLink(url)
  if (!link || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const card = raw as Record<string, any>
  if (!STATUSES.has(card.status)) return null

  const instance = {
    name: text(card.instance?.name, MAX_INSTANCE_NAME) ?? link.domain,
    icon: httpsUrl(card.instance?.icon),
  }
  const base = { status: card.status as RemoteInviteSummary['status'], code: link.code, domain: link.domain, instance }
  if (card.status !== 'valid') return base

  const server = card.server
  const name = text(server?.name, MAX_SERVER_NAME)
  if (!name) return null
  const id = httpsUrl(server.id)
  return {
    ...base,
    server: {
      name,
      description: text(server.description, MAX_DESCRIPTION),
      icon: httpsUrl(server.icon),
      memberCount: count(server.memberCount),
      onlineCount: count(server.onlineCount),
      id: id && new URL(id).host.toLowerCase() === link.domain ? id : null,
    },
  }
}
