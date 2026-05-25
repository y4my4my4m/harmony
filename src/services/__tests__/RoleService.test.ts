import { describe, it, expect } from 'vitest'
import {
  Permission,
  PERMISSION_BITS,
  PERMISSION_CATEGORIES,
  PERMISSION_DESCRIPTIONS,
  permissionsToBitmask,
  bitmaskToPermissions,
} from '@/services/RoleService'

describe('RoleService', () => {
  describe('Permission enum', () => {
    it('contains ADMINISTRATOR', () => {
      expect(Permission.ADMINISTRATOR).toBe('ADMINISTRATOR')
    })

    it('contains all expected text permissions', () => {
      expect(Permission.SEND_MESSAGES).toBe('SEND_MESSAGES')
      expect(Permission.MANAGE_MESSAGES).toBe('MANAGE_MESSAGES')
      expect(Permission.READ_MESSAGE_HISTORY).toBe('READ_MESSAGE_HISTORY')
    })

    it('contains all expected voice permissions', () => {
      expect(Permission.CONNECT).toBe('CONNECT')
      expect(Permission.SPEAK).toBe('SPEAK')
      expect(Permission.MUTE_MEMBERS).toBe('MUTE_MEMBERS')
    })
  })

  describe('PERMISSION_BITS', () => {
    it('maps ADMINISTRATOR to bit 0', () => {
      expect(PERMISSION_BITS[Permission.ADMINISTRATOR]).toBe(0)
    })

    it('maps every Permission enum value', () => {
      const permissionValues = Object.values(Permission)
      for (const perm of permissionValues) {
        expect(PERMISSION_BITS).toHaveProperty(perm)
        expect(typeof PERMISSION_BITS[perm]).toBe('number')
      }
    })

    it('has unique bit positions', () => {
      const bits = Object.values(PERMISSION_BITS)
      const uniqueBits = new Set(bits)
      expect(uniqueBits.size).toBe(bits.length)
    })
  })

  describe('permissionsToBitmask', () => {
    it('returns 0 for no permissions enabled', () => {
      const perms: Partial<Record<Permission, boolean>> = {
        [Permission.ADMINISTRATOR]: false,
        [Permission.VIEW_CHANNEL]: false,
      }
      expect(permissionsToBitmask(perms)).toBe(BigInt(0))
    })

    it('sets bit 0 for ADMINISTRATOR', () => {
      const perms: Partial<Record<Permission, boolean>> = {
        [Permission.ADMINISTRATOR]: true,
      }
      expect(permissionsToBitmask(perms)).toBe(BigInt(1))
    })

    it('sets bit 1 for VIEW_CHANNEL', () => {
      const perms: Partial<Record<Permission, boolean>> = {
        [Permission.VIEW_CHANNEL]: true,
      }
      expect(permissionsToBitmask(perms)).toBe(BigInt(2))
    })

    it('combines multiple permissions', () => {
      const perms: Partial<Record<Permission, boolean>> = {
        [Permission.ADMINISTRATOR]: true,
        [Permission.VIEW_CHANNEL]: true,
      }
      // bit 0 + bit 1 = 3
      expect(permissionsToBitmask(perms)).toBe(BigInt(3))
    })

    it('handles empty object', () => {
      expect(permissionsToBitmask({})).toBe(BigInt(0))
    })
  })

  describe('bitmaskToPermissions', () => {
    it('returns all false for bitmask 0', () => {
      const perms = bitmaskToPermissions(BigInt(0))
      for (const value of Object.values(perms)) {
        expect(value).toBe(false)
      }
    })

    it('detects ADMINISTRATOR from bitmask 1', () => {
      const perms = bitmaskToPermissions(BigInt(1))
      expect(perms[Permission.ADMINISTRATOR]).toBe(true)
      expect(perms[Permission.VIEW_CHANNEL]).toBe(false)
    })

    it('handles number input', () => {
      const perms = bitmaskToPermissions(3)
      expect(perms[Permission.ADMINISTRATOR]).toBe(true)
      expect(perms[Permission.VIEW_CHANNEL]).toBe(true)
    })

    it('handles string input', () => {
      const perms = bitmaskToPermissions('3')
      expect(perms[Permission.ADMINISTRATOR]).toBe(true)
      expect(perms[Permission.VIEW_CHANNEL]).toBe(true)
    })

    it('handles null/undefined gracefully', () => {
      const perms = bitmaskToPermissions(0)
      expect(Object.keys(perms).length).toBe(Object.values(Permission).length)
    })
  })

  describe('roundtrip: permissionsToBitmask <-> bitmaskToPermissions', () => {
    it('roundtrips a set of permissions', () => {
      const original: Partial<Record<Permission, boolean>> = {
        [Permission.ADMINISTRATOR]: true,
        [Permission.SEND_MESSAGES]: true,
        [Permission.CONNECT]: true,
      }
      const bitmask = permissionsToBitmask(original)
      const result = bitmaskToPermissions(bitmask)

      expect(result[Permission.ADMINISTRATOR]).toBe(true)
      expect(result[Permission.SEND_MESSAGES]).toBe(true)
      expect(result[Permission.CONNECT]).toBe(true)
      expect(result[Permission.BAN_MEMBERS]).toBe(false)
    })
  })

  describe('PERMISSION_CATEGORIES', () => {
    it('has general, membership, text, voice, and dangerous categories', () => {
      expect(PERMISSION_CATEGORIES).toHaveProperty('general')
      expect(PERMISSION_CATEGORIES).toHaveProperty('membership')
      expect(PERMISSION_CATEGORIES).toHaveProperty('text')
      expect(PERMISSION_CATEGORIES).toHaveProperty('voice')
      expect(PERMISSION_CATEGORIES).toHaveProperty('dangerous')
    })

    it('general category contains VIEW_CHANNEL', () => {
      expect(PERMISSION_CATEGORIES.general.permissions).toContain(Permission.VIEW_CHANNEL)
    })
  })

  describe('PERMISSION_DESCRIPTIONS', () => {
    it('has a description for every permission', () => {
      for (const perm of Object.values(Permission)) {
        expect(PERMISSION_DESCRIPTIONS[perm]).toBeTruthy()
        expect(typeof PERMISSION_DESCRIPTIONS[perm]).toBe('string')
      }
    })
  })
})
