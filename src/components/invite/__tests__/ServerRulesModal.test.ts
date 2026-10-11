/**
 * Rules dialog shown before joining a server with rules: a modal dialog named
 * by its title that takes focus, keeps Tab inside, closes on Escape, and
 * whose Agree and join button is reachable and operable from the keyboard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { resetLayersForTests } from '@/utils/a11y/layers'
import ServerRulesModal from '../ServerRulesModal.vue'

enableAutoUnmount(afterEach)

const PROPS = {
  show: false,
  serverName: 'Town Hall',
  serverRules: ['Be kind', 'No spam'],
  instanceRules: ['Follow the law'],
  instanceName: 'Harmony',
  joining: false,
}

let opener: HTMLButtonElement

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
  const page = document.createElement('div')
  page.innerHTML = '<button id="opener">Accept invite</button>'
  document.body.append(page)
  opener = document.getElementById('opener') as HTMLButtonElement
  opener.focus()
})

async function open(props: Partial<typeof PROPS> = {}): Promise<VueWrapper> {
  const wrapper = mount(ServerRulesModal, { props: { ...PROPS, ...props } })
  await wrapper.setProps({ show: true })
  await flushPromises()
  return wrapper
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!

function key(name: string, shift = false) {
  const event = new KeyboardEvent('keydown', { key: name, shiftKey: shift, bubbles: true, cancelable: true })
  ;(document.activeElement ?? document.body).dispatchEvent(event)
}

describe('ServerRulesModal', () => {
  it('is a modal dialog named by its title and described by its subtitle', async () => {
    await open()
    const el = dialog()
    expect(el.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent).toBe('invite.rules.title')
    expect(document.getElementById(el.getAttribute('aria-describedby')!)?.textContent).toBe('invite.rules.subtitle')
    const headings = Array.from(el.querySelectorAll('h3')).map((h) => h.textContent?.trim())
    expect(headings).toEqual(['invite.rules.instanceHeading', 'invite.rules.serverHeading'])
    expect(el.querySelectorAll('ol li')).toHaveLength(3)
  })

  it('moves focus into the dialog when it opens', async () => {
    await open()
    expect(dialog().contains(document.activeElement)).toBe(true)
  })

  it('reaches Agree and join by keyboard and agrees on activation', async () => {
    const wrapper = await open()
    // Shift+Tab from the dialog wraps to its last control.
    key('Tab', true)
    const agree = document.activeElement as HTMLButtonElement
    expect(agree.getAttribute('data-testid')).toBe('server-rules-agree')
    expect(agree.textContent?.trim()).toBe('invite.rules.agree')
    expect(document.getElementById(agree.getAttribute('aria-describedby')!)?.textContent)
      .toBe('invite.rules.agreementNote')
    agree.click()
    expect(wrapper.emitted('agree')).toHaveLength(1)
  })

  it('keeps Tab inside the dialog', async () => {
    await open()
    const agree = document.querySelector<HTMLButtonElement>('[data-testid="server-rules-agree"]')!
    agree.focus()
    // The browser moves focus between controls; the dialog wraps at its ends.
    key('Tab')
    expect(document.activeElement?.classList.contains('close-button')).toBe(true)
    key('Tab', true)
    expect(document.activeElement).toBe(agree)
  })

  it('cancels on Escape and on Back', async () => {
    const wrapper = await open()
    key('Escape')
    expect(wrapper.emitted('close')).toHaveLength(1)
    ;(document.querySelector('[data-testid="server-rules-back"]') as HTMLButtonElement).click()
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('returns focus to the opener when it closes', async () => {
    const wrapper = await open()
    await wrapper.setProps({ show: false })
    await flushPromises()
    expect(document.activeElement).toBe(opener)
  })

  it('stays focusable but inert while joining', async () => {
    const wrapper = await open({ joining: true })
    const agree = document.querySelector<HTMLButtonElement>('[data-testid="server-rules-agree"]')!
    expect(agree.disabled).toBe(false)
    expect(agree.getAttribute('aria-disabled')).toBe('true')
    expect(agree.getAttribute('aria-busy')).toBe('true')
    agree.click()
    expect(wrapper.emitted('agree')).toBeUndefined()
  })
})
