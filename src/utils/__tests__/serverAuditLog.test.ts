import { describe, expect, it } from 'vitest'
import type { ServerAuditEntry } from '@/services/ServerAuditLogService'
import {
  auditActorName,
  auditChangeLines,
  describeAuditEntry,
  permissionNames,
  type AuditTranslate,
} from '../serverAuditLog'

const TEMPLATES: Record<string, string> = {
  'serverAuditLog.actions.channel_delete': '{actor} deleted channel {target}',
  'serverAuditLog.actions.member_role_add': '{actor} gave {target} the role {subject}',
  'serverAuditLog.actions.member_timeout': '{actor} timed out {target} until {until}',
  'serverAuditLog.actions.unknown': '{actor}: {action}',
  'serverAuditLog.value.seconds': '{n} s',
}

// Known keys interpolate like vue-i18n; any other key comes back as itself.
const t: AuditTranslate = (key, named) => {
  const template = TEMPLATES[key]
  if (!template) return key
  return template.replace(/\{(\w+)\}/g, (_, name) => String(named?.[name] ?? ''))
}
const date = (iso: string) => `D<${iso}>`

function entry(overrides: Partial<ServerAuditEntry>): ServerAuditEntry {
  return {
    id: 'e1',
    created_at: '2026-10-10T10:00:00Z',
    action: 'channel.update',
    source: 'user',
    actor_id: 'u-alice',
    actor_username: 'alice',
    actor_display_name: 'Alice',
    actor_avatar_url: null,
    actor_bot_id: null,
    actor_bot_name: null,
    actor_bot_avatar_url: null,
    target_type: 'channel',
    target_id: 'c1',
    target_name: 'general',
    target_display_name: null,
    target_avatar_url: null,
    changes: null,
    details: null,
    reason: null,
    ...overrides,
  }
}

describe('permissionNames', () => {
  it('lists the set bits in bit order', () => {
    expect(permissionNames(1 + 4 + 2048)).toEqual(['Administrator', 'Manage Channels', 'Timeout Members'])
    expect(permissionNames('32')).toEqual(['View Audit Log'])
    expect(permissionNames(null)).toEqual([])
    expect(permissionNames('not a number')).toEqual([])
  })

  it('names USE_SOUNDBOARD, bit 30', () => {
    expect(permissionNames(2 ** 30)).toEqual(['Use Soundboard'])
  })

  it('names USE_EXTERNAL_SOUNDS, bit 31', () => {
    expect(permissionNames(String(2 ** 31 + 2 ** 30))).toEqual(['Use Soundboard', 'Use External Sounds'])
  })
})

describe('sound entries', () => {
  it('describe the sound and show its volume as a percentage', () => {
    const edit = entry({
      action: 'sound.update',
      target_type: 'sound',
      target_name: 'Air horn',
      changes: { name: { old: 'Airhorn', new: 'Air horn' }, volume: { old: 0.8, new: 0.5 }, emoji: { old: '📯' } },
    })
    expect(describeAuditEntry(edit, t, date).map((s) => s.text)).toEqual(['serverAuditLog.actions.sound_update'])
    expect(auditChangeLines(edit, t, date)).toEqual([
      { field: 'serverAuditLog.fields.name', from: 'Airhorn', to: 'Air horn' },
      { field: 'serverAuditLog.fields.volume', from: '80%', to: '50%' },
      { field: 'serverAuditLog.fields.emoji', from: '📯', to: null },
    ])
  })
})

describe('auditActorName', () => {
  it('prefers the display name, then the bot, then AutoMod or System', () => {
    expect(auditActorName(entry({}), t)).toBe('Alice')
    expect(auditActorName(entry({ actor_display_name: null }), t)).toBe('alice')
    expect(auditActorName(entry({ actor_id: null, actor_bot_id: 'b1', actor_bot_name: 'Builder', source: 'bot' }), t)).toBe('Builder')
    expect(auditActorName(entry({ actor_id: null, source: 'system', details: { automod: true } }), t)).toBe('serverAuditLog.automod')
    expect(auditActorName(entry({ actor_id: null, source: 'system' }), t)).toBe('serverAuditLog.system')
  })
})

describe('describeAuditEntry', () => {
  it('marks the actor and the target and keeps the surrounding text', () => {
    const segments = describeAuditEntry(entry({ action: 'channel.delete' }), t, date)
    expect(segments).toEqual([
      { text: 'Alice', role: 'actor' },
      { text: ' deleted channel ' },
      { text: '#general', role: 'target' },
    ])
  })

  it('names the role in an assignment and formats a timeout end', () => {
    const roleAdd = describeAuditEntry(entry({
      action: 'member.role_add', target_type: 'user', target_name: 'bob', target_display_name: 'Bob',
      details: { role_name: 'Mods' },
    }), t, date)
    expect(roleAdd.filter(s => s.role).map(s => `${s.role}:${s.text}`)).toEqual(['actor:Alice', 'target:Bob', 'subject:Mods'])

    const timeout = describeAuditEntry(entry({
      action: 'member.timeout', target_type: 'user', target_name: 'bob',
      details: { until: '2026-10-11T00:00:00Z' },
    }), t, date)
    expect(timeout.map(s => s.text).join('')).toBe('Alice timed out bob until D<2026-10-11T00:00:00Z>')
  })

  it('passes the folded message count for pluralisation', () => {
    let plural: number | undefined
    const counting: AuditTranslate = (key, named, n) => { plural = n; return t(key, named) }
    describeAuditEntry(entry({
      action: 'message.delete', target_type: 'user', target_name: 'bob',
      details: { channel_name: 'general', count: 3 },
    }), counting, date)
    expect(plural).toBe(3)
  })

  it('falls back for an action it does not know', () => {
    const segments = describeAuditEntry(entry({ action: 'webhook.create' }), t, date)
    expect(segments.map(s => s.text).join('')).toBe('Alice: webhook.create')
  })
})

describe('auditChangeLines', () => {
  it('shows permission masks as added and removed names', () => {
    const lines = auditChangeLines(entry({
      action: 'role.update', target_type: 'role',
      changes: { permissions: { old: 16, new: 4 }, color: { new: '#ff0000' } },
    }), t, date)
    expect(lines).toEqual([
      { field: 'serverAuditLog.fields.permissions', from: null, to: null, added: ['Manage Channels'], removed: ['Manage Emojis'] },
      { field: 'serverAuditLog.fields.color', from: null, to: '#ff0000' },
    ])
  })

  it('formats booleans, empty values and slowmode, and hides stored paths', () => {
    const lines = auditChangeLines(entry({
      action: 'server.update', target_type: 'server',
      changes: {
        public: { old: false, new: true },
        description: { new: 'hello' },
        icon: { old: 'a.png', new: 'b.png' },
      },
    }), t, date)
    expect(lines).toEqual([
      { field: 'serverAuditLog.fields.public', from: 'serverAuditLog.value.off', to: 'serverAuditLog.value.on' },
      { field: 'serverAuditLog.fields.description', from: null, to: 'hello' },
      { field: 'serverAuditLog.fields.icon', from: null, to: 'serverAuditLog.value.changed' },
    ])
    const slow = auditChangeLines(entry({ changes: { slowmode_seconds: { old: 0, new: 10 } } }), t, date)
    expect(slow[0]).toEqual({ field: 'serverAuditLog.fields.slowmode_seconds', from: '0 s', to: '10 s' })
  })

  it('leaves the name of a created row to the sentence and skips its unset fields', () => {
    const lines = auditChangeLines(entry({
      action: 'channel.create',
      changes: { name: { new: 'general' }, type: { new: 0 }, category: { new: 'Text' }, slowmode_seconds: { new: 0 } },
    }), t, date)
    expect(lines).toEqual([{ field: 'serverAuditLog.fields.category', from: null, to: 'Text' }])
  })

  it('lists reordered rows and kick message counts', () => {
    const reorder = auditChangeLines(entry({
      action: 'channel.reorder', target_type: null, target_id: null, target_name: null,
      details: { items: { c1: { name: 'general', old: 0, new: 2 } } },
    }), t, date)
    expect(reorder).toEqual([{ field: '#general', from: '0', to: '2' }])

    const kick = auditChangeLines(entry({ action: 'member.kick', target_type: 'user', details: { messages_deleted: 4 } }), t, date)
    expect(kick).toEqual([{ field: 'serverAuditLog.fields.messages_deleted', from: null, to: '4' }])
  })
})
