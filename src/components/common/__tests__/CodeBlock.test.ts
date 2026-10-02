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

  it('renders highlighter output as class-only spans', () => {
    const payloads: Array<[string, string]> = [
      ['html', `<a x='"' onmouseover=alert(1) y='"'><img src=x onerror=alert(1)>`],
      ['html', `<b class="x" title="</span><img src=x onerror=alert(1)>">`],
      ['ts', `const s = "<span onclick=alert(1)>type</span>"`],
      ['js', '___STRING_START___<img src=x onerror=alert(1)>___STRING_END___'],
      ['text', '<iframe src="javascript:alert(1)"></iframe>'],
    ]
    for (const [language, code] of payloads) {
      const wrapper = mount(CodeBlock, { props: { code, language } })
      const codeEl = wrapper.find('code').element
      for (const el of Array.from(codeEl.querySelectorAll('*'))) {
        expect(el.tagName, code).toBe('SPAN')
        expect(Array.from(el.attributes).map((a) => a.name).filter((n) => n !== 'class'), code).toEqual([])
      }
    }
  })
})
