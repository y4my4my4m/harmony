/**
 * Port of the site's v-squish (src/components/os/squish.ts): letters near the
 * pointer widen through Bricolage's wdth axis and squash like pressed jelly.
 * Headings are split after hydration; server HTML keeps plain text.
 * Deviation: each letter's resting width is its parent's computed wdth instead
 * of one constant, and permalink anchors, code and badges stay unsplit.
 */

const TARGETS = '.vp-doc h1, .VPHero .heading'
const SKIP = '.header-anchor, code, .VPBadge'
const SIGMA = 85

interface State {
  el: HTMLElement
  letters: HTMLElement[]
  bases: number[]
  centers: { x: number; y: number }[]
  ro: ResizeObserver
}

const states = new Set<State>()
let px = -1e6
let py = -1e6
let pending = false
let listening = false

function measure(s: State) {
  s.centers = s.letters.map((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2 + window.scrollX, y: r.top + r.height / 2 + window.scrollY }
  })
}

function apply() {
  pending = false
  for (const s of states) {
    s.letters.forEach((el, i) => {
      const c = s.centers[i]
      if (!c) return
      const dx = px - c.x
      const dy = py - c.y
      const k = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA))
      el.style.setProperty('--k', k.toFixed(3))
      el.style.fontVariationSettings = `'wdth' ${Math.min(100, s.bases[i]! + 22 * k).toFixed(1)}`
    })
  }
}

function schedule() {
  if (!pending) {
    pending = true
    requestAnimationFrame(apply)
  }
}

function onMove(e: PointerEvent) {
  px = e.pageX
  py = e.pageY
  schedule()
}

function onLeave() {
  px = -1e6
  py = -1e6
  schedule()
}

function onResize() {
  states.forEach(measure)
}

function split(el: HTMLElement): { letters: HTMLElement[]; bases: number[]; label: string } {
  const letters: HTMLElement[] = []
  const bases: number[] = []
  const nodes: Text[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  const label = nodes.map((n) => n.textContent ?? '').join('').replace(/\s+/g, ' ').trim()
  for (const node of nodes) {
    const base = baseWidth(node.parentElement ?? el)
    const frag = document.createDocumentFragment()
    for (const part of (node.textContent ?? '').split(/(\s+)/)) {
      if (!part) continue
      if (/^\s+$/.test(part)) {
        frag.append(part)
        continue
      }
      const word = document.createElement('span')
      word.className = 'sq-w'
      for (const ch of part) {
        const l = document.createElement('span')
        l.className = 'sq-l'
        l.setAttribute('aria-hidden', 'true')
        l.textContent = ch
        word.append(l)
        letters.push(l)
        bases.push(base)
      }
      frag.append(word)
    }
    node.replaceWith(frag)
  }
  return { letters, bases, label }
}

function baseWidth(el: HTMLElement): number {
  const m = /['"]wdth['"]\s+([\d.]+)/.exec(getComputedStyle(el).fontVariationSettings)
  return m ? Number(m[1]) : 82
}

/** Splits headings that are new since the last call and drops detached ones. */
export function squish() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(pointer: coarse)').matches) return
  for (const s of states) {
    if (!s.el.isConnected) {
      s.ro.disconnect()
      states.delete(s)
    }
  }
  document.querySelectorAll<HTMLElement>(TARGETS).forEach((el) => {
    if (el.dataset.squish !== undefined) return
    el.dataset.squish = ''
    const { letters, bases, label } = split(el)
    if (!letters.length) return
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', label)
    const state: State = { el, letters, bases, centers: [], ro: new ResizeObserver(() => measure(state)) }
    state.ro.observe(el)
    states.add(state)
    measure(state)
    document.fonts?.ready.then(() => measure(state)).catch(() => {})
  })
  if (states.size && !listening) {
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    listening = true
  } else if (!states.size && listening) {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('resize', onResize)
    document.documentElement.removeEventListener('pointerleave', onLeave)
    listening = false
  }
}
