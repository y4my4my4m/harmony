import { describe, expect, it } from 'vitest'
import { renderChatMessageText, type ChatMessageRendererOptions } from '../chatMessageTextRenderer'
import { isSpoilerFileName, maskSpoilers, toggleSpoilerFileName } from '../spoiler'

const options: ChatMessageRendererOptions = {
  isNativePack: true,
  emojiServiceLoaded: false,
  resolveEmoji: () => ({ display: { type: 'native', content: '' } }),
  isSingleEmoji: false,
  greentextEnabled: true,
}

const render = (text: string) => renderChatMessageText(text, options).renderedText

describe('text spoilers', () => {
  it('wraps ||text|| in a spoiler span', () => {
    expect(render('the end: ||he lives||!')).toBe('the end: <span class="md-spoiler">he lives</span>!')
  })

  it('keeps other formatting inside, and escapes its content', () => {
    expect(render('||**big** <b>x</b>||')).toBe('<span class="md-spoiler"><strong class="md-bold">big</strong> &lt;b&gt;x&lt;/b&gt;</span>')
  })

  it('leaves inline code and padded or empty bars alone', () => {
    expect(render('`a ||b|| c`')).toBe('<code class="md-code">a ||b|| c</code>')
    expect(render('|| not || and ||||')).toBe('|| not || and ||||')
  })

  it('handles several on one line', () => {
    expect(render('||a|| and ||b||')).toBe('<span class="md-spoiler">a</span> and <span class="md-spoiler">b</span>')
  })
})

describe('spoiler files and previews', () => {
  it('recognises and toggles the SPOILER_ prefix', () => {
    expect(isSpoilerFileName('SPOILER_cat.png')).toBe(true)
    expect(isSpoilerFileName('spoiler_cat.png')).toBe(true)
    expect(isSpoilerFileName('cat.png')).toBe(false)
    expect(toggleSpoilerFileName('cat.png')).toBe('SPOILER_cat.png')
    expect(toggleSpoilerFileName('SPOILER_cat.png')).toBe('cat.png')
  })

  it('masks spoilers in plain-text previews', () => {
    expect(maskSpoilers('ending: ||he lives||')).toBe('ending: ▒▒▒▒▒▒▒▒')
    expect(maskSpoilers('||a||')).toBe('▒▒▒')
  })
})
