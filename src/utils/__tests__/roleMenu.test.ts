import { describe, it, expect } from 'vitest'
import { roleMenuMessageParts, roleMenuPartOf } from '@/utils/roleMenu'

describe('roleMenuMessageParts', () => {
  it('posts the card and a text part naming the roles', () => {
    expect(roleMenuMessageParts('s1', 'Colours', ' Pick a colour ', ['Blue', 'Red'])).toEqual([
      { type: 'role_menu', serverId: 's1', group: 'Colours', title: 'Pick a colour' },
      { type: 'text', text: 'Pick a colour: Blue · Red' },
    ])
  })

  it('keeps the title alone when no role is listed, and caps it at 100 characters', () => {
    const [card, text] = roleMenuMessageParts('s1', null, 'x'.repeat(150), [])
    expect(card).toEqual({ type: 'role_menu', serverId: 's1', group: null, title: 'x'.repeat(100) })
    expect(text).toEqual({ type: 'text', text: 'x'.repeat(100) })
  })
})

describe('roleMenuPartOf', () => {
  it('finds the part and normalises it', () => {
    expect(roleMenuPartOf([{ type: 'text', text: 'a' }, { type: 'role_menu', serverId: 's1', group: 'G', title: ' T ' }]))
      .toEqual({ type: 'role_menu', serverId: 's1', group: 'G', title: 'T' })
  })

  it('ignores parts without a server id and non-arrays', () => {
    expect(roleMenuPartOf([{ type: 'role_menu' }])).toBeNull()
    expect(roleMenuPartOf(null)).toBeNull()
  })
})
