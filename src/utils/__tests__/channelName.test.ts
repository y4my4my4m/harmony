import { describe, it, expect } from 'vitest'
import {
  formatChannelNameInput,
  finalizeChannelName,
  formatCategoryNameInput,
  finalizeCategoryName,
  categoryNameProblem,
  finalizeChannelNameFor,
  formatChannelNameFor,
  namesKeepSpaces,
} from '@/utils/channelName'

describe('channel names', () => {
  it('turns a typed space into a hyphen and keeps it for the next word', () => {
    expect(formatChannelNameInput('general ')).toBe('general-')
    expect(formatChannelNameInput('general-')).toBe('general-')
    expect(formatChannelNameInput('general-chat')).toBe('general-chat')
  })

  it('accepts hyphens and underscores', () => {
    expect(formatChannelNameInput('dev_ops-team')).toBe('dev_ops-team')
    expect(formatChannelNameInput('a_')).toBe('a_')
  })

  it('lowercases, drops ASCII punctuation, collapses repeated hyphens and drops leading ones', () => {
    expect(formatChannelNameInput('  Off Topic!!  Chat')).toBe('off-topic-chat')
    expect(formatChannelNameInput('-x')).toBe('x')
    expect(formatChannelNameInput('a!b"c#d$e%f&g\'h(i)j*k+l,m.n/o:p;q<r=s>t?u@v[w\\x]y^z`{|}~')).toBe('abcdefghijklmnopqrstuvwxyz')
  })

  it('drops trailing hyphens on submit only', () => {
    expect(finalizeChannelName('general-')).toBe('general')
    expect(finalizeChannelName('general chat ')).toBe('general-chat')
    expect(finalizeChannelName('keep_')).toBe('keep_')
  })

  it('removes what the database sanitizer removes: control, zero-width and bidi characters', () => {
    expect(finalizeChannelName('ne\u200bws\u202e\u0007')).toBe('news')
  })
})

// The same cases as db_schema/tests/201_channel_names_create_options.sql: the client and
// channel_name_normalized store one name.
describe('the naming rule per channel type', () => {
  const cases: Array<[string, number, string]> = [
    ['Release Notes!', 0, 'release-notes'],
    ['  Off Topic!!  Chat', 0, 'off-topic-chat'],
    ['dev_ops--team-', 0, 'dev_ops-team'],
    ['Café Ünïcode', 0, 'café-ünïcode'],
    ['日本語\u3000チャンネル', 0, '日本語-チャンネル'],
    ['🎮 Game Night', 0, '🎮-game-night'],
    ['a\u00a0b', 0, 'a-b'],
    ['!!!', 0, ''],
    ["  Mike's  Room 🎮 ", 1, "Mike's Room 🎮"],
    ['Late\u2003\u2003Night', 1, 'Late Night'],
    ['voice chat', 1, 'voice chat'],
  ]

  it.each(cases)('%j as type %i is stored as %j', (raw, type, expected) => {
    expect(finalizeChannelNameFor(type, raw)).toBe(expected)
  })

  it('keeps spaces and case for voice channels only', () => {
    expect(namesKeepSpaces(1)).toBe(true)
    expect(namesKeepSpaces(0)).toBe(false)
    expect(namesKeepSpaces(undefined)).toBe(false)
  })

  it('formats a voice name as typed: one space between words, a trailing space kept for the next word', () => {
    expect(formatChannelNameFor(1, '  Late  Night ')).toBe('Late Night ')
    expect(formatChannelNameFor(1, 'Game Night')).toBe('Game Night')
  })

  it('formats a text name as typed with the text rule', () => {
    expect(formatChannelNameFor(0, 'Game Night ')).toBe('game-night-')
  })
})

describe('category names', () => {
  it('keeps spaces and letter case, collapsing runs of whitespace', () => {
    expect(formatCategoryNameInput('Voice Rooms ')).toBe('Voice Rooms ')
    expect(finalizeCategoryName('  Staff   Area\t')).toBe('Staff Area')
    expect(formatCategoryNameInput(' Dev_Stuff-2')).toBe('Dev_Stuff-2')
    expect(finalizeCategoryName('Équipe 日本')).toBe('Équipe 日本')
  })

  it('applies one length rule to creation and rename', () => {
    expect(categoryNameProblem('')).toBe('required')
    expect(categoryNameProblem('A')).toBe('tooShort')
    expect(categoryNameProblem('Staff Area')).toBeNull()
    expect(categoryNameProblem('x'.repeat(101))).toBe('tooLong')
  })
})
