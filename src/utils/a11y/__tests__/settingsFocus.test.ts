import { describe, it, expect, afterEach } from 'vitest'
import { focusSectionHeading } from '../settingsFocus'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('focusSectionHeading', () => {
  it('focuses the first visible h2 and makes it programmatically focusable', async () => {
    document.body.innerHTML = `
      <div id="c">
        <h2 hidden>Hidden</h2>
        <section><h2 id="t">Appearance</h2><h3>Theme</h3><button>Dark</button></section>
      </div>`
    const ok = await focusSectionHeading(document.getElementById('c'))
    expect(ok).toBe(true)
    expect(document.activeElement?.id).toBe('t')
    expect(document.getElementById('t')?.getAttribute('tabindex')).toBe('-1')
  })

  it('waits for a heading that mounts after the section loads', async () => {
    document.body.innerHTML = '<div id="c"><p>Loading</p></div>'
    const container = document.getElementById('c')!
    const pending = focusSectionHeading(container)
    requestAnimationFrame(() => {
      container.innerHTML = '<h2 id="late">Roles</h2>'
    })
    expect(await pending).toBe(true)
    expect(document.activeElement?.id).toBe('late')
  })

  it('gives up without a heading', async () => {
    document.body.innerHTML = '<div id="c"><p>No heading</p></div>'
    expect(await focusSectionHeading(document.getElementById('c'))).toBe(false)
    expect(await focusSectionHeading(null)).toBe(false)
  })
})
