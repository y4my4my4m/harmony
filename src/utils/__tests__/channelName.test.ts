import { describe, it, expect } from 'vitest'
import {
  formatChannelNameInput,
  finalizeChannelName,
  formatCategoryNameInput,
  finalizeCategoryName,
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
  it('keeps letter case and turns spaces into hyphens', () => {
    expect(formatCategoryNameInput('Voice Rooms ')).toBe('Voice-Rooms-')
    expect(finalizeCategoryName('Voice Rooms ')).toBe('Voice-Rooms')
    expect(formatCategoryNameInput('Dev_Stuff')).toBe('Dev_Stuff')
  })
})
