import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { resetLayersForTests } from '@/utils/a11y/layers'

// Incoming call for keyboard and screen-reader users: an alertdialog that
// takes focus on Accept and traps Tab; Escape minimizes to a card that takes
// focus and names its buttons; the call ending returns focus to where it was.

const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ __esModule: true, default: { name, render: () => null } }) }))
vi.mock('@/stores/useTheme', () => ({ useThemeStore: () => ({ playAudio: vi.fn() }) }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => ({ conversations: [] }) }))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/DisplayName.vue', () => ({
  __esModule: true,
  default: { name: 'DisplayName', props: ['userId', 'fallback'], render(this: any) { return this.fallback } },
}))

import IncomingCallModal from '../IncomingCallModal.vue'

let wrapper: VueWrapper | null = null
let opener: HTMLButtonElement

const props = { callerId: 'alice', callerName: 'Alice', callerAvatar: '/a.webp', callType: 'voice' as const, conversationId: 'conv1' }

beforeEach(() => {
  opener = document.createElement('button')
  opener.textContent = 'Composer'
  document.body.appendChild(opener)
  opener.focus()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  resetLayersForTests()
  document.body.innerHTML = ''
})

async function ring() {
  wrapper = mount(IncomingCallModal, { props: { ...props, show: false }, attachTo: document.body })
  await wrapper.setProps({ show: true })
  await flushPromises()
  return document.querySelector<HTMLElement>('[data-testid="incoming-call-modal"]')!
}

const keydown = (key: string, target: EventTarget = document.activeElement ?? document.body, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, shiftKey })
  target.dispatchEvent(event)
  return event
}

describe('IncomingCallModal', () => {
  it('is a labelled alertdialog with focus on Accept', async () => {
    const modal = await ring()
    expect(modal.getAttribute('role')).toBe('alertdialog')
    expect(modal.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(modal.getAttribute('aria-labelledby')!)?.textContent).toContain('Alice')
    expect(document.getElementById(modal.getAttribute('aria-describedby')!)?.textContent).toContain('dm.incomingVoiceCall')
    expect(document.activeElement).toBe(document.querySelector('[data-testid="incoming-call-accept"]'))
  })

  it('keeps Tab inside the dialog', async () => {
    const modal = await ring()
    const buttons = Array.from(modal.querySelectorAll<HTMLElement>('button'))
    buttons[buttons.length - 1].focus()
    keydown('Tab')
    expect(document.activeElement).toBe(buttons[0])
    keydown('Tab', document.activeElement!, true)
    expect(document.activeElement).toBe(buttons[buttons.length - 1])
  })

  it('minimizes on Escape to a focused card with named buttons, and expands back', async () => {
    await ring()
    keydown('Escape')
    await flushPromises()
    expect(document.querySelector('[data-testid="incoming-call-modal"]')).toBeNull()
    const mini = document.querySelector<HTMLElement>('[data-testid="incoming-call-mini"]')!
    expect(mini.getAttribute('role')).toBe('alertdialog')
    expect(document.activeElement).toBe(mini)
    const labels = Array.from(mini.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['dm.callExpand', 'dm.callDecline', 'dm.callAccept'])

    ;(mini.querySelector('.mini-expand') as HTMLElement).click()
    await flushPromises()
    expect(document.activeElement).toBe(document.querySelector('[data-testid="incoming-call-accept"]'))
  })

  it('returns focus to the control focused before the call once it ends', async () => {
    await ring()
    ;(document.querySelector('[data-testid="incoming-call-decline"]') as HTMLElement).click()
    expect(wrapper!.emitted('decline')).toHaveLength(1)
    await wrapper!.setProps({ show: false })
    await flushPromises()
    expect(document.activeElement).toBe(opener)
  })

  it('returns focus after a decline from the minimized card', async () => {
    await ring()
    keydown('Escape')
    await flushPromises()
    ;(document.querySelector('[data-testid="incoming-call-mini-decline"]') as HTMLElement).click()
    await wrapper!.setProps({ show: false })
    await flushPromises()
    expect(document.activeElement).toBe(opener)
  })
})
