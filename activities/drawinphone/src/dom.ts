/** Minimal DOM building. */

import type { NamePart } from '../../sdk'

type Child = Node | string | number | null | undefined | false
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    if (name.startsWith('on') && typeof value === 'function') {
      el.addEventListener(name.slice(2).toLowerCase(), value as EventListener)
    } else if (name === 'class') {
      el.className = String(value)
    } else if (name === 'testid') {
      el.dataset.testid = String(value)
    } else if (value === true) {
      el.setAttribute(name, '')
    } else {
      el.setAttribute(name, String(value))
    }
  }
  append(el, ...children)
  return el
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 24 x 24 stroke icon from path data. */
export function icon(paths: string[], size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

export const ICONS = {
  brush: ['M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08', 'M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z'],
  eraser: ['M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21', 'M22 21H7', 'M5 11l9 9'],
  fill: ['M19 11l-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11z', 'M5 2l5 5', 'M2 13h15', 'M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4z'],
  line: ['M5 19L19 5'],
  rect: ['M4 5h16v14H4z'],
  ellipse: ['M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z'],
  picker: ['M2 22l1-1h3l9-9', 'M3 21v-3l9-9', 'M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4z'],
  undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
  redo: ['M21 7v6h-6', 'M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  dice: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8 8h.01', 'M16 8h.01', 'M12 12h.01', 'M8 16h.01', 'M16 16h.01'],
  check: ['M20 6L9 17l-5-5'],
  crown: ['M2 18h20', 'M3 7l4.5 4L12 4l4.5 7L21 7l-2 11H5L3 7z'],
  star: ['M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z'],
  next: ['M5 12h14', 'M13 6l6 6-6 6'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  play: ['M6 4l14 8-14 8z'],
  pause: ['M7 4h3v16H7z', 'M14 4h3v16h-3z'],
  pencil: ['M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  replay: ['M1 4v6h6', 'M3.5 15a9 9 0 1 0 2.1-9.4L1 10'],
} as const

/** Stable hue for an id. */
export function hue(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return Math.abs(hash) % 360
}

export function avatar(name: string, id: string, src: string | null, size = 36): HTMLElement {
  const el = h('span', { class: 'avatar', style: `--size:${size}px;--hue:${hue(id)}`, 'aria-hidden': 'true' })
  if (src) el.appendChild(h('img', { src, alt: '', draggable: 'false' }))
  else el.textContent = (name.trim()[0] ?? '?').toUpperCase()
  return el
}

/** A display name: its text, and its custom emojis as images; one without an image reads :name:. */
export function nameNode(parts: NamePart[] | null | undefined, fallback: string): HTMLElement {
  const el = h('span', { class: 'name' })
  if (!parts?.length) {
    el.textContent = fallback
    return el
  }
  for (const part of parts) {
    if ('text' in part) el.appendChild(document.createTextNode(part.text))
    else if (part.src) el.appendChild(h('img', { class: 'name-emoji', src: part.src, alt: `:${part.emoji}:`, title: `:${part.emoji}:`, draggable: 'false' }))
    else el.appendChild(document.createTextNode(`:${part.emoji}:`))
  }
  return el
}

const SLOT = '\u0000'

/** `format(slot)` as nodes, `node` where the slot was; the text alone when the format drops it. */
export function withNode(format: (slot: string) => string, node: Node): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const pieces = format(SLOT).split(SLOT)
  append(fragment, pieces[0])
  for (const piece of pieces.slice(1)) append(fragment, node, piece)
  return fragment
}
