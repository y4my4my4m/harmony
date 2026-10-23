import { describe, expect, it } from 'vitest'
import en from '@/locales/en.json'
import { staffActivityAuthorId, staffActivityMessage, staffActivityServerId } from '@/utils/staffActivity'

// en.json with vue-i18n's plural choice: "one | many", or "zero | one | many".
const t = (key: string, params: Record<string, unknown> = {}, plural?: number): string => {
  let message = key.split('.').reduce<any>((node, part) => node?.[part], en)
  if (typeof message !== 'string') return key
  if (plural !== undefined) {
    const forms = message.split(' | ')
    message = forms.length === 3 ? forms[Math.min(plural, 2)] : forms[plural === 1 ? 0 : 1]
  }
  return message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
}

const line = (action_type: string, details: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  staffActivityMessage({ action_type, details, ...extra }, 'here.test', t)

describe('staffActivityMessage', () => {
  it('names the person, the server and the reason of a removal or ban from a server hosted here', () => {
    expect(line('server_member_remove', { server_name: 'Lobby', username: 'rem', domain: 'remote.test', reason: 'spam' }))
      .toBe('Removed @rem@remote.test from Lobby · Reason: spam')
    expect(line('server_member_ban', { server_name: 'Lobby', username: 'loc', domain: null }))
      .toBe('Banned @loc from Lobby')
  })

  it('names a removed message\'s author and server once resolved, and leaves out what is unknown', () => {
    const details = { server_id: 's1', author_id: 'u1', reason: 'gore' }
    expect(line('server_message_remove', details, { server_name: 'Lobby', author_handle: '@ann' }))
      .toBe('Removed a message by @ann in Lobby · Reason: gore')
    expect(line('server_message_remove', details)).toBe('Removed a message in a server · Reason: gore')
  })

  it('reads suspensions and deletions of servers hosted here', () => {
    expect(line('server_suspend', { server_name: 'Lobby', reason: 'raids' })).toBe('Suspended Lobby · Reason: raids')
    expect(line('server_unsuspend', { server_name: 'Lobby', reason: null })).toBe('Lifted the suspension of Lobby')
    expect(line('server_delete', { server_name: 'Lobby', owner_username: 'olivia', members: 3, reason: 'csam' }))
      .toBe('Deleted Lobby, owned by @olivia · Reason: csam')
    expect(line('server_delete', { server_name: 'Lobby', owner_username: null })).toBe('Deleted Lobby')
  })

  it('reads this instance\'s tools for servers hosted elsewhere', () => {
    expect(line('instance_server_blocked', { name: 'Far', reason: 'raids', members_removed: 2 }))
      .toBe('Blocked Far on here.test · 2 people from here.test left it · Reason: raids')
    expect(line('instance_server_blocked', { name: 'Far', reason: null, members_removed: 0 })).toBe('Blocked Far on here.test')
    expect(line('instance_server_unblocked', { name: 'Far', members_removed: 0 })).toBe('Allowed Far on here.test again')
    expect(line('instance_server_media_hidden', { name: 'Far' })).toBe('Hid media from Far on here.test')
    expect(line('instance_server_media_shown', { name: 'Far' })).toBe('Showed media from Far on here.test again')
  })

  it('reads removals from a server hosted elsewhere, with or without a keep-out, and lifted keep-outs', () => {
    const base = { username: 'bob', server_id: 's9', server_name: 'Far', reason: null }
    expect(line('instance_server_member_removed', { ...base, removed: true, kept_out: false }, { target_username: 'bob' }))
      .toBe('Removed @bob from Far on here.test')
    expect(line('instance_server_member_removed', { ...base, removed: true, kept_out: true, reason: 'spam' }, { target_username: 'bob' }))
      .toBe('Removed @bob from Far on here.test and kept them out · Reason: spam')
    expect(line('instance_server_member_removed', { ...base, removed: false, kept_out: true }, { target_username: 'bob' }))
      .toBe('Kept @bob out of Far on here.test')
    expect(line('instance_server_keepout_lifted', { server_id: 's9' }, { target_username: 'bob', server_name: 'Far' }))
      .toBe('Let @bob rejoin Far from here.test')
  })

  it('reads a domain\'s reports being ignored or accepted again', () => {
    expect(line('domain_reject_reports', {}, { target_id: 'spam.example' })).toBe('Ignored reports from spam.example')
    expect(line('domain_accept_reports', {}, { target_id: 'spam.example' })).toBe('Accepted reports from spam.example again')
  })

  it('leaves any other action to the generic formatter', () => {
    expect(line('user_suspend', { reason: 'x' })).toBeNull()
  })
})

describe('ids to resolve', () => {
  it('are the server and author of a removed message, and the server of a lifted keep-out', () => {
    const removed = { action_type: 'server_message_remove', details: { server_id: 's1', author_id: 'u1' } }
    expect(staffActivityServerId(removed)).toBe('s1')
    expect(staffActivityAuthorId(removed)).toBe('u1')
    expect(staffActivityServerId({ action_type: 'instance_server_keepout_lifted', details: { server_id: 's9' } })).toBe('s9')
    expect(staffActivityServerId({ action_type: 'server_suspend', details: { server_name: 'Lobby' } })).toBeNull()
    expect(staffActivityAuthorId({ action_type: 'server_suspend', details: {} })).toBeNull()
  })
})
