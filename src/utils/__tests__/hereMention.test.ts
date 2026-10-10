/**
 * @here is the role_mention part with roleId `here`, written `@role:here` in the composer.
 */
import { describe, it, expect } from 'vitest'
import { parseContentToMessageParts } from '@/utils/unifiedContentProcessing'
import { messagePartsToMarkdown } from '@/utils/messageContentUtils'
import { hereMentionPart, isHereMention, mentionsViewer } from '@/utils/hereMention'

const ROLE = '00000000-0000-4000-8000-0000000000c0'
const HERE = { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null }

describe('@here parts', () => {
  it('parses @role:here into the @here part', async () => {
    const parts = await parseContentToMessageParts('@role:here standup in 5')
    expect(parts[0]).toEqual(HERE)
    expect(parts.slice(1).map(p => (p.type === 'text' ? p.text : p.type)).join('')).toBe(' standup in 5')
  })

  it('takes @role:here only as a whole word', async () => {
    const parts = await parseContentToMessageParts('@role:hereafter')
    expect(parts.some(p => p.type === 'role_mention')).toBe(false)
  })

  it('keeps @role:UUID a role mention, named from the role data', async () => {
    const parts = await parseContentToMessageParts(`@role:${ROLE} @role:here`, {}, {}, {},
      { [ROLE]: { name: 'crew', color: '#00ff00' } })
    expect(parts.filter(p => p.type === 'role_mention')).toEqual([
      { type: 'role_mention', roleId: ROLE, roleName: 'crew', roleColor: '#00ff00' },
      HERE,
    ])
  })

  it('round-trips through the editor text', async () => {
    expect(messagePartsToMarkdown([hereMentionPart(), { type: 'text', text: ' hi' }])).toBe('@role:here hi')
    expect((await parseContentToMessageParts('@role:here hi'))[0]).toEqual(hereMentionPart())
  })

  it('tells @here from roles', () => {
    expect(isHereMention(HERE)).toBe(true)
    expect(isHereMention({ type: 'role_mention', roleId: ROLE })).toBe(false)
    expect(isHereMention({ type: 'mention', userId: 'here' })).toBe(false)
    expect(isHereMention(null)).toBe(false)
  })
})

describe('mentionsViewer', () => {
  const viewer = { profileId: 'me', roleIds: new Set([ROLE]) }

  it('is true for @here, a held role and a mention of the viewer', () => {
    expect(mentionsViewer([HERE] as any, { profileId: 'me', roleIds: new Set() })).toBe(true)
    expect(mentionsViewer([{ type: 'role_mention', roleId: ROLE }] as any, viewer)).toBe(true)
    expect(mentionsViewer([{ type: 'mention', userId: 'me', username: 'me' }] as any, viewer)).toBe(true)
  })

  it('is false otherwise', () => {
    expect(mentionsViewer([{ type: 'text', text: '@here' }] as any, viewer)).toBe(false)
    expect(mentionsViewer([{ type: 'role_mention', roleId: 'other' }] as any, viewer)).toBe(false)
    expect(mentionsViewer([{ type: 'mention', userId: 'you', username: 'you' }] as any, viewer)).toBe(false)
    expect(mentionsViewer([{ type: 'mention', username: 'x' }] as any, { profileId: null, roleIds: new Set() })).toBe(false)
    expect(mentionsViewer(null, viewer)).toBe(false)
  })
})
