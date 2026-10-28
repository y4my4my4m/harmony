/**
 * Terms of the on-device index of encrypted messages (services/search/encryptedSearchIndex.ts)
 * and matching against decrypted text.
 *
 * Text is NFKC-normalized and lower-cased; Latin, Greek and Cyrillic letters lose their
 * diacritics (é -> e). Runs of Han, Hiragana, Katakana and Hangul index as character unigrams
 * and bigrams, as Lucene's CJKAnalyzer; a query run of two or more characters looks up its
 * bigrams. Every other run of letters, digits and marks is a word and indexes as each prefix of
 * 2..PREFIX_MAX characters; a one-character word indexes as itself. Terms are 'w:<prefix>' and
 * 'c:<gram>'.
 *
 * Index terms only select candidates. matchesQuery decides on the decrypted text: a word matches
 * the prefix of a word, a CJK run and a quoted phrase match as substrings.
 */

import type { MessagePart } from '@/types'
import { shownLinkLabel } from '@/utils/maskedLinks'

/** Longest indexed prefix. A longer query word looks up its first PREFIX_MAX characters. */
export const PREFIX_MAX = 16

/** Han (with 々 〆), Hiragana, Katakana with the long vowel mark, Hangul. */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー々〆]/u
const RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー々〆]+|[\p{L}\p{N}\p{M}]+/gu
const FOLDED_SCRIPT = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u

/** NFKC, lower case, diacritics off Latin/Greek/Cyrillic letters. Kana voicing marks stay. */
export function normalizeSearchText(text: string): string {
  const lowered = text.normalize('NFKC').toLowerCase()
  if (!FOLDED_SCRIPT.test(lowered)) return lowered
  return lowered.replace(/[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]\p{M}*/gu, ch =>
    ch.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC'))
}

export interface TextRun {
  text: string
  cjk: boolean
}

/** Word and CJK runs of normalized text, in order. */
export function textRuns(normalized: string): TextRun[] {
  const out: TextRun[] = []
  for (const m of normalized.matchAll(RUN)) out.push({ text: m[0], cjk: CJK_CHAR.test(m[0][0]) })
  return out
}

function chars(text: string): string[] {
  return Array.from(text)
}

/** Index terms of one message's text. */
export function indexTerms(text: string): Set<string> {
  const terms = new Set<string>()
  for (const run of textRuns(normalizeSearchText(text))) {
    const cs = chars(run.text)
    if (run.cjk) {
      for (let i = 0; i < cs.length; i++) {
        terms.add(`c:${cs[i]}`)
        if (i + 1 < cs.length) terms.add(`c:${cs[i]}${cs[i + 1]}`)
      }
      continue
    }
    if (cs.length === 1) {
      terms.add(`w:${cs[0]}`)
      continue
    }
    const top = Math.min(cs.length, PREFIX_MAX)
    for (let n = 2; n <= top; n++) terms.add(`w:${cs.slice(0, n).join('')}`)
  }
  return terms
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface QueryTerm {
  kind: 'word' | 'cjk' | 'phrase'
  /** Normalized; a phrase has its whitespace collapsed to one space. */
  value: string
  /** Index terms the candidates must all hold. Empty for a phrase without letters. */
  lookup: string[]
}

export interface QueryAlternative {
  terms: QueryTerm[]
  exclude: QueryTerm[]
}

export interface IndexQuery {
  /** Any alternative matches. Empty when the text holds no searchable term. */
  alternatives: QueryAlternative[]
}

function runLookup(run: TextRun): string[] {
  const cs = chars(run.text)
  if (run.cjk) {
    if (cs.length === 1) return [`c:${cs[0]}`]
    const grams: string[] = []
    for (let i = 0; i + 1 < cs.length; i++) grams.push(`c:${cs[i]}${cs[i + 1]}`)
    return [...new Set(grams)]
  }
  return [`w:${cs.slice(0, Math.min(cs.length, PREFIX_MAX)).join('')}`]
}

function termsOf(raw: string): QueryTerm[] {
  return textRuns(normalizeSearchText(raw)).map(run => ({
    kind: run.cjk ? 'cjk' as const : 'word' as const,
    value: run.text,
    lookup: runLookup(run),
  }))
}

function phraseOf(raw: string): QueryTerm | null {
  const value = normalizeSearchText(raw).replace(/\s+/g, ' ').trim()
  if (!value) return null
  const lookup = [...new Set(textRuns(value).flatMap(runLookup))]
  return lookup.length ? { kind: 'phrase', value, lookup } : null
}

/**
 * Free text in websearch_to_tsquery's grammar: words, "quoted phrases", -excluded words or
 * phrases, and `or` between alternatives.
 */
export function parseIndexQuery(text: string): IndexQuery {
  const alternatives: QueryAlternative[] = []
  let current: QueryAlternative = { terms: [], exclude: [] }
  const close = () => {
    if (current.terms.length) alternatives.push(current)
    current = { terms: [], exclude: [] }
  }
  const re = /(-?)"([^"]*)"?|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[3] !== undefined) {
      const word = m[3]
      if (word.toLowerCase() === 'or') {
        close()
        continue
      }
      const negated = word.startsWith('-') && word.length > 1
      const terms = termsOf(negated ? word.slice(1) : word)
      ;(negated ? current.exclude : current.terms).push(...terms)
      continue
    }
    const phrase = phraseOf(m[2])
    if (!phrase) continue
    const single = textRuns(phrase.value)
    // A one-run phrase is that word or CJK run.
    const term = single.length === 1 && single[0].text === phrase.value
      ? { kind: single[0].cjk ? 'cjk' as const : 'word' as const, value: phrase.value, lookup: phrase.lookup }
      : phrase
    ;(m[1] ? current.exclude : current.terms).push(term)
  }
  close()
  return { alternatives }
}

// ---------------------------------------------------------------------------
// Matching decrypted text
// ---------------------------------------------------------------------------

/** Normalized text and its word runs, built once per message. */
export interface PreparedText {
  normalized: string
  words: string[]
}

export function prepareText(text: string): PreparedText {
  const normalized = normalizeSearchText(text).replace(/\s+/g, ' ')
  return { normalized, words: textRuns(normalized).filter(r => !r.cjk).map(r => r.text) }
}

function termMatches(term: QueryTerm, text: PreparedText): boolean {
  switch (term.kind) {
    case 'word':
      return chars(term.value).length === 1
        ? text.words.includes(term.value)
        : text.words.some(w => w.startsWith(term.value))
    case 'cjk':
    case 'phrase':
      return text.normalized.includes(term.value)
  }
}

/** Matching terms of the first matching alternative; 0 when none matches. */
export function matchScore(query: IndexQuery, text: PreparedText): number {
  for (const alt of query.alternatives) {
    if (alt.exclude.some(t => termMatches(t, text))) continue
    if (alt.terms.every(t => termMatches(t, text))) return alt.terms.length
  }
  return 0
}

export function matchesQuery(query: IndexQuery, text: string): boolean {
  return matchScore(query, prepareText(text)) > 0
}

// ---------------------------------------------------------------------------
// Searchable text of a message
// ---------------------------------------------------------------------------

/** What search reads of message parts: text, names of mentions, links, emoji, files, stickers, polls. */
export function searchableText(content: MessagePart[] | null | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text || ''
        case 'mention':
          return [part.username, part.displayName].filter(Boolean).join(' ')
        case 'url':
          return [shownLinkLabel(part), part.url].filter(Boolean).join(' ')
        case 'emoji':
          return part.emoji?.name ? `:${part.emoji.name}:` : ''
        case 'hashtag':
          return part.name ? `#${part.name}` : ''
        case 'channel_mention':
          return part.name ? `#${part.name}` : ''
        case 'file':
          return [part.fileName, part.altText].filter(Boolean).join(' ')
        case 'sticker':
          return [part.name, part.description].filter(Boolean).join(' ')
        case 'poll':
          return [part.question, ...(part.options ?? [])].filter(Boolean).join(' ')
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join(' ')
}
