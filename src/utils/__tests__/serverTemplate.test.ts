import { describe, it, expect } from 'vitest'
import {
  SERVER_TEMPLATE_LIMITS,
  parseServerTemplate,
  readPermissionMask,
  serverTemplateFileName,
  summarizeServerTemplate,
  templateRejection,
  withServerFields,
  type ServerTemplate,
} from '../serverTemplate'

// The shape export_server_template writes (20261011000001_server_templates.sql).
const exported = (): ServerTemplate => ({
  format: 'harmony.server-template',
  version: 1,
  exported_at: '2026-10-10T12:00:00Z',
  server: {
    name: 'Book Club',
    description: 'Reading together',
    public: true,
    allow_cross_server_emojis: true,
    rules: ['Be kind'],
    category: 'community',
  },
  roles: [
    { ref: 'r1', name: 'everyone', color: '#99AAB5', position: 0, permissions: '462850', is_default: true, is_admin: false, mentionable: true, hoist: false, unicode_emoji: null },
    { ref: 'r2', name: 'members', color: '#00ff00', position: 2, permissions: '0', is_default: false, is_admin: false, mentionable: true, hoist: false, unicode_emoji: null },
    { ref: 'r3', name: 'Admin', color: '#e74c3c', position: 999, permissions: '1073741823', is_default: false, is_admin: true, mentionable: true, hoist: false, unicode_emoji: null },
    { ref: 'r4', name: 'mods', color: '#ff0000', position: 1000, permissions: '132', is_default: false, is_admin: false, mentionable: false, hoist: true, unicode_emoji: null },
  ],
  categories: [
    { ref: 'c1', name: 'info', order: 0 },
    { ref: 'c2', name: 'talk', order: 1 },
  ],
  channels: [
    { ref: 'ch1', name: 'loose', description: null, type: 0, order: 5, slowmode_seconds: 0, category: null, private: false, overrides: [] },
    { ref: 'ch2', name: 'welcome', description: 'Read me', type: 0, order: 0, slowmode_seconds: 30, category: 'c1', private: false, overrides: [] },
    {
      ref: 'ch3', name: 'staff', description: null, type: 0, order: 1, slowmode_seconds: 0, category: 'c1', private: true,
      overrides: [{ role: 'r1', allow: '0', deny: '2' }, { role: 'r4', allow: '2', deny: '0' }],
    },
    { ref: 'ch4', name: 'lounge', description: null, type: 1, order: 0, slowmode_seconds: 0, category: 'c2', private: false, overrides: [] },
  ],
  settings: { default_role: 'r2', system_channel: 'ch2', system_messages_enabled: true },
  welcome: { enabled: true, message: 'Hi', rules: [{ title: 'Be kind', description: '' }], require_acceptance: false },
  automod: null,
})

const parse = (doc: unknown) => parseServerTemplate(JSON.stringify(doc))

const errorOf = (doc: unknown) => {
  const result = parse(doc)
  if (result.ok) throw new Error('expected a refusal')
  return result.error
}

describe('parseServerTemplate', () => {
  it('accepts an exported template and summarizes it', () => {
    const result = parse(exported())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary).toEqual({
      name: 'Book Club',
      roles: 2,
      categories: 2,
      channels: 4,
      elevatedEveryone: false,
    })
  })

  it('accepts format and version alone', () => {
    expect(parse({ format: 'harmony.server-template', version: 1 }).ok).toBe(true)
  })

  it('refuses text that is not JSON', () => {
    const result = parseServerTemplate('{ nope')
    expect(result.ok || result.error.code).toBe('notJson')
  })

  it('refuses another format and another version', () => {
    expect(errorOf({ format: 'discord', version: 1 }).code).toBe('notTemplate')
    expect(errorOf([]).code).toBe('notTemplate')
    expect(errorOf({ ...exported(), version: 2 }).code).toBe('unsupportedVersion')
  })

  it('refuses more than the server allows', () => {
    const channels = Array.from({ length: SERVER_TEMPLATE_LIMITS.channels + 1 }, (_, i) => ({ ref: `x${i}`, name: `c${i}` }))
    expect(errorOf({ ...exported(), channels }).code).toBe('tooManyChannels')
    const categories = Array.from({ length: SERVER_TEMPLATE_LIMITS.categories + 1 }, (_, i) => ({ ref: `x${i}`, name: `c${i}` }))
    expect(errorOf({ ...exported(), categories, channels: [] }).code).toBe('tooManyCategories')
    const roles = Array.from({ length: SERVER_TEMPLATE_LIMITS.roles + 1 }, (_, i) => ({ ref: `x${i}`, name: `r${i}` }))
    expect(errorOf({ ...exported(), roles, channels: [], settings: null }).code).toBe('tooManyRoles')
  })

  it('refuses a file over the size limit', () => {
    const big = JSON.stringify({ ...exported(), padding: 'x'.repeat(SERVER_TEMPLATE_LIMITS.bytes) })
    const result = parseServerTemplate(big)
    expect(result.ok || result.error.code).toBe('tooLarge')
  })

  it('refuses refs that resolve to nothing or to the wrong kind', () => {
    const doc = exported()
    doc.channels![1].category = 'nope'
    expect(errorOf(doc)).toMatchObject({ code: 'invalid', detail: 'channels[1].category names no category' })

    const wrongKind = exported()
    wrongKind.channels![2].overrides = [{ role: 'c1', allow: '2' }]
    expect(errorOf(wrongKind).detail).toBe('channels[2].overrides[0].role names no role')
  })

  it('refuses duplicate refs, across kinds too', () => {
    const doc = exported()
    doc.categories![0].ref = 'r1'
    expect(errorOf(doc).detail).toBe('ref "r1" is used more than once')
  })

  it('refuses two overrides for one role on a channel', () => {
    const doc = exported()
    doc.channels![2].overrides = [{ role: 'r1', deny: '2' }, { role: 'r1', allow: '2' }]
    expect(errorOf(doc).detail).toBe('channels[2] has more than one override for role "r1"')
  })

  it('refuses masks outside bits 0 to 29', () => {
    for (const permissions of ['1073741824', '-1', '1.5', 'abc', 2 ** 40]) {
      const doc = exported()
      doc.roles![1].permissions = permissions
      expect(errorOf(doc).detail).toBe('roles[1].permissions is a permission mask of bits 0 to 29')
    }
  })

  it('refuses a second @everyone, a blank name and an unknown channel type', () => {
    const twoDefaults = exported()
    twoDefaults.roles![1].is_default = true
    expect(errorOf(twoDefaults).detail).toBe('only one role is @everyone')

    const blank = exported()
    blank.channels![0].name = '   '
    expect(errorOf(blank).detail).toBe('channels[0].name must not be blank')

    const forum = exported()
    forum.channels![0].type = 2
    expect(errorOf(forum).detail).toBe('channels[0].type is an integer from 0 to 1')
  })

  it('refuses a category id discovery does not know', () => {
    const doc = exported()
    doc.server!.category = 'cooking'
    expect(errorOf(doc).detail).toBe('server.category is not a discovery category')
  })
})

describe('summarizeServerTemplate', () => {
  it('flags @everyone holding moderation permissions', () => {
    const doc = exported()
    // MANAGE_SERVER is bit 7.
    doc.roles![0].permissions = String(462850 | 128)
    expect(summarizeServerTemplate(doc).elevatedEveryone).toBe(true)
  })

  it('flags a default role holding ADMINISTRATOR', () => {
    const doc = exported()
    doc.roles![1].permissions = '1'
    expect(summarizeServerTemplate(doc).elevatedEveryone).toBe(true)
  })
})

describe('readPermissionMask', () => {
  it('reads decimal strings and integers, absent as 0', () => {
    expect(readPermissionMask('462850')).toBe(462850)
    expect(readPermissionMask(132)).toBe(132)
    expect(readPermissionMask(undefined)).toBe(0)
    expect(readPermissionMask('0x10')).toBeNaN()
  })
})

describe('serverTemplateFileName', () => {
  it('names the file after the server', () => {
    expect(serverTemplateFileName('Book Club')).toBe('Book Club.harmony-template.json')
  })

  it('replaces characters file systems refuse', () => {
    expect(serverTemplateFileName('a/b:c*?"<>|d')).toBe('a-b-c-d.harmony-template.json')
    expect(serverTemplateFileName('  ..  ')).toBe('server.harmony-template.json')
  })
})

describe('withServerFields', () => {
  it('replaces the fields the create form edits and keeps the rest', () => {
    const doc = withServerFields(exported(), { description: null, public: false, category: null })
    expect(doc.server).toEqual({
      name: 'Book Club', description: null, public: false, allow_cross_server_emojis: true, rules: ['Be kind'], category: null,
    })
    expect(doc.channels).toHaveLength(4)
  })
})

describe('templateRejection', () => {
  it('reads the reason from a validation error', () => {
    expect(templateRejection({ message: 'TEMPLATE_INVALID: channels[0].type is an integer from 0 to 1', code: '22023' }))
      .toBe('channels[0].type is an integer from 0 to 1')
    expect(templateRejection(new Error('AUTOMOD_INVALID_RULE: unknown rule type bogus'))).toBe('unknown rule type bogus')
  })

  it('is null for other failures', () => {
    expect(templateRejection({ message: 'Not authenticated' })).toBeNull()
    expect(templateRejection(null)).toBeNull()
  })
})
