/**
 * Kong in the self-host stack (supabase-overrides.yml) re-resolves upstream names within seconds.
 * Without KONG_DNS_VALID_TTL it keeps an address for the TTL of Docker's DNS answer (600 s): after
 * an update recreated auth on another address, Kong answered 502 to /auth/v1/* for 6 min 42 s while
 * auth was healthy.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const overrides = parse(readFileSync(join(resolve(__dirname, '../../self-host'), 'supabase-overrides.yml'), 'utf8'), { logLevel: 'error' }) as {
  services: Record<string, { environment?: Record<string, unknown> }>
}

describe('supabase-overrides.yml kong', () => {
  it('bounds the DNS cache to seconds', () => {
    const ttl = Number(overrides.services.kong?.environment?.KONG_DNS_VALID_TTL)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(30)
  })
})
