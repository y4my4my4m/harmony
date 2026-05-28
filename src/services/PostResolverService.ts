/**
 * PostResolverService - Unified post resolution
 *
 * Single entry point for resolving any post reference (UUID, AP URL, handle+noteId)
 * into a local database record. Imports remote posts on first encounter via the
 * federation backend's /resolve-post endpoint.
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import type { TimelinePost } from '@/types'

async function getFederationApiUrl(): Promise<string> {
  try {
    const { useActivityPubStore } = await import('@/stores/useActivityPub')
    return useActivityPubStore().federationApiUrl
  } catch {
    return '/api/federation'
  }
}

function formatPost(post: any): TimelinePost {
  return {
    id: post.id,
    user_id: post.user_id,
    content: post.content,
    visibility: post.visibility,
    created_at: post.created_at,
    updated_at: post.updated_at,
    reply_context: post.reply_context,
    is_local: post.is_local,
    is_federated: post.is_federated,
    author: post.author,
    author_id: post.author_id,
    ap_id: post.ap_id,
    ap_type: post.ap_type,
    url: post.url,
    in_reply_to: post.in_reply_to,
    conversation_id: post.conversation_id,
    favorites_count: post.favorites_count || 0,
    reblogs_count: post.reblogs_count || 0,
    replies_count: post.replies_count || 0,
    is_favorited: post.is_favorited ?? false,
    is_reblogged: post.is_reblogged ?? false,
    is_bookmarked: post.is_bookmarked ?? false,
    content_warning: post.content_warning,
    is_sensitive: post.is_sensitive,
    is_deleted: post.is_deleted,
    language: post.language,
    media_attachments: post.media_attachments || [],
    metadata: post.metadata,
    reblog: post.reblog || undefined,
    reblog_author: post.reblog_author || undefined,
  } as TimelinePost
}

async function loadPostFromDb(postId: string): Promise<TimelinePost | null> {
  const { data, error } = await supabase
    .from('posts')
    .select('*, author:profiles!posts_author_id_fkey(*)')
    .eq('id', postId)
    .single()

  if (error || !data) return null
  const post = formatPost(data)

  // Fetch current user's interactions for favorite icon in embeds
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    const profileId = await authContextService.getCurrentProfileId()
    if (profileId) {
      const { data: interactions } = await supabase
        .from('post_interactions')
        .select('interaction_type')
        .eq('post_id', postId)
        .eq('user_id', profileId)
        .in('interaction_type', ['favorite', 'emoji_reaction', 'reblog', 'bookmark'])
      const types = new Set(interactions?.map((i) => i.interaction_type) || [])
      post.is_favorited = types.has('favorite') || types.has('emoji_reaction')
      post.is_reblogged = types.has('reblog')
      post.is_bookmarked = types.has('bookmark')
    }
  } catch {
    // User not logged in - keep defaults
  }

  return post
}

async function importRemotePost(url: string): Promise<string | null> {
  try {
    const apiUrl = await getFederationApiUrl()
    const response = await fetch(`${apiUrl}/resolve-post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (response.ok) {
      const data = await response.json()
      return data.post_id || null
    }
  } catch {
    debug.warn('PostResolverService: federation import failed for', url)
  }
  return null
}

class PostResolverServiceImpl {
  /**
   * Resolve a post by its local UUID.
   */
  async resolveById(postId: string): Promise<TimelinePost | null> {
    return loadPostFromDb(postId)
  }

  /**
   * Resolve a post by its ActivityPub URL or web URL.
   * Checks local DB first, imports via federation if not found.
   */
  async resolveByApUrl(url: string): Promise<TimelinePost | null> {
    return (await this.resolveByApUrlWithStatus(url)).post
  }

  /**
   * Same as `resolveByApUrl` but also reports whether the post was newly
   * imported (`wasImported: true`) or already existed locally
   * (`wasImported: false`).
   *
   * Used by the PostView ancestor walker to decide whether to trigger a
   * context reload - calling `/resolve-post` for an ancestor that already
   * existed doesn't change anything visible to the user, so a reload would
   * just thrash the UI. Note that even cached hits can still cause server-
   * side orphan re-linking, so callers may want to reload anyway under some
   * conditions (e.g. when the current post itself was orphaned).
   */
  async resolveByApUrlWithStatus(
    url: string,
  ): Promise<{ post: TimelinePost | null; wasImported: boolean }> {
    // Check local DB by ap_id or url
    const { data: existing } = await supabase
      .from('posts')
      .select('id')
      .or(`ap_id.eq.${url},url.eq.${url}`)
      .eq('is_deleted', false)
      .limit(1)
      .maybeSingle()

    if (existing?.id) {
      return { post: await loadPostFromDb(existing.id), wasImported: false }
    }

    // Import via federation backend
    const importedId = await importRemotePost(url)
    if (importedId) {
      return { post: await loadPostFromDb(importedId), wasImported: true }
    }

    return { post: null, wasImported: false }
  }

  /**
   * Resolve a post by @handle and noteId (remote post URL pattern).
   * Tries profile+ap_id lookup, common URL patterns, then federation import.
   */
  async resolveByHandle(handle: string, noteId: string): Promise<TimelinePost | null> {
    const cleaned = handle.replace(/^@/, '')
    const atIdx = cleaned.indexOf('@')
    if (atIdx < 0) return null

    const username = cleaned.slice(0, atIdx)
    const domain = cleaned.slice(atIdx + 1)
    if (!username || !domain) return null

    // Strategy 1: find author profile, then search posts by author + noteId in ap_id
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .eq('domain', domain)
      .limit(1)
      .maybeSingle()

    if (profile?.id) {
      const { data: post } = await supabase
        .from('posts')
        .select('id')
        .eq('author_id', profile.id)
        .like('ap_id', `%${noteId}%`)
        .eq('is_deleted', false)
        .limit(1)
        .maybeSingle()

      if (post?.id) return loadPostFromDb(post.id)
    }

    // Strategy 2: try common AP URL patterns directly
    const candidates = [
      `https://${domain}/notes/${noteId}`,
      `https://${domain}/users/${username}/statuses/${noteId}`,
      `https://${domain}/@${username}/${noteId}`,
      `https://${domain}/@${username}/statuses/${noteId}`,
      `https://${domain}/notice/${noteId}`,
      `https://${domain}/objects/${noteId}`,
    ]

    for (const candidate of candidates) {
      const { data: post } = await supabase
        .from('posts')
        .select('id')
        .or(`ap_id.eq.${candidate},url.eq.${candidate}`)
        .eq('is_deleted', false)
        .limit(1)
        .maybeSingle()

      if (post?.id) return loadPostFromDb(post.id)
    }

    // Strategy 3: federation import with URL candidates
    for (const candidate of candidates) {
      const importedId = await importRemotePost(candidate)
      if (importedId) return loadPostFromDb(importedId)
    }

    return null
  }
}

export const postResolverService = new PostResolverServiceImpl()
