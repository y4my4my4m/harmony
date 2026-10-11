import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { resetLayersForTests } from '@/utils/a11y/layers'

// The mobile voice preview is a modal dialog named by the channel, with named
// buttons, a pressed join-muted toggle, focus on Join, and Escape closing.

const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ getUserAvatarUrl: () => ({ value: '' }) }) }))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/EmptyState.vue', () => stub('EmptyState'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))

import MobileVoiceChannelPreview from '../MobileVoiceChannelPreview.vue'

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  resetLayersForTests()
  document.body.innerHTML = ''
})

async function open() {
  wrapper = mount(MobileVoiceChannelPreview, {
    props: { isVisible: true, channelId: 'c1', channelName: 'Lounge', participants: [{ id: 'bob' }] },
    attachTo: document.body,
    global: { stubs: { transition: false } },
  })
  await flushPromises()
  return document.querySelector<HTMLElement>('[data-testid="mobile-voice-preview"]')!
}

describe('MobileVoiceChannelPreview', () => {
  it('is a modal dialog named by the channel with focus on Join', async () => {
    const dialog = await open()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Lounge')
    expect(document.activeElement?.textContent?.trim()).toBe('voice.join')
  })

  it('names every button and reports the join-muted state', async () => {
    const dialog = await open()
    const unnamed = Array.from(dialog.querySelectorAll('button')).filter((b) => !b.getAttribute('aria-label') && !b.textContent?.trim())
    expect(unnamed).toEqual([])
    const muted = Array.from(dialog.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'voice.joinMuted')!
    expect(muted.getAttribute('aria-pressed')).toBe('false')
    muted.click()
    await flushPromises()
    expect(muted.getAttribute('aria-pressed')).toBe('true')
    ;(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'voice.join') as HTMLElement).click()
    expect(wrapper!.emitted('join')?.[0]).toEqual([true])
  })

  it('closes on Escape', async () => {
    await open()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })
})
