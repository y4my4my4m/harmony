/**
 * Typed factory functions for creating test data.
 * Every factory returns reasonable defaults that can be overridden.
 */

let counter = 0
function nextId(): string {
  counter++
  return `test-${counter}-${Date.now()}`
}

export function createProfile(overrides: Record<string, any> = {}) {
  const id = overrides.id || nextId()
  return {
    id,
    auth_user_id: overrides.auth_user_id || `auth-${id}`,
    username: overrides.username || `user_${id}`,
    display_name: overrides.display_name || `Test User ${id}`,
    avatar_url: overrides.avatar_url || null,
    banner_url: overrides.banner_url || null,
    bio: overrides.bio || '',
    domain: overrides.domain || null,
    is_remote: overrides.is_remote || false,
    is_admin: overrides.is_admin || false,
    is_suspended: overrides.is_suspended || false,
    followers_count: overrides.followers_count || 0,
    following_count: overrides.following_count || 0,
    posts_count: overrides.posts_count || 0,
    color: overrides.color || null,
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    ...overrides,
  }
}

export function createServer(overrides: Record<string, any> = {}) {
  const id = overrides.id || nextId()
  return {
    id,
    name: overrides.name || `Test Server ${id}`,
    description: overrides.description || 'A test server',
    icon_url: overrides.icon_url || null,
    banner_url: overrides.banner_url || null,
    owner: overrides.owner || nextId(),
    is_public: overrides.is_public ?? true,
    member_count: overrides.member_count || 1,
    created_at: overrides.created_at || new Date().toISOString(),
    ...overrides,
  }
}

export function createChannel(overrides: Record<string, any> = {}) {
  const id = overrides.id || nextId()
  return {
    id,
    name: overrides.name || `test-channel-${id}`,
    type: overrides.type || 'text',
    server_id: overrides.server_id || nextId(),
    category_id: overrides.category_id || null,
    position: overrides.position || 0,
    topic: overrides.topic || null,
    is_nsfw: overrides.is_nsfw || false,
    created_at: overrides.created_at || new Date().toISOString(),
    ...overrides,
  }
}

export function createMessage(overrides: Record<string, any> = {}) {
  const id = overrides.id || nextId()
  return {
    id,
    content: overrides.content || [{ type: 'text', text: 'Hello, world!' }],
    user_id: overrides.user_id || nextId(),
    channel_id: overrides.channel_id || null,
    conversation_id: overrides.conversation_id || null,
    thread_id: overrides.thread_id || null,
    is_edited: overrides.is_edited || false,
    is_deleted: overrides.is_deleted || false,
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    profiles: overrides.profiles || createProfile(),
    ...overrides,
  }
}

export function createPost(overrides: Record<string, any> = {}) {
  const id = overrides.id || nextId()
  return {
    id,
    content: overrides.content || [{ type: 'text', text: 'Test post content' }],
    author_id: overrides.author_id || nextId(),
    visibility: overrides.visibility || 'public',
    is_sensitive: overrides.is_sensitive || false,
    spoiler_text: overrides.spoiler_text || null,
    reply_to_id: overrides.reply_to_id || null,
    reblog_of_id: overrides.reblog_of_id || null,
    likes_count: overrides.likes_count || 0,
    reblogs_count: overrides.reblogs_count || 0,
    replies_count: overrides.replies_count || 0,
    federation_status: overrides.federation_status || 'local',
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    ...overrides,
  }
}

export function createAPActivity(overrides: Record<string, any> = {}) {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: overrides.id || `https://remote.example/activities/${nextId()}`,
    type: overrides.type || 'Create',
    actor: overrides.actor || 'https://remote.example/users/alice',
    object: overrides.object || {
      type: 'Note',
      content: '<p>Hello from the fediverse!</p>',
      attributedTo: 'https://remote.example/users/alice',
    },
    to: overrides.to || ['https://www.w3.org/ns/activitystreams#Public'],
    cc: overrides.cc || [],
    published: overrides.published || new Date().toISOString(),
    ...overrides,
  }
}

export function createConversation(overrides: Record<string, any> = {}) {
  const id = overrides.id || nextId()
  return {
    id,
    is_group: overrides.is_group || false,
    name: overrides.name || null,
    created_by: overrides.created_by || nextId(),
    created_at: overrides.created_at || new Date().toISOString(),
    ...overrides,
  }
}

/**
 * Reset the counter (useful between test suites).
 */
export function resetFactories() {
  counter = 0
}
