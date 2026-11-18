/**
 * Sign-in provider credentials of Admin, Authentication (migration 20261117800001) reach GoTrue
 * through one named volume: federation-server writes it, auth reads it as --config-dir and
 * reloads on change. Both images run as uid 1000; the federation image owns the mount point, so an
 * empty volume takes that owner whichever container mounts it first.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(__dirname, '../..')
type Service = { command?: string[]; volumes?: string[]; environment?: Record<string, unknown> }
type Compose = { services: Record<string, Service>; volumes?: Record<string, unknown> }
const read = (path: string) => parse(readFileSync(join(root, path), 'utf8'), { logLevel: 'error' }) as Compose

const overrides = read('self-host/supabase-overrides.yml')
const stack = read('self-host/docker-compose.yml')
const e2e = read('e2e/docker-compose.yml')

describe('auth config directory', () => {
  it('auth reloads the volume read-only', () => {
    const auth = overrides.services.auth
    expect(auth.command).toEqual(['auth', '--config-dir', '/etc/harmony-auth'])
    expect(auth.volumes).toContain('auth-config:/etc/harmony-auth:ro')
    expect(overrides.volumes).toHaveProperty('auth-config')
  })

  it('the federation server writes the same volume, the worker never', () => {
    const server = stack.services['federation-server']
    expect(server.environment?.HARMONY_AUTH_CONFIG_DIR).toBe('/var/lib/harmony-auth')
    expect(server.volumes).toContain('auth-config:/var/lib/harmony-auth')
    expect(stack.services['federation-worker'].volumes ?? []).not.toContainEqual(expect.stringContaining('auth-config'))
    expect(stack.volumes).toHaveProperty('auth-config')
  })

  it('the federation image owns the mount point as node, mode 0700', () => {
    const dockerfile = readFileSync(join(root, 'federation-backend/Dockerfile'), 'utf8')
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM '))
    expect(runtime).toMatch(/mkdir -p \/var\/lib\/harmony-auth && chown node:node \/var\/lib\/harmony-auth && chmod 700 \/var\/lib\/harmony-auth/)
    expect(runtime.indexOf('/var/lib/harmony-auth')).toBeLessThan(runtime.indexOf('USER node'))
  })

  it('Discord has the same fallback variables as the other built-in providers', () => {
    const env = overrides.services.auth.environment ?? {}
    for (const p of ['GOOGLE', 'GITHUB', 'TWITCH', 'DISCORD']) {
      expect(env).toHaveProperty(`GOTRUE_EXTERNAL_${p}_ENABLED`)
      expect(env).toHaveProperty(`GOTRUE_EXTERNAL_${p}_CLIENT_ID`)
      expect(env).toHaveProperty(`GOTRUE_EXTERNAL_${p}_SECRET`)
      expect(env[`GOTRUE_EXTERNAL_${p}_REDIRECT_URI`]).toBe('${API_EXTERNAL_URL}/auth/v1/callback')
    }
  })

  it('the e2e stack runs auth the same way', () => {
    expect(e2e.services.auth.command).toEqual(['auth', '--config-dir', '/etc/harmony-auth'])
    expect(e2e.services.auth.volumes).toContain('./auth-config:/etc/harmony-auth:ro')
  })
})
