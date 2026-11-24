/**
 * An encrypted message whose signature does not verify shows as forged, with no decrypt
 * affordance; one waiting for its key keeps the click-to-decrypt glyphs. A decrypted message whose
 * session index an earlier message holds carries the repeated badge.
 */
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

const CIPHERTEXT = [{ type: 'text', text: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=' }]

async function render(props: Record<string, unknown>, content: unknown[] = CIPHERTEXT) {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')
  const wrapper = shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', editableContent: '', ...props },
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper
}

describe('UnifiedMessageContent decryption failures', () => {
  it('shows a forged message as forged, with nothing to click', async () => {
    const w = await render({ encrypted: true, decrypted: false, canDecrypt: true, decryptionError: 'forged' })
    const notice = w.find('[data-testid="message-forged"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('messageA11y.encrypted.forged')
    expect(notice.attributes('title')).toBe('messageA11y.encrypted.forgedHint')
    expect(w.find('.encrypted-click-target').exists()).toBe(false)
  })

  it('keeps click-to-decrypt for a message waiting for its key', async () => {
    const w = await render({ encrypted: true, decrypted: false, canDecrypt: true, decryptionError: 'missing_key' })
    expect(w.find('[data-testid="message-forged"]').exists()).toBe(false)
    expect(w.find('.encrypted-click-target').exists()).toBe(true)
  })

  it('marks a replayed message', async () => {
    const w = await render({ encrypted: false, decrypted: true, senderVerified: true, replayed: true }, [{ type: 'text', text: 'yes' }])
    const badge = w.find('[data-testid="message-replayed"]')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('title')).toBe('messageA11y.encrypted.replayedHint')
  })

  it('leaves a decrypted message without the badge by default', async () => {
    const w = await render({ encrypted: false, decrypted: true, senderVerified: true }, [{ type: 'text', text: 'yes' }])
    expect(w.find('[data-testid="message-replayed"]').exists()).toBe(false)
  })
})
