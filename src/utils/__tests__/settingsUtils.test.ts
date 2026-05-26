import { describe, it, expect } from 'vitest'
import {
  isValidSettingsSection,
  getSettingsPath,
  getSettingsRoute,
  getDefaultSettingsSection,
} from '@/utils/settingsUtils'

describe('settingsUtils', () => {
  describe('isValidSettingsSection', () => {
    it.each([
      'account', 'privacy', 'appearance', 'notifications', 'announcements',
      'voice', 'keybinds', 'language', 'advanced',
    ])('returns true for valid section: %s', (section) => {
      expect(isValidSettingsSection(section)).toBe(true)
    })

    it('returns false for invalid section', () => {
      expect(isValidSettingsSection('nonexistent')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isValidSettingsSection('')).toBe(false)
    })
  })

  describe('getSettingsPath', () => {
    it('generates correct path', () => {
      expect(getSettingsPath('account')).toBe('/settings/account')
      expect(getSettingsPath('privacy')).toBe('/settings/privacy')
      expect(getSettingsPath('appearance')).toBe('/settings/appearance')
    })
  })

  describe('getSettingsRoute', () => {
    it('generates route location object', () => {
      const route = getSettingsRoute('account')
      expect(route).toEqual({
        name: 'UserSettings',
        params: { section: 'account' },
      })
    })
  })

  describe('getDefaultSettingsSection', () => {
    it('returns account as default', () => {
      expect(getDefaultSettingsSection()).toBe('account')
    })
  })
})
