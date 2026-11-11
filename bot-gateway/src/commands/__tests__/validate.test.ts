import { describe, it, expect, vi } from 'vitest'

// PERMISSION_BIT lives beside the install lookups in botPermissions.ts.
vi.mock('../../config/supabase.js', () => ({ supabase: {}, config: {} }))

import {
  DEFAULT_MEMBER_PERMISSIONS_ERROR,
  validateCommand,
  validateCommands,
  type CommandDefinition,
} from '../validate.js'

const ok = (input: unknown): CommandDefinition => {
  const result = validateCommand(input)
  if (!result.ok) throw new Error(`expected a valid command, got: ${result.error}`)
  return result.value
}

const refused = (input: unknown): string => {
  const result = validateCommand(input)
  if (result.ok) throw new Error('expected a refusal')
  return result.error
}

const str = (name: string, extra: Record<string, unknown> = {}) => ({ type: 3, name, description: name, ...extra })

describe('validateCommand', () => {
  it('normalizes a command: unknown fields dropped, defaults filled', () => {
    expect(ok({
      name: 'weather',
      description: 'Weather for a city',
      name_localizations: { ja: '天気' },
      dm_permission: false,
      options: [
        { type: 3, name: 'city', description: 'City', required: true, max_length: 64, channel_types: [0] },
        { type: 4, name: 'days', description: 'Days', min_value: 1, max_value: 7, autocomplete: false },
        { type: 10, name: 'scale', description: 'Scale', choices: [{ name: 'Half', value: 0.5, name_localizations: {} }] },
        { type: 5, name: 'metric', description: 'Metric units' },
      ],
    })).toEqual({
      name: 'weather',
      description: 'Weather for a city',
      required_permissions: [],
      options: [
        { type: 3, name: 'city', description: 'City', required: true, max_length: 64 },
        { type: 4, name: 'days', description: 'Days', required: false, min_value: 1, max_value: 7 },
        { type: 10, name: 'scale', description: 'Scale', required: false, choices: [{ name: 'Half', value: 0.5 }] },
        { type: 5, name: 'metric', description: 'Metric units', required: false },
      ],
    })
  })

  it('takes names in any script that has no case, and refuses an uppercase one', () => {
    expect(ok({ name: '天気', description: '今日の天気' }).name).toBe('天気')
    expect(ok({ name: 'clone-server_2', description: 'x' }).name).toBe('clone-server_2')
    expect(refused({ name: 'Weather', description: 'x' })).toBe('name: must be lowercase')
    expect(refused({ name: 'ПОГОДА', description: 'x' })).toBe('name: must be lowercase')
    expect(refused({ name: 'two words', description: 'x' })).toBe('name: must be 1-32 letters, digits, - or _')
    expect(refused({ name: '', description: 'x' })).toBe('name: must be 1-32 letters, digits, - or _')
    expect(refused({ name: 'a'.repeat(33), description: 'x' })).toBe('name: must be 1-32 letters, digits, - or _')
    expect(ok({ name: 'あ'.repeat(32), description: 'x' }).name).toHaveLength(32)
  })

  it('wants a description of 1-100 characters', () => {
    expect(refused({ name: 'ping' })).toBe('description: must be 1-100 characters')
    expect(refused({ name: 'ping', description: '' })).toBe('description: must be 1-100 characters')
    expect(refused({ name: 'ping', description: 'x'.repeat(101) })).toBe('description: must be 1-100 characters')
    expect(ok({ name: 'ping', description: '天'.repeat(100) }).description).toHaveLength(100)
  })

  it('refuses default_member_permissions with a value and ignores null', () => {
    for (const value of ['8', '0', 0]) {
      expect(refused({ name: 'ban', description: 'x', default_member_permissions: value })).toBe(DEFAULT_MEMBER_PERMISSIONS_ERROR)
    }
    expect(ok({ name: 'ban', description: 'x', default_member_permissions: null })).not.toHaveProperty('default_member_permissions')
    expect(DEFAULT_MEMBER_PERMISSIONS_ERROR).toBe(
      'default_member_permissions is not supported; use required_permissions with Harmony permission names',
    )
  })

  it('takes Harmony permission names, once each, and refuses others', () => {
    expect(ok({ name: 'ban', description: 'x', required_permissions: ['BAN_MEMBERS', 'KICK_MEMBERS', 'BAN_MEMBERS'] })
      .required_permissions).toEqual(['BAN_MEMBERS', 'KICK_MEMBERS'])
    expect(refused({ name: 'ban', description: 'x', required_permissions: ['ban_members'] }))
      .toBe('required_permissions: unknown permission ban_members')
    expect(refused({ name: 'ban', description: 'x', required_permissions: '1024' }))
      .toBe('required_permissions: must be an array of Harmony permission names')
  })

  it('refuses context-menu command types', () => {
    expect(ok({ name: 'ping', description: 'x', type: 1 }).name).toBe('ping')
    expect(refused({ name: 'ping', description: 'x', type: 2 })).toBe('type: only chat input commands (type 1) are supported')
  })

  it('refuses MENTIONABLE, ATTACHMENT, unknown types and autocomplete', () => {
    expect(refused({ name: 'x', description: 'x', options: [{ type: 9, name: 'who', description: 'x' }] }))
      .toBe('options[0].type: 9 (MENTIONABLE) is not supported')
    expect(refused({ name: 'x', description: 'x', options: [{ type: 11, name: 'file', description: 'x' }] }))
      .toBe('options[0].type: 11 (ATTACHMENT) is not supported')
    expect(refused({ name: 'x', description: 'x', options: [{ type: 12, name: 'y', description: 'x' }] }))
      .toBe('options[0].type: 12 is not an option type')
    expect(refused({ name: 'x', description: 'x', options: [str('q', { autocomplete: true })] }))
      .toBe('options[0].autocomplete: is not supported')
  })

  it('caps options and choices at 25', () => {
    const many = Array.from({ length: 26 }, (_, i) => str(`o${i}`))
    expect(refused({ name: 'x', description: 'x', options: many })).toBe('options: must be an array of at most 25')
    expect(ok({ name: 'x', description: 'x', options: many.slice(0, 25) }).options).toHaveLength(25)
    const choices = Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, value: `v${i}` }))
    expect(refused({ name: 'x', description: 'x', options: [str('q', { choices })] }))
      .toBe('options[0].choices: must be an array of at most 25')
  })

  it('wants choice values of the option type', () => {
    const choice = (type: number, value: unknown) => ({ name: 'x', description: 'x', options: [{ type, name: 'q', description: 'q', choices: [{ name: 'c', value }] }] })
    expect(ok(choice(3, 'tokyo')).options[0].choices).toEqual([{ name: 'c', value: 'tokyo' }])
    expect(ok(choice(4, 3)).options[0].choices).toEqual([{ name: 'c', value: 3 }])
    expect(ok(choice(10, 2.5)).options[0].choices).toEqual([{ name: 'c', value: 2.5 }])
    expect(refused(choice(3, 1))).toBe('options[0].choices[0].value: must be a string of at most 100 characters')
    expect(refused(choice(3, 'x'.repeat(101)))).toBe('options[0].choices[0].value: must be a string of at most 100 characters')
    expect(refused(choice(4, 2.5))).toBe('options[0].choices[0].value: must be an integer')
    expect(refused(choice(10, '2.5'))).toBe('options[0].choices[0].value: must be a number')
    expect(refused(choice(10, 2 ** 54))).toBe('options[0].choices[0].value: must lie within ±2^53')
    expect(refused(choice(5, true))).toBe('options[0].choices: only STRING, INTEGER and NUMBER options take choices')
    expect(refused({ name: 'x', description: 'x', options: [str('q', { choices: [{ name: '', value: 'a' }] })] }))
      .toBe('options[0].choices[0].name: must be 1-100 characters')
  })

  it('puts required options before optional ones', () => {
    expect(refused({ name: 'x', description: 'x', options: [str('a'), str('b', { required: true })] }))
      .toBe('options[1]: required options come before optional ones')
    expect(ok({ name: 'x', description: 'x', options: [str('a', { required: true }), str('b')] }).options.map((o) => o.required))
      .toEqual([true, false])
    expect(refused({ name: 'x', description: 'x', options: [str('a', { required: 'yes' })] }))
      .toBe('options[0].required: must be a boolean')
  })

  it('keeps value ranges on numbers and lengths on strings', () => {
    expect(refused({ name: 'x', description: 'x', options: [str('a', { min_value: 1 })] }))
      .toBe('options[0].min_value: applies to INTEGER and NUMBER options only')
    expect(refused({ name: 'x', description: 'x', options: [{ type: 4, name: 'n', description: 'n', max_length: 3 }] }))
      .toBe('options[0].max_length: applies to STRING options only')
    expect(refused({ name: 'x', description: 'x', options: [{ type: 4, name: 'n', description: 'n', min_value: 1.5 }] }))
      .toBe('options[0].min_value: must be an integer')
    expect(ok({ name: 'x', description: 'x', options: [{ type: 10, name: 'n', description: 'n', min_value: -1.5, max_value: 1.5 }] })
      .options[0]).toMatchObject({ min_value: -1.5, max_value: 1.5 })
    expect(refused({ name: 'x', description: 'x', options: [{ type: 4, name: 'n', description: 'n', min_value: 5, max_value: 1 }] }))
      .toBe('options[0].min_value: exceeds max_value')
    expect(ok({ name: 'x', description: 'x', options: [str('a', { min_length: 0, max_length: 6000 })] }).options[0])
      .toMatchObject({ min_length: 0, max_length: 6000 })
    expect(refused({ name: 'x', description: 'x', options: [str('a', { max_length: 6001 })] }))
      .toBe('options[0].max_length: must be an integer from 1 to 6000')
    expect(refused({ name: 'x', description: 'x', options: [str('a', { max_length: 0 })] }))
      .toBe('options[0].max_length: must be an integer from 1 to 6000')
    expect(refused({ name: 'x', description: 'x', options: [str('a', { min_length: 10, max_length: 5 })] }))
      .toBe('options[0].min_length: exceeds max_length')
  })

  it('wants option names unique per level and lowercase', () => {
    expect(refused({ name: 'x', description: 'x', options: [str('a'), str('a')] }))
      .toBe('options[1].name: duplicate option name a')
    expect(refused({ name: 'x', description: 'x', options: [str('City')] })).toBe('options[0].name: must be lowercase')
    expect(ok({
      name: 'x', description: 'x',
      options: [
        { type: 1, name: 'a', description: 'a', options: [str('q')] },
        { type: 1, name: 'b', description: 'b', options: [str('q')] },
      ],
    }).options).toHaveLength(2)
  })

  it('nests group, subcommand, values and no deeper', () => {
    const tree = ok({
      name: 'bridge',
      description: 'Bridge',
      options: [
        { type: 2, name: 'server', description: 'Server', required: true, options: [
          { type: 1, name: 'clone', description: 'Clone', options: [str('guild', { required: true })] },
        ] },
        { type: 1, name: 'status', description: 'Status' },
      ],
    })
    expect(tree.options).toEqual([
      { type: 2, name: 'server', description: 'Server', options: [
        { type: 1, name: 'clone', description: 'Clone', options: [{ type: 3, name: 'guild', description: 'guild', required: true }] },
      ] },
      { type: 1, name: 'status', description: 'Status', options: [] },
    ])

    expect(refused({ name: 'x', description: 'x', options: [{ type: 1, name: 's', description: 's' }, str('q')] }))
      .toBe('options: a command with subcommands takes no other options at its top level')
    expect(refused({ name: 'x', description: 'x', options: [{ type: 2, name: 'g', description: 'g', options: [str('q')] }] }))
      .toBe('options[0].options[0]: a subcommand group holds only subcommands')
    expect(refused({ name: 'x', description: 'x', options: [{ type: 2, name: 'g', description: 'g', options: [
      { type: 2, name: 'h', description: 'h', options: [] },
    ] }] })).toBe('options[0].options[0]: a subcommand group sits only at the top level of a command')
    expect(refused({ name: 'x', description: 'x', options: [{ type: 2, name: 'g', description: 'g', options: [
      { type: 1, name: 's', description: 's', options: [{ type: 1, name: 't', description: 't' }] },
    ] }] })).toBe('options[0].options[0].options[0]: a subcommand holds no subcommands')
    expect(refused({ name: 'x', description: 'x', options: [{ type: 2, name: 'g', description: 'g', options: [] }] }))
      .toBe('options[0].options: a subcommand group holds at least one subcommand')
    expect(refused({ name: 'x', description: 'x', options: [str('q', { options: [] })] }))
      .toBe('options[0].options: only subcommands and subcommand groups take options')
    expect(refused({ name: 'x', description: 'x', options: [{ type: 1, name: 's', description: 's', choices: [] }] }))
      .toBe('options[0].choices: applies to value options only')
  })

  it('bounds the text of one command at 8000 characters', () => {
    const choices = Array.from({ length: 25 }, (_, i) => ({ name: `${i}`.padEnd(100, 'n'), value: `${i}`.padEnd(100, 'v') }))
    const options = Array.from({ length: 2 }, (_, i) => str(`o${i}`, { choices }))
    expect(refused({ name: 'x', description: 'x', options }))
      .toBe('names, descriptions and choices exceed 8000 characters')
    expect(ok({ name: 'x', description: 'x', options: options.slice(0, 1) }).options).toHaveLength(1)
  })

  it('refuses a body that is no object', () => {
    expect(refused(null)).toBe('must be a command object')
    expect(refused([{ name: 'x', description: 'x' }])).toBe('must be a command object')
  })
})

describe('validateCommands', () => {
  it('normalizes each command of the set', () => {
    const result = validateCommands([{ name: 'a', description: 'a', extra: 1 }, { name: 'b', description: 'b' }])
    expect(result).toEqual({
      ok: true,
      value: [
        { name: 'a', description: 'a', options: [], required_permissions: [] },
        { name: 'b', description: 'b', options: [], required_permissions: [] },
      ],
    })
    expect(validateCommands([])).toEqual({ ok: true, value: [] })
  })

  it('names the failing command by index', () => {
    expect(validateCommands([{ name: 'a', description: 'a' }, { name: 'B', description: 'b' }]))
      .toEqual({ ok: false, error: '[1].name: must be lowercase' })
    expect(validateCommands([{ name: 'a', description: 'a', required_permissions: ['NOPE'] }]))
      .toEqual({ ok: false, error: '[0].required_permissions: unknown permission NOPE' })
    expect(validateCommands([{ name: 'a', description: 'a', default_member_permissions: '0' }]))
      .toEqual({ ok: false, error: DEFAULT_MEMBER_PERMISSIONS_ERROR })
  })

  it('refuses duplicate names, more than 100 commands and anything but an array', () => {
    expect(validateCommands([{ name: 'a', description: 'a' }, { name: 'a', description: 'b' }]))
      .toEqual({ ok: false, error: 'Duplicate command name: a' })
    const many = Array.from({ length: 101 }, (_, i) => ({ name: `c${i}`, description: 'x' }))
    expect(validateCommands(many)).toEqual({ ok: false, error: 'At most 100 commands' })
    expect(validateCommands(many.slice(0, 100)).ok).toBe(true)
    expect(validateCommands({ name: 'a', description: 'a' })).toEqual({ ok: false, error: 'Body must be an array of commands' })
  })
})
