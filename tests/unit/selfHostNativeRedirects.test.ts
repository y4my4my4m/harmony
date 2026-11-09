/**
 * self-host configure.sh and ADDITIONAL_REDIRECT_URLS (GOTRUE_URI_ALLOW_LIST). GoTrue 2.196.0
 * sends an OAuth redirect_to that is neither on SITE_URL's host nor in the list to SITE_URL, so
 * the native apps, whose sign-in ends on their own origin (tauri://localhost on macOS and iOS,
 * http://tauri.localhost on Windows, Android and Linux), need their entries there.
 * configure.sh runs whole against a stand-in docker that answers only its version check.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SELF_HOST = resolve(__dirname, '../../self-host')
const NATIVE = 'tauri://localhost/**,http://tauri.localhost/**'

describe('configure.sh and the native apps\' sign-in redirects', () => {
  const ref = /^SUPABASE_REF_DEFAULT=(.+)$/m.exec(readFileSync(join(SELF_HOST, 'configure.sh'), 'utf8'))?.[1] ?? ''
  let root: string
  let sbEnv: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-configure-'))
    const sb = join(root, 'self-host', 'supabase')
    mkdirSync(sb, { recursive: true })
    mkdirSync(join(root, 'bin'))
    for (const f of ['configure.sh', 'linking.sh', 'modes.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    writeFileSync(join(root, 'bin', 'docker'), '#!/usr/bin/env bash\n[ "$*" != "compose version --short" ] || echo 2.30.0\n')
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    writeFileSync(join(sb, 'docker-compose.yml'), 'services:\n  auth:\n    image: supabase/gotrue:v2.196.0\n')
    writeFileSync(join(sb, '.env.example'), 'ADDITIONAL_REDIRECT_URLS=\n')
    writeFileSync(join(sb, '.harmony-supabase-ref'), `${ref}\n`)
    sbEnv = join(sb, '.env')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const configure = (domain = 'chat.test') => spawnSync('bash', [join(root, 'self-host', 'configure.sh'), '--non-interactive'], {
    cwd: root,
    encoding: 'utf8',
    input: '',
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      HARMONY_DOMAIN: domain,
      HARMONY_ADMIN_EMAIL: `admin@${domain}`,
      HARMONY_TLS: 'internal',
      HARMONY_VOICE: 'n',
      HARMONY_BOTS: 'n',
      HARMONY_REGISTRATION: 'open',
    },
  })
  const redirects = () => /^ADDITIONAL_REDIRECT_URLS=(.*)$/m.exec(readFileSync(sbEnv, 'utf8'))?.[1]

  it('lists the instance and both native origins on a new install', () => {
    const r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(redirects()).toBe(`https://chat.test,${NATIVE}`)
  })

  it('adds them to an existing install once, after the entries present', () => {
    writeFileSync(sbEnv, 'ADDITIONAL_REDIRECT_URLS=https://chat.test,https://staff.chat.test/**\n')
    let r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(redirects()).toBe(`https://chat.test,https://staff.chat.test/**,${NATIVE}`)
    r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(redirects()).toBe(`https://chat.test,https://staff.chat.test/**,${NATIVE}`)
  })

  it('adds only the one missing', () => {
    writeFileSync(sbEnv, 'ADDITIONAL_REDIRECT_URLS=http://tauri.localhost/**,https://chat.test\n')
    expect(configure().status).toBe(0)
    expect(redirects()).toBe('http://tauri.localhost/**,https://chat.test,tauri://localhost/**')
  })

  it('keeps them when the domain changes', () => {
    expect(configure().status).toBe(0)
    const r = configure('talk.test')
    expect(r.status, r.stderr).toBe(0)
    expect(redirects()).toBe(`https://talk.test,${NATIVE}`)
  })
})
