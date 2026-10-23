/**
 * instance_config public_profile_pages as the instance settings store reads it: on unless
 * false, as public.public_page_instance() reads it.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useInstanceSettingsStore } from '../useInstanceSettings'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('publicProfilePages', () => {
  it('is on by default', () => {
    expect(useInstanceSettingsStore().settings.publicProfilePages).toBe(true)
  })

  it.each([
    [false, false],
    ['false', false],
    ['"false"', false],
    [true, true],
    ['true', true],
    [null, true],
  ])('reads %j as %s', (value, expected) => {
    const store = useInstanceSettingsStore()
    store.parseConfigData([{ config_key: 'public_profile_pages', config_value: value }])
    expect(store.settings.publicProfilePages).toBe(expected)
  })
})
