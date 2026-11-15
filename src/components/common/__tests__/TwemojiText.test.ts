import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { compileStyle, parse } from 'vue/compiler-sfc'

vi.mock('@/composables/useEmojiLoader', () => ({ ensureEmojiDataLoaded: vi.fn() }))
vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({
    isLoaded: ref(true),
    isNativePack: ref(false),
    getTwemojiUrl: (text: string) => `/assets/emojis/twemoji/${text.codePointAt(0)!.toString(16)}.svg`,
  }),
}))

import TwemojiText from '../TwemojiText.vue'

const SFC = resolve(__dirname, '..', 'TwemojiText.vue')

// Vitest stubs SFC styles; the component's own scoped CSS is compiled and attached here.
function attachComponentStyle(): HTMLStyleElement {
  const { descriptor } = parse(readFileSync(SFC, 'utf8'), { filename: SFC })
  const scopeId = (TwemojiText as { __scopeId?: string }).__scopeId ?? ''
  const css = descriptor.styles.map((block) => compileStyle({
    source: block.content,
    filename: SFC,
    id: scopeId,
    scoped: block.scoped,
  }).code).join('\n')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  return style
}

describe('TwemojiText', () => {
  let style: HTMLStyleElement | null = null

  afterEach(() => {
    style?.remove()
    style = null
  })

  it('draws each emoji as an image of the pack', () => {
    const wrapper = mount(TwemojiText, { props: { text: 'join 🙂' } })
    const img = wrapper.get('img.inline-emoji')
    expect(img.attributes('src')).toBe('/assets/emojis/twemoji/1f642.svg')
    expect(img.attributes('alt')).toBe('🙂')
    expect(wrapper.text()).toBe('join')
  })

  // The pack's SVGs have a viewBox and no width or height, so an unsized image lays out at 300px
  // and raises the reply line to that height.
  it('sizes the emoji image to the text on both axes', () => {
    style = attachComponentStyle()
    const wrapper = mount(TwemojiText, {
      props: { text: 'I was testing out the federated discovery feature 🙂' },
      attachTo: document.body,
    })
    const computed = getComputedStyle(wrapper.get('img.inline-emoji').element)
    const fontSize = parseFloat(computed.fontSize)
    expect(fontSize).toBeGreaterThan(0)
    expect(parseFloat(computed.height)).toBeCloseTo(fontSize * 1.2)
    expect(parseFloat(computed.width)).toBeCloseTo(fontSize * 1.2)
    wrapper.unmount()
  })
})
