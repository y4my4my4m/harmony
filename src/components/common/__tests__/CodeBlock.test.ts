import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CodeBlock from '../CodeBlock.vue'

describe('CodeBlock', () => {
  it('renders <code> as the only child of <pre>', () => {
    const wrapper = mount(CodeBlock, { props: { code: 'const a = 1', language: 'js' } })
    const pre = wrapper.find('pre').element
    expect(pre.childNodes).toHaveLength(1)
    expect(pre.firstChild?.nodeName).toBe('CODE')
  })

  it('puts the copy button beside the language label', async () => {
    const wrapper = mount(CodeBlock, { props: { code: 'x', language: 'ts' } })
    await wrapper.trigger('mouseenter')
    const header = wrapper.find('.code-block-header').element
    const names = Array.from(header.children).map((el) => el.className)
    expect(names[0]).toContain('language-label')
    expect(names[1]).toContain('copy-button')
  })
})
