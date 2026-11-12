import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))

import DiscordSyncFields from '../DiscordSyncFields.vue'
import { ALL_SYNC_FIELDS, initialSyncFields } from '../discordSyncFieldList'

describe('DiscordSyncFields', () => {
  it('toggling a field only reports it; nothing is saved', async () => {
    const wrapper = mount(DiscordSyncFields, { props: { modelValue: [] } })
    await wrapper.get('[data-testid="sync-server_nickname"]').setValue(true)
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['server_nickname']])
  })

  it('unticking removes just that field and keeps the field order', async () => {
    const wrapper = mount(DiscordSyncFields, { props: { modelValue: ['avatar', 'banner', 'server_avatar'] } })
    await wrapper.get('[data-testid="sync-banner"]').setValue(false)
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['avatar', 'server_avatar']])
  })

  it('Select all ticks every field and Clear all none', async () => {
    const wrapper = mount(DiscordSyncFields, { props: { modelValue: ['avatar'] } })
    await wrapper.get('[data-testid="sync-select-all"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([ALL_SYNC_FIELDS])
    await wrapper.get('[data-testid="sync-clear-all"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual([[]])
  })

  it('disables the toggles and both buttons while disabled', () => {
    const wrapper = mount(DiscordSyncFields, { props: { modelValue: [], disabled: true } })
    expect(wrapper.get('[data-testid="sync-avatar"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="sync-select-all"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="sync-clear-all"]').attributes('disabled')).toBeDefined()
  })
})

describe('initialSyncFields', () => {
  it('ticks every field until the member has saved a choice', () => {
    expect(initialSyncFields(null)).toEqual(ALL_SYNC_FIELDS)
    expect(initialSyncFields({ syncChosen: false, syncFields: [] })).toEqual(ALL_SYNC_FIELDS)
  })

  it('keeps a saved choice, an empty one included', () => {
    expect(initialSyncFields({ syncChosen: true, syncFields: ['avatar'] })).toEqual(['avatar'])
    expect(initialSyncFields({ syncChosen: true, syncFields: [] })).toEqual([])
  })
})
