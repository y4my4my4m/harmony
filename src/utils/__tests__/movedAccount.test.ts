import { describe, it, expect, beforeAll } from 'vitest'
import { accountRefFromProfile, accountRefFromUri, handleFromActorUri } from '@/utils/movedAccount'
import { moveNoticeText } from '@/utils/moveNotice'
import { resolveNotificationRoute } from '@/utils/notificationRoute'
import { runtimeConfig } from '@/services/runtimeConfig'
import { waitForInitialLocale } from '@/i18n'

beforeAll(async () => {
  await waitForInitialLocale()
})

const own = () => (runtimeConfig.domain as string | undefined) ?? 'harmony.test'

describe('moved account references', () => {
  it('reads a handle from Mastodon, Misskey and GoToSocial actor URIs', () => {
    expect(handleFromActorUri('https://mastodon.social/users/Gargron')).toEqual({ username: 'Gargron', domain: 'mastodon.social' })
    expect(handleFromActorUri('https://gts.example/@alice')).toEqual({ username: 'alice', domain: 'gts.example' })
    expect(handleFromActorUri('https://misskey.example/users/9abc123')).toEqual({ username: '9abc123', domain: 'misskey.example' })
    expect(handleFromActorUri('https://example.com/actor')).toBeNull()
    expect(handleFromActorUri('javascript:alert(1)')).toBeNull()
  })

  it('routes a stored remote account by user@host and a local one by name', () => {
    expect(accountRefFromProfile({
      id: 'p1', username: 'bob', domain: 'new.test', is_local: false,
      display_name: 'Bob', avatar_url: null, federated_id: 'https://new.test/users/bob',
    })).toMatchObject({ handle: '@bob@new.test', routeHandle: 'bob@new.test', isLocal: false })
    expect(accountRefFromProfile({
      id: 'p2', username: 'amy', domain: own(), is_local: true,
      display_name: null, avatar_url: null, federated_id: null,
    })).toMatchObject({ handle: '@amy', routeHandle: 'amy', isLocal: true })
  })

  it('keeps an unparseable URI as the label with no route', () => {
    expect(accountRefFromUri('https://example.com/actor')).toMatchObject({ handle: 'https://example.com/actor', routeHandle: null })
  })
})

describe('move notifications', () => {
  const data = {
    origin: { username: 'old', domain: 'old.test', display_name: 'Old Me', is_local: false },
    target: { username: 'new', domain: 'new.test', is_local: false },
  }

  it('names both accounts and whether the follow is accepted or requested', () => {
    expect(moveNoticeText({ ...data, follow_status: 'accepted' })).toEqual({
      title: 'Old Me moved to @new@new.test',
      message: 'You now follow @new@new.test.',
    })
    expect(moveNoticeText({ ...data, follow_status: 'pending' }).message).toBe('A follow request was sent to @new@new.test for you.')
  })

  it('opens the new account\'s profile', () => {
    expect(resolveNotificationRoute({ type: 'move', data })).toBe('/social/profile/new@new.test')
  })
})
