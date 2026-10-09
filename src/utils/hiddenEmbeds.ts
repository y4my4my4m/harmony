/**
 * Embeds the viewer hid ("Hide" on an embed header), per device. Keyed by message id and
 * embed url; the newest MAX entries are kept.
 */

const KEY = 'harmony.hiddenEmbeds'
const MAX = 500

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

function write(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)))
  } catch {
    /* storage blocked or full: the choice lasts while the row is mounted */
  }
}

const entry = (messageId: string, url: string) => `${messageId}|${url}`

export function isEmbedHidden(messageId: string | undefined, url: string | undefined): boolean {
  if (!messageId || !url) return false
  return read().includes(entry(messageId, url))
}

export function setEmbedHidden(messageId: string | undefined, url: string | undefined, hidden: boolean): void {
  if (!messageId || !url) return
  const key = entry(messageId, url)
  const list = read().filter((k) => k !== key)
  if (hidden) list.push(key)
  write(list)
}
