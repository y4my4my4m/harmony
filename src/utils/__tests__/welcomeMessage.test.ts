import { describe, it, expect } from 'vitest'
import { renderWelcomeMessage } from '@/utils/welcomeMessage'

describe('renderWelcomeMessage', () => {
  it('renders the chat markdown subset', () => {
    const html = renderWelcomeMessage('Hi **all**, read *this* and `that`')
    expect(html).toContain('<strong class="md-bold">all</strong>')
    expect(html).toContain('<em class="md-italic">this</em>')
    expect(html).toContain('<code class="md-code">that</code>')
  })

  it('escapes markup', () => {
    const html = renderWelcomeMessage('<img src=x onerror=alert(1)><script>alert(2)</script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('links bare URLs and leaves code alone', () => {
    const html = renderWelcomeMessage('Wiki: https://example.org/wiki?a=1&b=2. Not `https://inside.code`')
    expect(html).toContain('<a href="https://example.org/wiki?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">')
    expect(html).not.toContain('href="https://inside.code"')
  })

  it('refuses javascript: links', () => {
    expect(renderWelcomeMessage('javascript:alert(1)')).not.toContain('href')
  })

  it('renders fenced code as a block', () => {
    const html = renderWelcomeMessage('```\nnpm i <x>\n```')
    expect(html).toContain('<code class="md-code-block">npm i &lt;x&gt;</code>')
  })

  it('returns nothing for an empty message', () => {
    expect(renderWelcomeMessage('')).toBe('')
  })
})
