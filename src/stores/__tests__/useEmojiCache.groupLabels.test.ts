import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useEmojiCacheStore, PERSONAL_EMOJI_GROUPS } from '@/stores/useEmojiCache'
import { useProfileStore } from '@/stores/useProfile'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'

const ROWS: Record<string, object[]> = {
  user: [{ id: 'u1', name: 'mine', url: 'https://x/mine.png', server_id: null, scope: 'user', uploader: 'me' }],
  instance: [{ id: 'i1', name: 'inst', url: 'https://x/inst.png', server_id: null, scope: 'instance' }],
}

vi.mock('@/supabase', () => {
  const from = () => {
    let scope = ''
    const builder: any = {
      select: () => builder,
      eq: (col: string, v: string) => { if (col === 'scope') scope = v; return builder },
      is: () => builder,
      order: () => builder,
      then: (resolve: (r: any) => void) => resolve({ data: ROWS[scope] ?? [], error: null }),
    }
    return builder
  }
  return { supabase: { from } }
})

vi.mock('@/services/emojiIndexedDBCache', () => ({
  getAllCachedServerEmojis: async () => [],
  setCachedServerEmojis: () => {},
  removeCachedServerEmojis: () => {},
}))

vi.mock('@/services/userDataService', () => ({ userDataService: { reResolveAllDisplayNames: () => {} } }))

vi.mock('@/utils/avatarUtils', () => ({
  getAvatarUrl: (url: string | null | undefined) => (url ? `avatar:${url}` : '/default_avatar.webp'),
}))

vi.mock('@/stores/useProfile', async () => {
  const { defineStore } = await import('pinia')
  return {
    useProfileStore: defineStore('profile', {
      state: () => ({ profile: null as { id: string; avatar_url: string | null } | null }),
    }),
  }
})

vi.mock('@/stores/useInstanceSettings', async () => {
  const { defineStore } = await import('pinia')
  return {
    useInstanceSettingsStore: defineStore('instanceSettings', {
      state: () => ({ settings: { instanceName: 'Harmony', instanceIcon: '' } }),
    }),
  }
})

const group = (key: string) => useEmojiCacheStore().resolvedEmojis[key]

describe('useEmojiCache personal group labels', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('My Emoji shows the avatar of a profile that loads after the emoji', async () => {
    const store = useEmojiCacheStore()
    await store.loadPersonalEmojis('me')
    expect(group(PERSONAL_EMOJI_GROUPS.user).server_icon).toBe('/default_avatar.webp')

    useProfileStore().profile = { id: 'me', avatar_url: 'me/a.webp' }
    await nextTick()
    expect(group(PERSONAL_EMOJI_GROUPS.user).server_icon).toBe('avatar:me/a.webp')
    expect(group(PERSONAL_EMOJI_GROUPS.user).emojis.map((e) => e.name)).toEqual(['mine'])
  })

  it('an avatar change updates My Emoji, and a rebuild keeps the new avatar', async () => {
    const profile = useProfileStore()
    profile.profile = { id: 'me', avatar_url: 'me/a.webp' }
    const store = useEmojiCacheStore()
    await store.loadPersonalEmojis('me')
    expect(group(PERSONAL_EMOJI_GROUPS.user).server_icon).toBe('avatar:me/a.webp')

    profile.profile = { ...profile.profile, avatar_url: 'me/b.webp' }
    await nextTick()
    expect(group(PERSONAL_EMOJI_GROUPS.user).server_icon).toBe('avatar:me/b.webp')

    store.rebuildResolvedEmojis()
    expect(group(PERSONAL_EMOJI_GROUPS.user).server_icon).toBe('avatar:me/b.webp')
  })

  it('the instance group takes the name and icon of instance settings that load after the emoji', async () => {
    const store = useEmojiCacheStore()
    await store.loadPersonalEmojis('me')
    expect(group(PERSONAL_EMOJI_GROUPS.instance)).toMatchObject({ server_name: 'Harmony Emoji', server_icon: '/img/app_icon_square.webp' })

    const instance = useInstanceSettingsStore()
    instance.settings.instanceName = 'Spacify'
    instance.settings.instanceIcon = 'https://spacify.cloud/icon.png'
    await nextTick()
    expect(group(PERSONAL_EMOJI_GROUPS.instance)).toMatchObject({ server_name: 'Spacify Emoji', server_icon: 'https://spacify.cloud/icon.png' })
    expect(store.serverCaches.get(PERSONAL_EMOJI_GROUPS.instance)?.serverName).toBe('Spacify Emoji')
  })
})
