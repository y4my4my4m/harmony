/**
 * Marks search terms in rendered message content through the CSS Custom Highlight API
 * (`::highlight(search-match)`): ranges over the existing text nodes, no DOM change under
 * Vue-rendered content. Without the API nothing is marked.
 *
 * Matching follows search_messages: case, accents and character width fold (search_fold:
 * NFKC, unaccent, lower); a latin term matches at the start of a word, a one-letter one as a
 * whole word; a CJK term matches anywhere. Stems and typo matches are not marked.
 */

export const SEARCH_HIGHLIGHT = 'search-match'

const CJK = /[々〆ぁ-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u
const WORD_CHAR = /[\p{L}\p{N}]/u
const STRIPPED_SCRIPTS = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u
// unaccent.rules letters that do not decompose under NFD.
const UNACCENT_EXTRA: Record<string, string> = {
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', ł: 'l', ħ: 'h', ı: 'i', þ: 'th',
}

function foldChar(ch: string): string {
  const nfkc = ch.normalize('NFKC')
  const base = STRIPPED_SCRIPTS.test(nfkc) ? nfkc.normalize('NFD').replace(/\p{M}/gu, '') : nfkc
  return Array.from(base.toLowerCase(), c => UNACCENT_EXTRA[c] ?? c).join('')
}

/** The folded text and, per folded UTF-16 unit, the source range it came from. */
export function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let at = 0
  for (const ch of text) {
    const f = foldChar(ch)
    // A half-width voiced mark (ﾞ ﾟ) folds to a combining mark; NFKC of the pair is one kana.
    if (/^\p{M}$/u.test(f) && folded) {
      const prev = folded[folded.length - 1]
      const composed = (prev + f).normalize('NFC')
      if (composed.length === 1) {
        folded = folded.slice(0, -1) + composed
        ends[ends.length - 1] = at + ch.length
        at += ch.length
        continue
      }
    }
    for (let i = 0; i < f.length; i++) {
      starts.push(at)
      ends.push(at + ch.length)
    }
    folded += f
    at += ch.length
  }
  return { folded, starts, ends }
}

export function foldTerm(term: string): string {
  return Array.from(term, foldChar).join('')
}

/** Source [start, end) ranges of every term in `text`, sorted and merged. */
export function findMatches(text: string, terms: readonly string[]): Array<[number, number]> {
  const { folded, starts, ends } = foldWithMap(text)
  const found: Array<[number, number]> = []
  for (const raw of terms) {
    const term = foldTerm(raw)
    if (!term) continue
    const anywhere = CJK.test(term)
    const whole = !anywhere && Array.from(term).length < 2
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
      const end = at + term.length
      if (!anywhere && at > 0 && WORD_CHAR.test(folded[at - 1])) continue
      if (whole && end < folded.length && WORD_CHAR.test(folded[end])) continue
      found.push([starts[at], ends[end - 1]])
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = []
  for (const r of found) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

interface HighlightLike {
  add(range: AbstractRange): unknown
  delete(range: AbstractRange): boolean
}
interface HighlightRegistryLike {
  get(name: string): HighlightLike | undefined
  set(name: string, highlight: HighlightLike): unknown
}

// lib.dom of TypeScript 5.3 has neither CSS.highlights nor Highlight.
function sharedHighlight(): HighlightLike | null {
  const g = globalThis as { CSS?: { highlights?: HighlightRegistryLike }; Highlight?: new () => HighlightLike }
  const registry = g.CSS?.highlights
  if (!registry || !g.Highlight) return null
  let highlight = registry.get(SEARCH_HIGHLIGHT)
  if (!highlight) {
    highlight = new g.Highlight()
    registry.set(SEARCH_HIGHLIGHT, highlight)
  }
  return highlight
}

/** Adds the ranges of `terms` under `root` to the shared highlight; returns their removal. */
export function highlightSearchMatches(root: Node, terms: readonly string[]): () => void {
  const highlight = terms.length ? sharedHighlight() : null
  if (!highlight) return () => {}
  const doc = root.ownerDocument ?? document
  const ranges: Range[] = []
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const [start, end] of findMatches(node.nodeValue ?? '', terms)) {
      const range = doc.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      highlight.add(range)
      ranges.push(range)
    }
  }
  return () => {
    for (const range of ranges) highlight.delete(range)
  }
}
