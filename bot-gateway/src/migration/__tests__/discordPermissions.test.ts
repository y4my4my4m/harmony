import { describe, expect, it } from 'vitest'
import { DISCORD_TO_HARMONY, toHarmonyMask } from '../discordPermissions'

// Harmony bit order (index = bit position), as the permission_bit_names RPC returns it.
const BIT_NAMES = [
  'ADMINISTRATOR', 'VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_EMOJIS',
  'VIEW_AUDIT_LOG', 'MANAGE_WEBHOOKS', 'MANAGE_SERVER', 'CREATE_INVITE', 'KICK_MEMBERS',
  'BAN_MEMBERS', 'TIMEOUT_MEMBERS', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS',
  'CREATE_PUBLIC_THREADS', 'CREATE_PRIVATE_THREADS', 'EMBED_LINKS', 'ATTACH_FILES',
  'ADD_REACTIONS', 'USE_EXTERNAL_EMOJIS', 'MENTION_EVERYONE', 'MANAGE_MESSAGES',
  'READ_MESSAGE_HISTORY', 'PIN_MESSAGES', 'CONNECT', 'SPEAK', 'STREAM', 'MUTE_MEMBERS',
  'DEAFEN_MEMBERS', 'MOVE_MEMBERS', 'USE_SOUNDBOARD', 'USE_EXTERNAL_SOUNDS',
  'CHANGE_NICKNAME', 'MANAGE_NICKNAMES',
]

describe('DISCORD_TO_HARMONY', () => {
  it('has the bridge rows plus ADMINISTRATOR', () => {
    expect(DISCORD_TO_HARMONY).toHaveLength(34)
    expect(DISCORD_TO_HARMONY).toContainEqual([1n << 3n, 'ADMINISTRATOR'])
  })
})

describe('toHarmonyMask', () => {
  it('maps Discord Administrator alone to bit 0', () => {
    expect(toHarmonyMask((1n << 3n).toString(), BIT_NAMES)).toBe('1')
  })
  it('maps KickMembers|BanMembers to bits 9 and 10', () => {
    expect(toHarmonyMask(((1n << 1n) | (1n << 2n)).toString(), BIT_NAMES)).toBe('1536')
  })
  it('skips names missing from bitNames', () => {
    const names = BIT_NAMES.filter((n) => n !== 'MANAGE_NICKNAMES')
    expect(toHarmonyMask((1n << 27n).toString(), names)).toBe('0')
  })
  it('maps ChangeNickname to bit 32', () => {
    expect(toHarmonyMask((1n << 26n).toString(), BIT_NAMES)).toBe('4294967296')
  })
  it('ignores Discord bits with no Harmony equivalent', () => {
    expect(toHarmonyMask(((1n << 6n) | (1n << 49n)).toString(), BIT_NAMES)).toBe((1n << 18n).toString())
  })
})
