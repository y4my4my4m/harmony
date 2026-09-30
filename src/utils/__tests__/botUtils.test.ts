import { describe, it, expect } from 'vitest'
import {
  BOT_PRESENCE_STALE_MS,
  ENFORCED_BOT_PERMISSIONS,
  botSearchFilter,
  botUsernameError,
  buildBotEndpoints,
  defaultBotPermissions,
  enforcedPermissionsFrom,
  formatTokenHint,
  isBotOnline,
} from '@/utils/botUtils'

describe('botUtils', () => {
  describe('botUsernameError', () => {
    it('accepts lowercase letters, digits, hyphens and underscores', () => {
      expect(botUsernameError('my_bot-2')).toBeNull()
    })

    it('enforces the 3..32 length bounds of bots.valid_username', () => {
      expect(botUsernameError('ab')).toBe('tooShort')
      expect(botUsernameError('a'.repeat(3))).toBeNull()
      expect(botUsernameError('a'.repeat(32))).toBeNull()
      expect(botUsernameError('a'.repeat(33))).toBe('tooLong')
    })

    it('rejects uppercase, spaces and punctuation', () => {
      expect(botUsernameError('MyBot')).toBe('invalidChars')
      expect(botUsernameError('my bot')).toBe('invalidChars')
      expect(botUsernameError('bot!')).toBe('invalidChars')
    })
  })

  describe('formatTokenHint', () => {
    it('renders a stored 4-character suffix after the token prefix', () => {
      expect(formatTokenHint('a1b2')).toBe('harmony_bot_…a1b2')
    })

    it('returns null for rows that stored the constant prefix', () => {
      expect(formatTokenHint('harmony_')).toBeNull()
    })

    it('returns null for missing or malformed hints', () => {
      expect(formatTokenHint(null)).toBeNull()
      expect(formatTokenHint(undefined)).toBeNull()
      expect(formatTokenHint('')).toBeNull()
      expect(formatTokenHint('ZZZZ')).toBeNull()
    })
  })

  describe('isBotOnline', () => {
    const now = Date.parse('2026-09-30T12:00:00Z')
    const ago = (ms: number) => new Date(now - ms).toISOString()

    it('is online with a recent heartbeat and status online', () => {
      expect(isBotOnline({ status: 'online', last_heartbeat_at: ago(10_000) }, now)).toBe(true)
    })

    it('is offline once the heartbeat is older than the stale window', () => {
      expect(isBotOnline({ status: 'online', last_heartbeat_at: ago(BOT_PRESENCE_STALE_MS) }, now)).toBe(true)
      expect(isBotOnline({ status: 'online', last_heartbeat_at: ago(BOT_PRESENCE_STALE_MS + 1) }, now)).toBe(false)
    })

    it('is offline when the gateway recorded offline', () => {
      expect(isBotOnline({ status: 'offline', last_heartbeat_at: ago(1_000) }, now)).toBe(false)
    })

    it('is offline without a presence row or heartbeat', () => {
      expect(isBotOnline(null, now)).toBe(false)
      expect(isBotOnline(undefined, now)).toBe(false)
      expect(isBotOnline({ status: 'online', last_heartbeat_at: null }, now)).toBe(false)
      expect(isBotOnline({ status: 'online', last_heartbeat_at: 'not-a-date' }, now)).toBe(false)
    })
  })

  describe('permissions', () => {
    it('offers only the flags the gateway checks', () => {
      expect([...ENFORCED_BOT_PERMISSIONS].sort()).toEqual(
        ['add_reactions', 'manage_channels', 'manage_messages', 'read_messages', 'send_messages'],
      )
    })

    it('defaults to read, send and react, with manage_channels only for bridges', () => {
      expect(defaultBotPermissions('bot')).toEqual({
        read_messages: true,
        send_messages: true,
        add_reactions: true,
        manage_messages: false,
        manage_channels: false,
      })
      expect(defaultBotPermissions('bridge').manage_channels).toBe(true)
      expect(defaultBotPermissions(null).manage_channels).toBe(false)
    })

    it('reads enforced flags off a row, drops the rest and forces required ones on', () => {
      const row = {
        read_messages: false,
        send_messages: null,
        add_reactions: true,
        manage_messages: true,
        manage_channels: false,
        kick_members: true,
      }
      expect(enforcedPermissionsFrom(row)).toEqual({
        read_messages: true,
        send_messages: true,
        add_reactions: true,
        manage_messages: true,
        manage_channels: false,
      })
    })
  })

  describe('botSearchFilter', () => {
    it('matches username, display name and description case-insensitively', () => {
      expect(botSearchFilter('echo')).toBe(
        'username.ilike.*echo*,display_name.ilike.*echo*,bio.ilike.*echo*',
      )
    })

    it('strips characters that would break the or() grammar or act as wildcards', () => {
      expect(botSearchFilter('a,b)(c:"d\\e*f%g')).toBe(
        'username.ilike.*a b c d e f g*,display_name.ilike.*a b c d e f g*,bio.ilike.*a b c d e f g*',
      )
    })

    it('returns null for an empty or punctuation-only query', () => {
      expect(botSearchFilter('')).toBeNull()
      expect(botSearchFilter('   ')).toBeNull()
      expect(botSearchFilter('(),*%')).toBeNull()
    })
  })

  describe('buildBotEndpoints', () => {
    it('maps an https origin to wss and the /bot-gateway prefix', () => {
      expect(buildBotEndpoints('https://chat.example.com')).toEqual({
        gatewayUrl: 'wss://chat.example.com/bot-gateway/gateway',
        restBaseUrl: 'https://chat.example.com/bot-gateway/api/v1',
      })
    })

    it('maps an http origin to ws and drops a trailing slash', () => {
      expect(buildBotEndpoints('http://localhost:8080/')).toEqual({
        gatewayUrl: 'ws://localhost:8080/bot-gateway/gateway',
        restBaseUrl: 'http://localhost:8080/bot-gateway/api/v1',
      })
    })
  })
})
