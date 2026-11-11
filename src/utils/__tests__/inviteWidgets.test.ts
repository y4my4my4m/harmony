import { describe, expect, it } from 'vitest'
import { inviteWidgetSnippets } from '@/utils/inviteWidgets'

const URL_ = 'https://chat.example/invite/ABCD1234'

describe('inviteWidgetSnippets', () => {
  it('builds widget URLs on the invite host', () => {
    const s = inviteWidgetSnippets(URL_, 'Lounge')!
    expect(s.urls.badge).toBe('https://chat.example/api/federation/widget/invite/ABCD1234/badge.svg')
    expect(s.urls.join).toContain('style=join')
    expect(s.urls.icon).toContain('style=icon')
    expect(s.urls.card).toBe('https://chat.example/api/federation/widget/invite/ABCD1234')
  })

  it('escapes the server name in attributes and in the Markdown label', () => {
    const s = inviteWidgetSnippets(URL_, '"><script>x</script>[a]')!
    expect(s.badgeHtml).not.toContain('<script>')
    expect(s.cardHtml).not.toContain('<script>')
    expect(s.badgeMarkdown).toContain('\\[a\\]')
  })

  it('carries a supported locale and no English one', () => {
    expect(inviteWidgetSnippets(URL_, 'L', 'ja')!.urls.badge).toContain('?lang=ja')
    expect(inviteWidgetSnippets(URL_, 'L', 'en')!.urls.badge).not.toContain('lang=')
    expect(inviteWidgetSnippets(URL_, 'L', 'ja')!.urls.icon).toContain('style=icon&lang=ja')
  })

  it('sandboxes the iframe, keeping popups for the join link', () => {
    expect(inviteWidgetSnippets(URL_, 'L')!.cardHtml).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"')
  })

  it('answers null for anything but an invite URL', () => {
    expect(inviteWidgetSnippets('https://chat.example/chat/1', 'L')).toBeNull()
    expect(inviteWidgetSnippets('not a url', 'L')).toBeNull()
  })
})
