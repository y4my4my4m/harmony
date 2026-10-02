import { describe, it, expect } from 'vitest'
import { SERVER_SETTINGS_KEYS, diffServerSettings, pickServerSettings } from '../serverSettings'

describe('SERVER_SETTINGS_KEYS', () => {
  // Mirrors v_writable in update_server, db_schema/migrations/20261006400001_server_category.sql.
  it('match the columns update_server writes', () => {
    expect([...SERVER_SETTINGS_KEYS]).toEqual([
      'name', 'description', 'icon', 'banner', 'public', 'federation_enabled',
      'allow_cross_server_emojis', 'rules', 'category',
    ])
  })
})

describe('pickServerSettings', () => {
  it('keeps settings keys and drops everything else', () => {
    expect(pickServerSettings({
      id: 's', name: 'N', owner: 'o', is_local_server: true, created_at: 'x', public: false, rules: [],
    })).toEqual({ name: 'N', public: false, rules: [] })
  })

  it('keeps null and drops undefined', () => {
    expect(pickServerSettings({ category: null, banner: undefined })).toEqual({ category: null })
  })
})

describe('diffServerSettings', () => {
  const before = {
    id: 's', name: 'N', description: 'D', owner: 'o', public: true, rules: ['a'], category: null,
  }

  it('returns only changed settings keys', () => {
    expect(diffServerSettings(before, { ...before, name: 'M', owner: 'p' })).toEqual({ name: 'M' })
  })

  it('compares rules by value', () => {
    expect(diffServerSettings(before, { ...before, rules: ['a'] })).toEqual({})
    expect(diffServerSettings(before, { ...before, rules: ['a', 'b'] })).toEqual({ rules: ['a', 'b'] })
  })

  it('treats null and undefined as equal and sends null for a cleared value', () => {
    expect(diffServerSettings(before, { ...before, category: undefined })).toEqual({})
    expect(diffServerSettings({ ...before, category: 'music' }, { ...before, category: undefined }))
      .toEqual({ category: null })
  })
})
