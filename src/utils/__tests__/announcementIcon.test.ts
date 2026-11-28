import { describe, it, expect } from 'vitest'
import { announcementIcon, ANNOUNCEMENT_ICON_NAMES } from '../announcementIcon'

describe('announcementIcon', () => {
  it('maps every name the admin form lists, megaphone included', () => {
    expect(announcementIcon('megaphone')).toEqual({ name: 'megaphone', emoji: null })
    expect(announcementIcon('warning')).toEqual({ name: 'alert-triangle', emoji: null })
    expect(announcementIcon('maintenance')).toEqual({ name: 'wrench', emoji: null })
    expect(announcementIcon(' Security ')).toEqual({ name: 'shield', emoji: null })
    for (const name of ANNOUNCEMENT_ICON_NAMES) expect(announcementIcon(name).name).toBeTruthy()
  })

  it('keeps an emoji typed into the field, sequences included', () => {
    expect(announcementIcon('📣')).toEqual({ name: null, emoji: '📣' })
    expect(announcementIcon('🧑‍💻')).toEqual({ name: null, emoji: '🧑‍💻' })
    expect(announcementIcon('🇯🇵')).toEqual({ name: null, emoji: '🇯🇵' })
  })

  it('falls back to the info icon for anything else', () => {
    expect(announcementIcon(null)).toEqual({ name: 'info', emoji: null })
    expect(announcementIcon('')).toEqual({ name: 'info', emoji: null })
    expect(announcementIcon('party')).toEqual({ name: 'info', emoji: null })
    expect(announcementIcon('12')).toEqual({ name: 'info', emoji: null })
    expect(announcementIcon('<img src=x>')).toEqual({ name: 'info', emoji: null })
  })
})
