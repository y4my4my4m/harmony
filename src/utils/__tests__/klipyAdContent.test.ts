import { describe, expect, it } from 'vitest'
import { prepareKlipyAdHtml } from '../klipyAdContent'

describe('prepareKlipyAdHtml', () => {
  it('keeps Klipy .ad in the DOM but hides it visually', () => {
    const raw =
      '<div class="ad" style="display:none">AD</div><img src="x" style="opacity:0">'
    const html = prepareKlipyAdHtml(raw)
    expect(html).toContain('class="ad"')
    expect(html).toContain('.ad{opacity:0!important')
    expect(html).not.toContain('display:none!important')
  })

  it('adds a fallback script so img opacity is restored if Klipy loader fails', () => {
    const html = prepareKlipyAdHtml('<img src="x">')
    expect(html).toContain('harmony-klipy-ad-fallback')
    expect(html).toContain("img.style.opacity='1'")
  })
})
