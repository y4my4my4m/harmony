import { describe, it, expect } from 'vitest'
import { resolveNotificationRoute, toAppPath } from '@/utils/notificationRoute'

const route = (type: string, data: Record<string, any>) => resolveNotificationRoute({ type, data })

describe('resolveNotificationRoute', () => {
  it('opens DMs and group chats at the message', () => {
    expect(route('dm', { conversation: { id: 'c1' }, message: { id: 'm1' } })).toBe('/dm/c1?messageId=m1')
    expect(route('chat_message', { conversation_id: 'c2' })).toBe('/dm/c2')
  })

  it('opens channel mentions and replies at the message', () => {
    expect(route('mention', { location: { server_id: 's1', channel_id: 'ch1' }, message_id: 'm2' }))
      .toBe('/chat/s1/ch1?messageId=m2')
    expect(route('reply', { server_id: 's1', channel_id: 'ch1' })).toBe('/chat/s1/ch1')
  })

  it('opens thread replies inside the thread, not the channel timeline', () => {
    expect(route('thread_reply', {
      thread: { id: 't1' }, location: { server_id: 's1', channel_id: 'ch1' }, message_id: 'm3',
    })).toBe('/chat/s1/thread/t1?messageId=m3')
  })

  it('opens social posts under /social/post', () => {
    expect(route('activitypub_favorite', { post_id: 'p1' })).toBe('/social/post/p1')
    expect(route('activitypub_mention', { post: { id: 'p2' } })).toBe('/social/post/p2')
  })

  it('opens followers by handle and follow requests in their list', () => {
    expect(route('activitypub_follow', { follower: { username: 'bob', domain: 'remote.social', is_local: false } }))
      .toBe('/social/profile/bob@remote.social')
    expect(route('activitypub_follow_accepted', { sender: { username: 'amy', is_local: true, domain: 'harmony.test' } }))
      .toBe('/social/profile/amy')
    expect(route('activitypub_follow_request', { follower: { username: 'x' } })).toBe('/social/follow-requests')
  })

  it('never routes to server settings or a 404', () => {
    expect(route('server_update', { server_id: 's1' })).toBe('/chat')
    expect(route('report_update', {})).toBe('/chat')
    expect(route('activitypub_reblog', {})).toBe('/social/home')
  })

  it('encodes message ids', () => {
    expect(route('dm', { conversation_id: 'c1', message_id: 'a&b' })).toBe('/dm/c1?messageId=a%26b')
  })
})

describe('toAppPath', () => {
  const origin = 'https://harmony.test'

  it('keeps same-origin paths with query', () => {
    expect(toAppPath('/dm/c1?messageId=m1', origin)).toBe('/dm/c1?messageId=m1')
    expect(toAppPath('https://harmony.test/chat/s/c', origin)).toBe('/chat/s/c')
  })

  it('rejects other origins and garbage', () => {
    expect(toAppPath('https://evil.example/dm/c1', origin)).toBeNull()
    expect(toAppPath(undefined, origin)).toBeNull()
    expect(toAppPath('http://[', origin)).toBeNull()
  })
})
