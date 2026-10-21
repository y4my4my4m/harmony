import { describe, it, expect } from 'vitest'
import {
  formatChannelNameInput,
  finalizeChannelName,
  formatCategoryNameInput,
  finalizeCategoryName,
  categoryNameProblem,
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

  it('lowercases, drops other characters, collapses repeated hyphens and drops leading ones', () => {
    expect(formatChannelNameInput('  Off Topic!!  Chat')).toBe('off-topic-chat')
    expect(formatChannelNameInput('-x')).toBe('x')
  })

  it('drops trailing hyphens on submit only', () => {
    expect(finalizeChannelName('general-')).toBe('general')
    expect(finalizeChannelName('general chat ')).toBe('general-chat')
    expect(finalizeChannelName('keep_')).toBe('keep_')
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
