/**
 * Realtime in the self-host stack (supabase-overrides.yml) accepts the presence calls typing indicators
 * make. Realtime from v2.76 caps presence calls per client (CLIENT_PRESENCE_MAX_CALLS per
 * CLIENT_PRESENCE_WINDOW_MS, default 5 per 30 s); on v2.148.3 the sixth track within the window got no
 * reply and no later one reached the peer. TypingIndicatorService tracks on a burst and off after 3 s
 * idle: at most 20 calls in 30 s from one context.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const overrides = parse(readFileSync(join(resolve(__dirname, '../../self-host'), 'supabase-overrides.yml'), 'utf8'), { logLevel: 'error' }) as {
  services: Record<string, { environment?: Record<string, unknown> }>
}
const service = readFileSync(join(resolve(__dirname, '../../src/services'), 'TypingIndicatorService.ts'), 'utf8')

describe('supabase-overrides.yml realtime', () => {
  const env = overrides.services.realtime?.environment ?? {}

  it('allows more presence calls per 30 s than typing indicators make', () => {
    const idleMs = Number(/TYPING_TIMEOUT_MS = (\d+)/.exec(service)?.[1])
    expect(idleMs).toBeGreaterThan(0)
    const typingPer30s = 2 * Math.ceil(30_000 / idleMs)
    const calls = Number(env.CLIENT_PRESENCE_MAX_CALLS)
    const windowMs = Number(env.CLIENT_PRESENCE_WINDOW_MS)
    expect(windowMs).toBeGreaterThan(0)
    expect((calls * 30_000) / windowMs).toBeGreaterThanOrEqual(2 * typingPer30s)
  })

  it('sets the metrics secret v2.148 needs to boot', () => {
    expect(env.METRICS_JWT_SECRET).toBe('${JWT_SECRET}')
  })
})
