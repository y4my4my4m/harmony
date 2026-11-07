/**
 * imgproxy in the self-host stack (supabase-overrides.yml). v4 reads IMGPROXY_AUTO_WEBP, not the
 * IMGPROXY_ENABLE_WEBP_DETECTION name the pinned stack sets. From v3.12 a source format outside
 * IMGPROXY_PREFERRED_FORMATS is re-encoded for a client that does not take WebP: on v4.0.21 a WebP
 * became JPEG and an animated WebP became GIF.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const overrides = parse(readFileSync(join(resolve(__dirname, '../../self-host'), 'supabase-overrides.yml'), 'utf8'), { logLevel: 'error' }) as {
  services: Record<string, { image?: string; environment?: Record<string, unknown> }>
}

describe('supabase-overrides.yml imgproxy', () => {
  const svc = overrides.services.imgproxy ?? {}
  const env = svc.environment ?? {}

  it('maps the stack\'s WebP setting to the name v4 reads', () => {
    expect(svc.image).toMatch(/^darthsim\/imgproxy:v4\./)
    expect(env.IMGPROXY_AUTO_WEBP).toBe('${IMGPROXY_ENABLE_WEBP_DETECTION:-true}')
  })

  it('keeps WebP and AVIF sources in their own format', () => {
    const formats = String(env.IMGPROXY_PREFERRED_FORMATS ?? '').split(',')
    for (const f of ['jpeg', 'png', 'gif', 'webp', 'avif']) expect(formats).toContain(f)
  })
})
