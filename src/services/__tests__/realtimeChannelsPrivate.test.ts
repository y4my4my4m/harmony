import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// realtime-js keeps one channel per topic and the first config wins, and a
// public channel admits any anon-key holder to read and send. Every
// supabase.channel() site opens a private channel, except the ones below.

const SRC = join(__dirname, '..', '..')

// Opened public on purpose: postgres-changes channels are gated by table RLS.
const PUBLIC_SITES = new Map<string, string>([
  ['services/RealtimeConnectionManager.ts', 'postgres_changes subscriptions; broadcast ones pass private'],
])

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return /\.(ts|vue)$/.test(name) ? [path] : []
  })
}

/** Text of each `.channel(` call outside comments, up to its closing parenthesis. */
function channelCalls(text: string): string[] {
  const calls: string[] = []
  const re = /\.channel\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const line = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index).trim()
    if (line.startsWith('//') || line.startsWith('*')) continue
    let depth = 1
    let i = m.index + m[0].length
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') depth--
      i++
    }
    calls.push(text.slice(m.index, i))
  }
  return calls
}

describe('realtime channels', () => {
  it('every channel the client opens is private, except the listed public ones', () => {
    const publicSites: string[] = []
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file)
      for (const call of channelCalls(readFileSync(file, 'utf-8'))) {
        if (/private/.test(call)) continue
        const topic = call.match(/['`]([a-z-]+)[:'`$-]/)?.[1]
        publicSites.push(PUBLIC_SITES.has(rel) ? rel : `${rel}:${topic ?? call}`)
      }
    }
    expect([...new Set(publicSites)].sort()).toEqual([...PUBLIC_SITES.keys()].sort())
  })
})
