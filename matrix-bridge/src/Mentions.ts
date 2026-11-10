import { ghostOwner, type Config } from './config.js'
import type { BridgeMember } from './HarmonyClient.js'

type Part = Record<string, unknown>
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#\d{1,7}|#x[\da-fA-F]{1,6});/g, entity => {
    const names: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" }
    if (names[entity]) return names[entity]
    const n = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1))
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
  })
}
function plainHtml(value: string): string {
  return decodeHtml(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p\s*>\s*<p\b[^>]*>/gi, '\n\n').replace(/<[^>]*>/g, ''))
}
function nativeMention(member: BridgeMember): Part {
  return { type: 'mention', userId: member.id, username: member.username, domain: member.domain,
    isLocal: true, isBridged: false }
}

/** Only explicit annotations and validated matrix.to pills create notifications; never guessed names. */
export function matrixToHarmony(body: string, formatted: unknown, mentionIds: unknown, members: BridgeMember[], config: Config): Part[] {
  const eligible = new Map(members.map(member => [member.id, member]))
  const targets = new Map<string, BridgeMember>()
  if (Array.isArray(mentionIds) && mentionIds.length <= 100) {
    for (const id of mentionIds) {
      if (typeof id !== 'string') continue
      const owner = ghostOwner(config, id)
      if (owner && eligible.has(owner)) targets.set(id, eligible.get(owner)!)
    }
  }
  const command = /^!mention ([^\s]+) ([\s\S]+)$/.exec(body)
  if (command) {
    const matches = members.filter(member => member.username === command[1])
    if (matches.length === 1) return [nativeMention(matches[0]), { type: 'text', text: ` ${command[2]}` }]
  }
  if (!targets.size) return [{ type: 'text', text: body }]
  const parts: Part[] = []
  const used = new Set<string>()
  if (typeof formatted === 'string' && formatted.length <= 32_000) {
    // Parse only explicit anchors; no HTML, URL fetch or display-name replacement enters Harmony.
    const anchors = /<a\s+[^>]*href\s*=\s*["'](https:\/\/matrix\.to\/#\/[^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi
    let offset = 0
    let rendered = ''
    for (const match of formatted.matchAll(anchors)) {
      const before = plainHtml(formatted.slice(offset, match.index))
      const label = plainHtml(match[2])
      parts.push({ type: 'text', text: before })
      rendered += before + label
      let id = ''
      try { id = decodeURIComponent(decodeHtml(match[1]).slice('https://matrix.to/#/'.length).split('?')[0]) } catch { /* Invalid URI is plain text. */ }
      const target = targets.get(id)
      parts.push(target ? nativeMention(target) : { type: 'text', text: label })
      if (target) used.add(id)
      offset = match.index! + match[0].length
    }
    const after = plainHtml(formatted.slice(offset))
    parts.push({ type: 'text', text: after })
    rendered += after
    // Reject HTML/plaintext disagreement rather than changing the sender's text.
    if (rendered.trim() !== body.trim()) { parts.length = 0; used.clear() }
  }
  if (!parts.length) parts.push({ type: 'text', text: body })
  for (const [id, member] of targets) if (!used.has(id)) parts.push({ type: 'text', text: ' ' }, nativeMention(member))
  return parts.filter(part => part.type !== 'text' || part.text !== '')
}

export function harmonyToMatrix(parts: Part[] | undefined, body: string, targets: Map<string, string>, prefix = ''): { body: string; userIds: string[]; formattedBody?: string } {
  if (!parts?.length) return { body: prefix + body, userIds: [] }
  let plain = prefix
  let html = escapeHtml(prefix)
  const ids = new Set<string>()
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      plain += part.text
      html += escapeHtml(part.text).replace(/\n/g, '<br>')
    } else if (part.type === 'mention') {
      const label = `@${typeof part.username === 'string' ? part.username.slice(0, 100) : 'user'}`
      const id = typeof part.userId === 'string' && (!part.userId.startsWith('@') || (part.bridgeSource === 'matrix' && part.isBridged === true))
        ? targets.get(part.userId) : undefined
      plain += label
      if (id) {
        ids.add(id)
        html += `<a href="https://matrix.to/#/${encodeURIComponent(id)}">${escapeHtml(label)}</a>`
      } else html += escapeHtml(label)
    }
  }
  return { body: plain, userIds: [...ids], ...(ids.size ? { formattedBody: html } : {}) }
}
