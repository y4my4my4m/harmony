import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const { setMySync } = vi.hoisted(() => ({ setMySync: vi.fn(async () => {}) }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/services/discordMigrationService', () => ({ setMySync }))

import DiscordSyncFields from '../DiscordSyncFields.vue'

describe('DiscordSyncFields', () => {
  it('toggling server_nickname saves exactly that field for the server', async () => {
    const wrapper = mount(DiscordSyncFields, { props: { serverId: 'srv', modelValue: [] } })
    await wrapper.get('[data-testid="sync-server_nickname"]').setValue(true)
    await flushPromises()
    expect(setMySync).toHaveBeenCalledWith('srv', ['server_nickname'])
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['server_nickname']])
  })

  it('without a server only emits (new-account form)', async () => {
    setMySync.mockClear()
    const wrapper = mount(DiscordSyncFields, { props: { serverId: null, modelValue: ['avatar'] } })
    await wrapper.get('[data-testid="sync-avatar"]').setValue(false)
    expect(setMySync).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([[]])
  })
})
