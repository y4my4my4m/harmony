import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { landmarkRegions, moveToRegion, useRegionNavigation } from '../useRegionNavigation'
import { pushLayer, resetLayersForTests } from '@/utils/a11y/layers'

enableAutoUnmount(afterEach)

beforeEach(() => {
  resetLayersForTests()
  document.body.innerHTML = `
    <nav id="servers" aria-label="Servers"><button id="s1">One</button><button id="s2" aria-current="page">Two</button></nav>
    <div>
      <header id="banner">Server</header>
      <nav id="channels" aria-label="Channels"><button>general</button></nav>
      <main id="main"><section aria-label="Nested"><h1>Chat</h1></section></main>
      <aside id="members" aria-label="Members" inert></aside>
    </div>
    <section id="voice" aria-label="Voice connection"><button>Mute</button></section>
    <div role="dialog"><nav aria-label="In dialog"></nav></div>`
})

function f6(shift = false) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', shiftKey: shift, bubbles: true, cancelable: true }))
}

describe('region navigation', () => {
  it('lists visible top-level landmarks in document order', () => {
    expect(landmarkRegions().map((el) => el.id)).toEqual(['servers', 'banner', 'channels', 'main', 'voice'])
  })

  it('F6 and Shift+F6 cycle regions, landing on the current item where there is one', () => {
    mount(defineComponent({ setup() { useRegionNavigation(); return () => h('div') } }), { attachTo: document.body })
    f6()
    expect(document.activeElement?.id).toBe('s2')
    f6()
    expect(document.activeElement?.id).toBe('banner')
    f6()
    f6()
    expect(document.activeElement?.id).toBe('main')
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1')
    f6()
    expect(document.activeElement?.id).toBe('voice')
    f6()
    expect(document.activeElement?.id).toBe('s2')
    f6(true)
    expect(document.activeElement?.id).toBe('voice')
  })

  it('does nothing while a dialog is open', () => {
    mount(defineComponent({ setup() { useRegionNavigation(); return () => h('div') } }), { attachTo: document.body })
    const remove = pushLayer({ kind: 'dialog', element: () => document.querySelector('[role="dialog"]'), onEscape: () => {} })
    ;(document.getElementById('s1') as HTMLElement).focus()
    f6()
    expect(document.activeElement?.id).toBe('s1')
    remove()
  })

  it('moveToRegion reports when there is nowhere to go', () => {
    document.body.innerHTML = '<div></div>'
    expect(moveToRegion(1)).toBe(false)
  })
})
