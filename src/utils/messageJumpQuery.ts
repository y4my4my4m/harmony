import type { LocationQuery, RouteLocationNormalizedLoaded, Router } from 'vue-router'

/**
 * A jump target travels in ?messageId, with the search terms to mark in ?searchQuery.
 * The view removes both once read, so navigating to the same target again is a route
 * change and jumps again.
 */
export interface JumpTarget {
  messageId: string
  searchQuery?: string
}

export function readJumpTarget(query: LocationQuery): JumpTarget | null {
  const { messageId, searchQuery } = query
  if (typeof messageId !== 'string' || !messageId) return null
  return typeof searchQuery === 'string' && searchQuery ? { messageId, searchQuery } : { messageId }
}

export function withoutJumpTarget(query: LocationQuery): LocationQuery {
  const { messageId: _messageId, searchQuery: _searchQuery, ...rest } = query
  return rest
}

export function takeJumpTarget(route: RouteLocationNormalizedLoaded, router: Router): JumpTarget | null {
  const target = readJumpTarget(route.query)
  if (target) void router.replace({ query: withoutJumpTarget(route.query) })
  return target
}
