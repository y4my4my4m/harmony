/**
 * Plain text of the composer's contenteditable DOM, and the map between DOM points and
 * offsets in that text. One walk produces both, so a caret or selection read from the DOM
 * names the character it sits before in the text the editor sends, and an offset in that
 * text lands on the matching DOM point.
 *
 * Lines follow the rendering: a <br> ends a line, except a <br> that closes its block after
 * a line break or in an empty block, which only holds an empty last line open (browsers
 * insert one after Shift+Enter at the end of a block; renderContent appends one to an empty
 * last line). A browser-made <div> or <p> is a line of its own. A blockquote ends its last
 * line, and a fenced block the line of its closing fence when data-line-after is set: no
 * <br> follows either.
 *
 * Text the walk adds without a DOM node of its own ("virtual" characters):
 *   - "\n" around a browser-made <div> or <p>, and after a block that ends its line;
 *   - "\n" between the lines of a blockquote;
 *   - "\n" after an opening fence and before a closing one, when the typed text had them
 *     (data-open-newline, data-close-newline on .editor-codeblock-wrapper);
 *   - " " between a mention pill and an adjacent word, which would otherwise join the
 *     handle (mentionGrammar).
 * An emoji pill reads as `:name:`, a mention pill as its display text.
 *
 * "slot" units hold no text: an empty line's container, or a closing placeholder <br>.
 * They give an empty line a DOM point for the caret.
 */

import { continuesHandle } from '@/utils/mentionGrammar'

export type EditorUnit =
  | { kind: 'text'; node: Text; start: number; length: number }
  | { kind: 'atom'; node: HTMLElement; start: number; length: number }
  | { kind: 'slot'; node: HTMLElement; start: number; length: 0 }
  | { kind: 'virtual'; start: number; length: number }

export interface EditorText {
  text: string
  units: EditorUnit[]
  /** Text offset where the walk entered and left each visited node. */
  enter: Map<Node, number>
  leave: Map<Node, number>
}

function isAtom(el: HTMLElement): boolean {
  return el.classList.contains('editor-emoji') || el.classList.contains('editor-mention')
}

function atomText(el: HTMLElement): string {
  if (el.classList.contains('editor-emoji')) {
    const name = el.getAttribute('data-emoji')
    return name ? `:${name}:` : ''
  }
  return el.getAttribute('data-display-text') || el.textContent || ''
}

const LINE_CONTAINERS = ['editor-blockquote-line', 'editor-codeblock-content', 'editor-codeblock-start', 'editor-codeblock-end']

/** A block holding lines: the editor root, a browser-made <div>/<p>, or a line of the editor's blocks. */
function isLineBlock(node: Node, root: HTMLElement): boolean {
  if (node === root) return true
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as HTMLElement
  return el.tagName === 'DIV' || el.tagName === 'P' || LINE_CONTAINERS.some((c) => el.classList.contains(c))
}

/** Nothing renders after `node` up to the end of its line block. */
function endsItsBlock(node: Node, root: HTMLElement): boolean {
  let n: Node = node
  for (;;) {
    for (let sib = n.nextSibling; sib; sib = sib.nextSibling) {
      if (sib.nodeType === Node.ELEMENT_NODE) return false
      if (sib.nodeType === Node.TEXT_NODE && (sib as Text).data) return false
    }
    const parent = n.parentNode
    if (!parent || isLineBlock(parent, root)) return true
    n = parent
  }
}

/** The editor's text and its position map. */
export function linearize(root: HTMLElement): EditorText {
  let text = ''
  const units: EditorUnit[] = []
  const enter = new Map<Node, number>()
  const leave = new Map<Node, number>()
  let lastWasMention = false
  // A browser-made block ended its line; the next content starts a new one.
  let lineEnded = false
  // Text offset where each enclosing line block began.
  const blockStarts: number[] = [0]

  const addVirtual = (chars: string) => {
    units.push({ kind: 'virtual', start: text.length, length: chars.length })
    text += chars
  }
  const breakPendingLine = () => {
    if (lineEnded) {
      addVirtual('\n')
      lineEnded = false
    }
  }
  const slot = (el: HTMLElement) => units.push({ kind: 'slot', node: el, start: text.length, length: 0 })
  const visitChildren = (el: HTMLElement) => {
    for (const child of Array.from(el.childNodes)) visit(child)
  }
  const visitLineBlock = (el: HTMLElement) => {
    blockStarts.push(text.length)
    const before = text.length
    visitChildren(el)
    if (text.length === before && !units.some((u) => u.kind === 'slot' && u.start === before && el.contains(u.node))) slot(el)
    blockStarts.pop()
  }

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const content = (node as Text).data
      // Browsers leave empty text nodes beside a non-editable pill; one separates nothing.
      if (content) {
        breakPendingLine()
        if (lastWasMention && continuesHandle(content)) addVirtual(' ')
        lastWasMention = false
        enter.set(node, text.length)
        units.push({ kind: 'text', node: node as Text, start: text.length, length: content.length })
        text += content
      } else {
        enter.set(node, text.length)
      }
      leave.set(node, text.length)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement

    if (isAtom(el)) {
      breakPendingLine()
      const isMention = el.classList.contains('editor-mention')
      // A letter, digit, "_", "@" or "/" directly before the "@" voids the handle.
      if (isMention && /[\p{L}\p{N}_@/]$/u.test(text)) addVirtual(' ')
      enter.set(el, text.length)
      const value = atomText(el)
      units.push({ kind: 'atom', node: el, start: text.length, length: value.length })
      text += value
      lastWasMention = isMention
    } else if (el.tagName === 'BR') {
      breakPendingLine()
      lastWasMention = false
      enter.set(el, text.length)
      const blockStart = blockStarts[blockStarts.length - 1]
      if (endsItsBlock(el, root) && (text.length === blockStart || text.endsWith('\n'))) {
        slot(el)
      } else {
        units.push({ kind: 'atom', node: el, start: text.length, length: 1 })
        text += '\n'
      }
    } else if (el.classList.contains('editor-blockquote')) {
      breakPendingLine()
      lastWasMention = false
      enter.set(el, text.length)
      let line = 0
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).classList.contains('editor-blockquote-line')) {
          if (line > 0) addVirtual('\n')
          line++
          enter.set(child, text.length)
          visitLineBlock(child as HTMLElement)
          leave.set(child, text.length)
        } else {
          visit(child)
        }
      }
      leave.set(el, text.length)
      lineEnded = true
      return
    } else if (el.classList.contains('editor-codeblock-wrapper')) {
      breakPendingLine()
      lastWasMention = false
      enter.set(el, text.length)
      for (const child of Array.from(el.childNodes)) {
        const part = child.nodeType === Node.ELEMENT_NODE ? (child as HTMLElement) : null
        if (part?.classList.contains('editor-codeblock-content')) {
          if (el.getAttribute('data-open-newline') === '1') addVirtual('\n')
          enter.set(part, text.length)
          visitLineBlock(part)
          if (el.getAttribute('data-close-newline') === '1') addVirtual('\n')
          leave.set(part, text.length)
        } else if (part?.classList.contains('editor-codeblock-start') || part?.classList.contains('editor-codeblock-end')) {
          enter.set(part, text.length)
          visitLineBlock(part)
          leave.set(part, text.length)
        } else {
          visit(child)
        }
      }
      leave.set(el, text.length)
      lineEnded = el.getAttribute('data-line-after') === '1'
      return
    } else if (el.tagName === 'DIV' || el.tagName === 'P') {
      lastWasMention = false
      if (lineEnded) breakPendingLine()
      else if (text.length > 0 && !text.endsWith('\n')) addVirtual('\n')
      enter.set(el, text.length)
      visitLineBlock(el)
      lineEnded = true
    } else {
      enter.set(el, text.length)
      visitChildren(el)
    }
    leave.set(el, text.length)
  }

  for (const child of Array.from(root.childNodes)) visit(child)
  enter.set(root, 0)
  leave.set(root, text.length)
  return { text, units, enter, leave }
}

/** The text the editor sends: no-break spaces as spaces, whitespace alone as empty. */
export function plainTextOf(lin: EditorText): string {
  const text = lin.text.replace(/\u00a0/g, ' ')
  return text.trim().length === 0 ? '' : text
}

/** Text offset of a DOM point inside `root`. */
export function offsetForPoint(lin: EditorText, root: HTMLElement, container: Node, offset: number): number {
  if (!root.contains(container)) return 0
  if (container.nodeType === Node.TEXT_NODE) {
    const unit = lin.units.find((u) => u.kind === 'text' && u.node === container)
    if (unit) return unit.start + Math.min(offset, unit.length)
    // Inside a pill: before or after it.
    let el: Node | null = container.parentNode
    while (el && el !== root) {
      const atom = lin.units.find((u) => u.kind === 'atom' && u.node === el)
      if (atom) return offset > 0 ? atom.start + atom.length : atom.start
      el = el.parentNode
    }
    return lin.enter.get(container) ?? 0
  }
  const atom = lin.units.find((u) => u.kind === 'atom' && u.node === container && (container as HTMLElement).tagName !== 'BR')
  if (atom) return offset > 0 ? atom.start + atom.length : atom.start
  const children = container.childNodes
  if (offset < children.length) return lin.enter.get(children[offset]) ?? 0
  return lin.leave.get(container) ?? lin.text.length
}

/**
 * DOM point of text offset `position`. In order of preference: a text node holding it (the
 * earlier one at a boundary), an empty line's slot, the end of a pill or line break before
 * it, the start of one after it; the start of an empty editor.
 */
export function pointForOffset(lin: EditorText, root: HTMLElement, position: number): { node: Node; offset: number } {
  const target = Math.max(0, Math.min(position, lin.text.length))
  const indexIn = (node: Node) => Array.prototype.indexOf.call(node.parentNode!.childNodes, node)

  for (const u of lin.units) {
    if (u.kind === 'text' && u.start <= target && target <= u.start + u.length) return { node: u.node, offset: target - u.start }
  }
  for (let i = lin.units.length - 1; i >= 0; i--) {
    const u = lin.units[i]
    if (u.kind === 'slot' && u.start === target) {
      return u.node.tagName === 'BR' ? { node: u.node.parentNode!, offset: indexIn(u.node) } : { node: u.node, offset: 0 }
    }
  }
  for (const u of lin.units) {
    if (u.kind === 'atom' && u.start + u.length === target) return { node: u.node.parentNode!, offset: indexIn(u.node) + 1 }
  }
  for (const u of lin.units) {
    if (u.kind === 'atom' && u.start === target) return { node: u.node.parentNode!, offset: indexIn(u.node) }
  }
  // Inside a pill, or on a virtual character: the nearest point before it.
  for (let i = lin.units.length - 1; i >= 0; i--) {
    const u = lin.units[i]
    if (u.kind === 'virtual' || u.start > target) continue
    if (u.kind === 'text') return { node: u.node, offset: Math.min(u.length, target - u.start) }
    if (u.kind === 'atom') return { node: u.node.parentNode!, offset: indexIn(u.node) + 1 }
    return u.node.tagName === 'BR' ? { node: u.node.parentNode!, offset: indexIn(u.node) } : { node: u.node, offset: 0 }
  }
  return { node: root, offset: 0 }
}
