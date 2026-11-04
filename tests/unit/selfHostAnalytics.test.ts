/**
 * Supabase log collection in the self-host stack: Logflare (service analytics) and vector run
 * only under the compose profile `logs` (supabase-overrides.yml), chosen by ENABLE_ANALYTICS
 * (configure.sh, install.sh) and switched by `harmony analytics on|off`. configure.sh runs whole
 * against a stand-in `docker` that answers only its version and config checks; `harmony` runs
 * against one that records every call.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const SELF_HOST = resolve(__dirname, '../../self-host')

type DependsOn = Record<string, { condition?: string; required?: boolean }>
type Service = { profiles?: string[]; depends_on?: DependsOn }

describe('supabase-overrides.yml', () => {
  const services = (parse(readFileSync(join(SELF_HOST, 'supabase-overrides.yml'), 'utf8'), { logLevel: 'error' }) as { services: Record<string, Service> }).services

  it('puts Logflare and vector in the logs profile', () => {
    expect(services.analytics.profiles).toEqual(['logs'])
    expect(services.vector.profiles).toEqual(['logs'])
  })

  // Upstream (SUPABASE_REF_DEFAULT) has every started service wait for analytics, and db for
  // vector; a required dependency on a service outside the enabled profiles makes compose refuse
  // the project ("depends on undefined service").
  it.each([
    ['kong', 'analytics'], ['auth', 'analytics'], ['rest', 'analytics'], ['realtime', 'analytics'],
    ['meta', 'analytics'], ['studio', 'analytics'], ['db', 'vector'],
  ])('%s starts without %s', (svc, dep) => {
    expect(services[svc]?.depends_on?.[dep]).toEqual({ condition: 'service_healthy', required: false })
  })
})

describe('lib.sh profiles_with', () => {
  const lib = (script: string) =>
    spawnSync('bash', ['-c', `set -euo pipefail; source "${SELF_HOST}/lib.sh"; ${script}`], { encoding: 'utf8' }).stdout

  it('adds a profile once, removes it, and keeps the others in order', () => {
    expect(lib(`profiles_with '' logs on`)).toBe('logs')
    expect(lib(`profiles_with 'voice,bots' logs on`)).toBe('voice,bots,logs')
    expect(lib(`profiles_with 'voice,logs,bots' logs on`)).toBe('voice,bots,logs')
    expect(lib(`profiles_with 'voice,logs,bots' logs off`)).toBe('voice,bots')
    expect(lib(`profiles_with 'logs' logs off`)).toBe('')
    expect(lib(`profiles_with 'voice' logs off`)).toBe('voice')
  })

  it('states the same memory figure as configure.sh', () => {
    const fig = (f: string) => /^\s*ANALYTICS_RAM="([^"]+)"$/m.exec(readFileSync(join(SELF_HOST, f), 'utf8'))?.[1]
    expect(fig('lib.sh')).toMatch(/^\d/)
    expect(fig('configure.sh')).toBe(fig('lib.sh'))
  })
})

describe('configure.sh and log collection', () => {
  const ref = /^SUPABASE_REF_DEFAULT=(.+)$/m.exec(readFileSync(join(SELF_HOST, 'configure.sh'), 'utf8'))?.[1] ?? ''
  let root: string
  let envFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-analytics-'))
    const sb = join(root, 'self-host', 'supabase')
    mkdirSync(sb, { recursive: true })
    mkdirSync(join(root, 'bin'))
    for (const f of ['configure.sh', 'linking.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    mkdirSync(join(root, 'webrtc'))
    copyFileSync(join(SELF_HOST, '..', 'webrtc', 'livekit.yaml.example'), join(root, 'webrtc', 'livekit.yaml.example'))
    writeFileSync(join(root, 'bin', 'docker'), '#!/usr/bin/env bash\n[ "$*" != "compose version --short" ] || echo 2.30.0\n')
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    writeFileSync(join(sb, 'docker-compose.yml'), 'services:\n  auth:\n    image: supabase/gotrue:v2.196.0\n')
    writeFileSync(join(sb, '.env.example'), 'ENABLE_EMAIL_AUTOCONFIRM=false\n')
    writeFileSync(join(sb, '.harmony-supabase-ref'), `${ref}\n`)
    envFile = join(root, 'self-host', '.env')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const configure = (extra: Record<string, string> = {}) => spawnSync('bash', [join(root, 'self-host', 'configure.sh'), '--non-interactive'], {
    cwd: root,
    encoding: 'utf8',
    input: '',
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      HARMONY_DOMAIN: 'chat.test',
      HARMONY_ADMIN_EMAIL: 'admin@chat.test',
      HARMONY_TLS: 'internal',
      HARMONY_VOICE: 'y',
      HARMONY_BOTS: 'n',
      HARMONY_REGISTRATION: 'open',
      ...extra,
    },
  })
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1]

  it('leaves it off on a new install', () => {
    const r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_ANALYTICS')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice')
  })

  it('turns it on with HARMONY_ANALYTICS=y and off again with n', () => {
    let r = configure({ HARMONY_ANALYTICS: 'y' })
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_ANALYTICS')).toBe('true')
    expect(value('COMPOSE_PROFILES')).toBe('voice,logs')
    r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice,logs')
    r = configure({ HARMONY_ANALYTICS: 'n' })
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_ANALYTICS')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice')
  })

  it('keeps it on for an install configured before the answer existed', () => {
    writeFileSync(envFile, 'DOMAIN=chat.test\nENABLE_VOICE=true\nCOMPOSE_PROFILES=voice\n')
    const r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_ANALYTICS')).toBe('true')
    expect(value('COMPOSE_PROFILES')).toBe('voice,logs')
  })

  it('keeps an install that turned it off, off', () => {
    writeFileSync(envFile, 'DOMAIN=chat.test\nENABLE_VOICE=true\nENABLE_ANALYTICS=false\nCOMPOSE_PROFILES=voice\n')
    const r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_ANALYTICS')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice')
  })
})

// Stand-in docker: every call to $FAKE_STATE/calls, with the working directory's .env profiles.
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s | %s\n' "$*" "$(sed -n 's/^COMPOSE_PROFILES=//p' .env 2>/dev/null)" >> "$FAKE_STATE/calls"
case "$1 $2" in
'compose ps') echo fake-db ;;
'exec -i') cat > "$FAKE_STATE/sql" ;;
esac
`

describe('harmony analytics', () => {
  let root: string
  let state: string
  let envFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-analytics-cmd-'))
    state = join(root, 'state')
    mkdirSync(state)
    mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, 'self-host', 'supabase'), { recursive: true })
    for (const f of ['harmony', 'lib.sh', 'linking.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER)
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    envFile = join(root, 'self-host', '.env')
    writeFileSync(envFile, 'DOMAIN=chat.test\nENABLE_VOICE=true\nENABLE_ANALYTICS=true\nCOMPOSE_PROFILES=voice,logs,bots\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const harmony = (...args: string[]) => spawnSync('bash', [join(root, 'self-host', 'harmony'), 'analytics', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_STATE: state },
  })
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1]
  const calls = () => readFileSync(join(state, 'calls'), 'utf8').trim().split('\n')

  it('off: drops the profile, then stops and removes both containers', () => {
    const r = harmony('off')
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_ANALYTICS')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots')
    expect(calls()).toEqual(['compose --profile logs rm -sf analytics vector | voice,bots'])
  })

  it('off --delete-logs: also empties _supabase._analytics and drops the publication Logflare recreates', () => {
    const r = harmony('off', '--delete-logs')
    expect(r.status, r.stderr).toBe(0)
    const sqlCall = calls().find((c) => c.startsWith('exec -i'))
    expect(sqlCall).toContain('-d _supabase')
    expect(readFileSync(join(state, 'sql'), 'utf8')).toBe(
      'DROP SCHEMA IF EXISTS _analytics CASCADE;\nCREATE SCHEMA _analytics AUTHORIZATION supabase_admin;\n' +
      'DROP PUBLICATION IF EXISTS logflare_pub;\n')
  })

  it('on: adds the profile and starts both', () => {
    writeFileSync(envFile, 'DOMAIN=chat.test\nENABLE_ANALYTICS=false\nCOMPOSE_PROFILES=voice\n')
    const r = harmony('on')
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_ANALYTICS')).toBe('true')
    expect(value('COMPOSE_PROFILES')).toBe('voice,logs')
    expect(calls()).toEqual(['compose up -d analytics vector | voice,logs'])
  })

  it('refuses --delete-logs without off, and an unknown state', () => {
    expect(harmony('on', '--delete-logs').status).toBe(1)
    expect(harmony('--delete-logs').status).toBe(1)
    expect(harmony('maybe').status).toBe(1)
    expect(value('COMPOSE_PROFILES')).toBe('voice,logs,bots')
  })
})
