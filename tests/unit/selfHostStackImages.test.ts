/**
 * Images of the self-host stack. kong:2.8.4 and 2.8.5 publish amd64 only, which stopped install and
 * update on arm64 at the pull. kong:3.9.4 has no /home/kong: the stack's own entrypoint exits with
 * "/home/kong/kong.yml: Permission denied". Boot and routes: scripts/check-self-host-stack.sh.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(__dirname, '../..')
const composeOf = (file: string) => parse(readFileSync(join(root, file), 'utf8'), { logLevel: 'error' }) as {
  services: Record<string, { image?: string; entrypoint?: string; environment?: Record<string, unknown> }>
}
const overrides = composeOf('self-host/supabase-overrides.yml')
const postgrestOf = (image: string | undefined) => /postgrest\/postgrest:v[0-9.]+/.exec(image ?? '')?.[0]

describe('supabase-overrides.yml kong', () => {
  const kong = overrides.services.kong

  it('runs no amd64-only release', () => {
    expect(kong?.image).not.toMatch(/^kong:2\.8\.[45]/)
  })

  it('logs access in the combined format vector.yml parses', () => {
    expect(String(kong?.environment?.KONG_PROXY_ACCESS_LOG)).toMatch(/ combined$/)
  })

  it('renders its config to the path Kong reads, outside /home/kong', () => {
    const path = String(kong?.environment?.KONG_DECLARATIVE_CONFIG)
    expect(path).not.toMatch(/^\/home\/kong\//)
    expect(kong?.entrypoint).toContain(`> ${path} `)
  })
})

describe('PostgREST', () => {
  const selfHost = postgrestOf(overrides.services.rest?.image)

  it('is the version the E2E and federation stacks test', () => {
    expect(selfHost).toBeDefined()
    expect(postgrestOf(composeOf('e2e/docker-compose.yml').services.rest?.image)).toBe(selfHost)
    const federation = readFileSync(join(root, 'e2e/federation/docker-compose.yml'), 'utf8')
    expect(postgrestOf(federation)).toBe(selfHost)
  })
})

describe('supabase-overrides.yml vector', () => {
  const file = readFileSync(join(root, 'self-host/supabase-overrides.yml'), 'utf8')

  it('mounts its own config, which Vector 0.53 compiles', () => {
    expect(file).toContain('../vector.yml:/etc/vector/vector.yml:ro,z')
    expect(readFileSync(join(root, 'self-host/vector.yml'), 'utf8')).not.toContain('to_timestamp!')
  })
})

describe('images E2E shares with the self-host stack', () => {
  const e2e = composeOf('e2e/docker-compose.yml').services
  const tag = (image: string | undefined) => /[a-z][\w.-]*\/[\w.-]+:[\w.-]+/.exec(image ?? '')?.[0]

  it('runs the storage and imgproxy self-host instances run', () => {
    expect(tag(e2e.storage?.image)).toBe(tag(overrides.services.storage?.image))
    expect(tag(e2e.imgproxy?.image)).toBe(tag(overrides.services.imgproxy?.image))
  })

  it('keeps configure.sh floors equal to the image defaults', () => {
    const configure = readFileSync(join(root, 'self-host/configure.sh'), 'utf8')
    const floor = (name: string) => new RegExp(`^${name}=(.+)$`, 'm').exec(configure)?.[1]
    expect(overrides.services.storage?.image).toContain(`storage-api:v${floor('STORAGE_MIN')}`)
    expect(overrides.services.realtime?.image).toContain(`realtime:v${floor('REALTIME_MIN')}`)
    expect(overrides.services.auth?.image).toContain(`gotrue:v${floor('GOTRUE_MIN')}`)
  })
})

describe('configure.sh and a short JWT secret', () => {
  const selfHost = join(root, 'self-host')
  const ref = /^SUPABASE_REF_DEFAULT=(.+)$/m.exec(readFileSync(join(selfHost, 'configure.sh'), 'utf8'))?.[1] ?? ''
  const HELD_BACK = 'postgrest/postgrest:v12.2.12'
  let dir: string
  let sbEnv: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmony-jwt-length-'))
    const sb = join(dir, 'self-host', 'supabase')
    mkdirSync(sb, { recursive: true })
    mkdirSync(join(dir, 'bin'))
    mkdirSync(join(dir, 'webrtc'))
    for (const f of ['configure.sh', 'linking.sh', 'modes.sh']) copyFileSync(join(selfHost, f), join(dir, 'self-host', f))
    copyFileSync(join(root, 'webrtc', 'livekit.yaml.example'), join(dir, 'webrtc', 'livekit.yaml.example'))
    writeFileSync(join(dir, 'bin', 'docker'), '#!/usr/bin/env bash\n[ "$*" != "compose version --short" ] || echo 2.30.0\n')
    chmodSync(join(dir, 'bin', 'docker'), 0o755)
    writeFileSync(join(sb, 'docker-compose.yml'), 'services:\n  auth:\n    image: supabase/gotrue:v2.196.0\n')
    writeFileSync(join(sb, '.env.example'), 'ENABLE_EMAIL_AUTOCONFIRM=false\n')
    writeFileSync(join(sb, '.harmony-supabase-ref'), `${ref}\n`)
    sbEnv = join(sb, '.env')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const configure = () => spawnSync('bash', [join(dir, 'self-host', 'configure.sh'), '--non-interactive'], {
    cwd: dir,
    encoding: 'utf8',
    input: '',
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      HARMONY_DOMAIN: 'chat.test',
      HARMONY_ADMIN_EMAIL: 'admin@chat.test',
      HARMONY_TLS: 'internal',
      HARMONY_VOICE: 'n',
      HARMONY_BOTS: 'n',
      HARMONY_REGISTRATION: 'open',
    },
  })
  const image = () => /^POSTGREST_IMAGE=(.*)$/m.exec(readFileSync(sbEnv, 'utf8'))?.[1]
  const withSecret = (length: number, extra = '') =>
    writeFileSync(sbEnv, `JWT_SECRET=${'s'.repeat(length)}\nPOSTGRES_PASSWORD=pw\n${extra}`)

  it('sets nothing on a new install', () => {
    expect(configure().status).toBe(0)
    expect(image()).toBeUndefined()
  })

  it('keeps the older PostgREST below 32 characters', () => {
    withSecret(31)
    const r = configure()
    expect(r.status).toBe(0)
    expect(image()).toBe(HELD_BACK)
    expect(r.stderr).toContain('JWT_SECRET has 31 characters')
  })

  it('sets nothing at 32 characters', () => {
    withSecret(32)
    expect(configure().status).toBe(0)
    expect(image()).toBeUndefined()
  })

  it('removes the older PostgREST once the secret is long enough', () => {
    withSecret(48, `POSTGREST_IMAGE=${HELD_BACK}\n`)
    expect(configure().status).toBe(0)
    expect(image()).toBeUndefined()
  })
})

describe('check-self-host-stack.sh --platforms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-platforms-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const multi = JSON.stringify({ manifests: [
    { platform: { os: 'linux', architecture: 'amd64' } },
    { platform: { os: 'linux', architecture: 'arm64' } },
    { platform: { os: 'unknown', architecture: 'unknown' } },
  ] })
  const amd64Only = JSON.stringify({ manifests: [
    { platform: { os: 'linux', architecture: 'amd64' } },
    { platform: { os: 'unknown', architecture: 'arm64' } },
  ] })
  const shim = join(dir, 'docker')
  writeFileSync(shim, `#!/bin/sh
case "$3" in
  both:1) printf '%s' '${multi}' ;;
  amd:1) printf '%s' '${amd64Only}' ;;
  single:1) printf '%s' '{"schemaVersion":2,"config":{}}' ;;
  *) echo 'manifest unknown' >&2; exit 1 ;;
esac
`)
  chmodSync(shim, 0o755)
  const run = (...images: string[]) => spawnSync(
    'bash', [join(root, 'scripts/check-self-host-stack.sh'), '--platforms', ...images],
    { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STACK_RETRY_SECONDS: '0' } },
  )

  it('passes an image with both platforms', () => {
    expect(run('both:1').status).toBe(0)
  })

  it('names the platform an image lacks', () => {
    const r = run('both:1', 'amd:1')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('amd:1: no image for linux/arm64')
  })

  it('refuses a manifest with no platform list', () => {
    const r = run('single:1')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('single:1: no image for linux/amd64 linux/arm64')
  })

  it('reports an unreadable manifest as that, not as a missing platform', () => {
    const r = run('gone:1')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('gone:1: manifest could not be read: manifest unknown')
  })
})
