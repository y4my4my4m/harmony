/**
 * Supabase Studio in the self-host stack: studio and meta run only under the compose profile
 * `studio` (supabase-overrides.yml), chosen by ENABLE_STUDIO and switched by
 * `harmony studio on|off`. An install configured without ENABLE_STUDIO ran it unasked; `harmony
 * update` turns it off there. Stand-in `docker` as in selfHostAnalytics.test.ts.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const SELF_HOST = resolve(__dirname, '../../self-host')

const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s | %s\n' "$*" "$(sed -n 's/^COMPOSE_PROFILES=//p' .env 2>/dev/null)" >> "$FAKE_STATE/calls"
case "$1 $2" in
'compose version') echo 2.30.0 ;;
'compose ps') echo fake-db ;;
esac
`

describe('supabase-overrides.yml', () => {
  type Service = { profiles?: string[] }
  const services = (parse(readFileSync(join(SELF_HOST, 'supabase-overrides.yml'), 'utf8'), { logLevel: 'error' }) as { services: Record<string, Service> }).services

  it('puts Studio and postgres-meta in the studio profile', () => {
    expect(services.studio.profiles).toEqual(['studio'])
    expect(services.meta.profiles).toEqual(['studio'])
  })
})

describe('harmony studio', () => {
  let root: string
  let state: string
  let envFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-studio-cmd-'))
    state = join(root, 'state')
    mkdirSync(state)
    mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, 'self-host', 'supabase'), { recursive: true })
    for (const f of ['harmony', 'lib.sh', 'linking.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER)
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    envFile = join(root, 'self-host', '.env')
    writeFileSync(envFile, 'DOMAIN=chat.test\nDB_DOMAIN=db.chat.test\nENABLE_STUDIO=false\nCOMPOSE_PROFILES=voice\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const harmony = (...args: string[]) => spawnSync('bash', [join(root, 'self-host', 'harmony'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_STATE: state },
  })
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1]
  const calls = () => readFileSync(join(state, 'calls'), 'utf8').trim().split('\n')

  it('says it is off, without touching a container', () => {
    const r = harmony('studio')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Supabase Studio: off')
  })

  it('on: adds the profile, starts both, and warns what the password reaches', () => {
    const r = harmony('studio', 'on')
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_STUDIO')).toBe('true')
    expect(value('COMPOSE_PROFILES')).toBe('voice,studio')
    expect(calls()).toEqual(['compose up -d studio meta | voice,studio'])
    expect(r.stdout + r.stderr).toContain('whole database')
    expect(harmony('studio').stdout).toContain('Supabase Studio: on, at https://db.chat.test')
  })

  it('off: drops the profile, then stops and removes both', () => {
    writeFileSync(envFile, 'DOMAIN=chat.test\nENABLE_STUDIO=true\nCOMPOSE_PROFILES=voice,studio,bots\n')
    const r = harmony('studio', 'off')
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_STUDIO')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots')
    expect(calls()).toEqual(['compose --profile studio rm -sf studio meta | voice,bots'])
  })

  it('refuses an unknown state', () => {
    expect(harmony('studio', 'maybe').status).toBe(1)
    expect(value('COMPOSE_PROFILES')).toBe('voice')
  })

  it('prints the whole command list in help', () => {
    const out = harmony('help').stdout
    expect(out).toContain('harmony studio [on | off]')
    expect(out).toContain('harmony version')
    expect(out).toContain('thin layer')
  })
})

// update.sh from step 2 (--code-updated), as selfHostAnalytics.test.ts.
describe('configure and update', () => {
  const ref = /^SUPABASE_REF_DEFAULT=(.+)$/m.exec(readFileSync(join(SELF_HOST, 'configure.sh'), 'utf8'))?.[1] ?? ''
  let root: string
  let state: string
  let envFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-studio-update-'))
    state = join(root, 'state')
    mkdirSync(state)
    mkdirSync(join(root, 'bin'))
    const sb = join(root, 'self-host', 'supabase')
    mkdirSync(sb, { recursive: true })
    for (const f of ['update.sh', 'configure.sh', 'lib.sh', 'linking.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    writeFileSync(join(root, 'self-host', 'bootstrap.sh'), 'exit 0\n')
    mkdirSync(join(root, 'webrtc'))
    copyFileSync(join(SELF_HOST, '..', 'webrtc', 'livekit.yaml.example'), join(root, 'webrtc', 'livekit.yaml.example'))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER)
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    writeFileSync(join(sb, 'docker-compose.yml'), 'services:\n  auth:\n    image: supabase/gotrue:v2.196.0\n')
    writeFileSync(join(sb, '.env.example'), 'ENABLE_EMAIL_AUTOCONFIRM=false\n')
    writeFileSync(join(sb, '.harmony-supabase-ref'), `${ref}\n`)
    writeFileSync(join(root, '.gitignore'), 'state/\nbin/\n')
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']]) {
      expect(spawnSync('git', args, { cwd: root }).status).toBe(0)
    }
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
      FAKE_STATE: state,
      HARMONY_DOMAIN: 'chat.test',
      HARMONY_ADMIN_EMAIL: 'admin@chat.test',
      HARMONY_TLS: 'internal',
      HARMONY_VOICE: 'y',
      HARMONY_BOTS: 'n',
      HARMONY_REGISTRATION: 'open',
      ...extra,
    },
  })
  const update = (env: string, extra: Record<string, string> = {}) => {
    writeFileSync(envFile, `DOMAIN=chat.test\nADMIN_EMAIL=admin@chat.test\nCADDY_TLS=internal\nENABLE_VOICE=true\nREGISTRATION=open\nENABLE_ANALYTICS=false\n${env}`)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    return spawnSync('bash', [join(root, 'self-host', 'update.sh'), '--code-updated', head], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_STATE: state, HARMONY_SKIP_BACKUP: '1', ...extra },
    })
  }
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1]
  const calls = () => readFileSync(join(state, 'calls'), 'utf8').trim().split('\n')

  it('leaves it off on a new install and says how to start it', () => {
    const r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_STUDIO')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice')
    expect(r.stdout).toContain("'harmony studio on'")
  })

  it('turns it on with HARMONY_STUDIO=y, keeps it, and off again with n', () => {
    expect(configure({ HARMONY_STUDIO: 'y' }).status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice,studio')
    expect(configure().status).toBe(0)
    expect(value('ENABLE_STUDIO')).toBe('true')
    expect(value('COMPOSE_PROFILES')).toBe('voice,studio')
    expect(configure({ HARMONY_STUDIO: 'n' }).status).toBe(0)
    expect(value('ENABLE_STUDIO')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice')
  })

  it('removes it on an update of an install that never chose, before new images start, and says so once', () => {
    const r = update('COMPOSE_PROFILES=voice\n')
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_STUDIO')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice')
    const c = calls()
    const rm = c.findIndex((x) => x.startsWith('compose --profile studio rm -sf studio meta'))
    expect(rm).toBeGreaterThanOrEqual(0)
    expect(rm).toBeLessThan(c.findIndex((x) => x.startsWith('compose up')))
    const lines = r.stdout.split('\n').filter((l) => l.includes('Supabase Studio is off now'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('harmony studio on')
  })

  it.each([
    ['ENABLE_STUDIO=true\nCOMPOSE_PROFILES=voice,studio\n', {}, 'true', 'voice,studio'],
    ['COMPOSE_PROFILES=voice\n', { HARMONY_STUDIO: 'y' }, 'true', 'voice,studio'],
    ['ENABLE_STUDIO=false\nCOMPOSE_PROFILES=voice\n', {}, 'false', 'voice'],
  ])('leaves a chosen setting alone on update (%j %j)', (env, extra, enabled, profiles) => {
    const r = update(env, extra)
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_STUDIO')).toBe(enabled)
    expect(value('COMPOSE_PROFILES')).toBe(profiles)
    expect(calls().filter((c) => c.includes('rm -sf studio meta'))).toEqual([])
    expect(r.stdout).not.toContain('Supabase Studio is off now')
  })
})
