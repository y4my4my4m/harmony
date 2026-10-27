/**
 * The inline message editor: on a phone Enter is the editor's line break and Save / Cancel
 * buttons end the edit; on a desktop Enter saves and the translated hint offers cancel and
 * save as buttons.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mobile = vi.hoisted(() => ({ value: false }))
vi.mock('@/composables/useViewport', async () => {
  const { ref: vueRef } = await import('vue')
  const isMobileViewport = vueRef(false)
  Object.defineProperty(mobile, 'value', { get: () => isMobileViewport.value, set: (v: boolean) => { isMobileViewport.value = v } })
  return { useViewport: () => ({
    viewportWidth: vueRef(1024),
    viewportHeight: vueRef(768),
    isMobileViewport,
    isTouchOnly: false,
    MOBILE_BREAKPOINT: 768,
  }) }
})

import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import RichTextEditor from '@/components/RichTextEditor.vue'
import { i18n, waitForInitialLocale } from '@/i18n'

function mountEditing() {
  setActivePinia(createPinia())
  return shallowMount(UnifiedMessageContent, {
    props: {
      content: [{ type: 'text', text: 'hello' }],
      messageId: 'm1',
      editableMessageId: 'm1',
      editableContent: 'hello',
    },
    // The hint is a <i18n-t> with button slots; shallowMount would stub it.
    global: { plugins: [i18n], stubs: { 'i18n-t': false } },
  })
}

function enter(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Enter', shiftKey, cancelable: true })
}

beforeAll(async () => {
  await waitForInitialLocale()
})

beforeEach(() => {
  mobile.value = false
})

describe('message editor', () => {
  it('on a phone Enter neither saves nor takes the key from the editor', async () => {
    mobile.value = true
    const w = mountEditing()
    const event = enter()
    w.findComponent(RichTextEditor).vm.$emit('keydown', event)
    await w.vm.$nextTick()
    expect(w.emitted('update:message')).toBeUndefined()
    expect(event.defaultPrevented).toBe(false)
  })

  it('on a phone Save and Cancel are buttons and the key hint is absent', async () => {
    mobile.value = true
    const w = mountEditing()
    expect(w.find('.edit-hint').exists()).toBe(false)
    await w.get('[data-testid="edit-save"]').trigger('click')
    expect(w.emitted('update:message')?.[0]).toEqual(['m1', 'hello', []])
    await w.get('[data-testid="edit-cancel"]').trigger('click')
    expect(w.emitted('cancel-edit')).toHaveLength(1)
  })

  it('on a desktop Enter saves and Shift+Enter does not', async () => {
    const w = mountEditing()
    const shifted = enter(true)
    w.findComponent(RichTextEditor).vm.$emit('keydown', shifted)
    expect(w.emitted('update:message')).toBeUndefined()
    const event = enter()
    w.findComponent(RichTextEditor).vm.$emit('keydown', event)
    expect(event.defaultPrevented).toBe(true)
    expect(w.emitted('update:message')?.[0]).toEqual(['m1', 'hello', []])
  })

  it('on a desktop the hint is translated and its actions are buttons', () => {
    const w = mountEditing()
    expect(w.get('.edit-hint').text().replace(/\s+/g, ' ')).toBe('escape to cancel • enter to save')
    expect(w.get('.edit-hint [data-testid="edit-cancel"]').element.tagName).toBe('BUTTON')
    expect(w.get('.edit-hint [data-testid="edit-save"]').element.tagName).toBe('BUTTON')
  })
})
