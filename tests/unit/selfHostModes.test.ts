/**
 * Modes of the files the self-host containers read (self-host/modes.sh). A bind mount and an
 * image build's COPY keep the host file's mode; supabase-db and kong read as their own users,
 * through the "other" bits. Under umask 077 git and tar write 0600 and 0700, and Postgres could
 * not run supabase/volumes/db/*.sql. configure.sh, which install.sh and update.sh run and which
 * --refresh-supabase is, gives the public files o+r and leaves the secrets 0600.
 * Every script here runs under umask 077, against a stand-in docker that answers only its
 * version check and a stand-in upstream Supabase repository.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SELF_HOST = resolve(__dirname, '../../self-host')
const STUB_DOCKER = '#!/usr/bin/env bash\n[ "$*" != "compose version --short" ] || echo 2.30.0\n'
const SUPABASE_REF_DEFAULT = /^SUPABASE_REF_DEFAULT=(.+)$/m.exec(readFileSync(join(SELF_HOST, 'configure.sh'), 'utf8'))?.[1] ?? ''

const umask077 = (cwd: string, script: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', `umask 077; ${script}`], { cwd, encoding: 'utf8', input: '', env: { ...process.env, ...env } })
const mode = (p: string) => statSync(p).mode & 0o777
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.trim()
}
// write DIR { path: content }: a file per entry, mode 0755 when it starts with #!, else 0644.
const write = (dir: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
    chmodSync(join(dir, path), content.startsWith('#!') ? 0o755 : 0o644)
  }
}
// repo DIR FILES: a git repository at DIR holding FILES in one commit on main.
const repo = (dir: string, files: Record<string, string>) => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  write(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
}
const commit = (dir: string, files: Record<string, string>) => {
  write(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'next')
}
const copies = (...names: string[]) => Object.fromEntries(names.map((n) => [`self-host/${n}`, readFileSync(join(SELF_HOST, n), 'utf8')]))

// self-host/.gitignore of the checkout, less the comments.
const GITIGNORE = readFileSync(join(SELF_HOST, '.gitignore'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).join('\n') + '\n'

describe('modes.sh', () => {
  let base: string
  let co: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'harmony-modes-'))
    repo(join(base, 'src'), {
      'docs/a.md': 'a\n',
      'self-host/Caddyfile': '{}\n',
      'self-host/install.sh': '#!/bin/sh\n',
      'self-host/web-entrypoint.d/40-harmony-config.sh': '#!/bin/sh\n',
      'self-host/.gitignore': GITIGNORE,
    })
    expect(umask077(base, 'git clone -q src co').status).toBe(0)
    co = join(base, 'co')
    const r = umask077(co, `
      printf s > self-host/.env; printf s > self-host/federation.env; printf s > self-host/livekit.yaml
      mkdir -p self-host/backups/1 && printf s > self-host/backups/1/database.dump
      sb=self-host/supabase
      mkdir -p $sb/volumes/db/data $sb/volumes/db/data.before-restore-1 $sb/volumes/api $sb/volumes/functions/main $sb/volumes/storage/stub
      for f in docker-compose.yml volumes/db/roles.sql volumes/api/kong.yml volumes/functions/main/index.ts \\
        .env .env.bak docker-compose.override.yml test.http \\
        volumes/db/data/PG_VERSION volumes/db/data.before-restore-1/PG_VERSION volumes/storage/stub/object; do printf x > $sb/$f; done
      printf s > ../outside`)
    expect(r.status, r.stderr).toBe(0)
    symlinkSync(join(base, 'outside'), join(co, 'self-host/supabase/volumes/outside'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const lib = (script: string) => spawnSync('bash', ['-c', `set -euo pipefail; source "${SELF_HOST}/modes.sh"; ${script}`], {
    cwd: co, encoding: 'utf8', env: { ...process.env, REPO_DIR: co },
  })
  const unreadable = () => lib('public_unreadable | tr "\\0" "\\n"').stdout.split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, '')).sort()

  it('lists the tracked files, their directories and supabase/ less its data and operator files', () => {
    expect(unreadable()).toEqual([
      '.', 'docs', 'docs/a.md', 'self-host', 'self-host/.gitignore', 'self-host/Caddyfile', 'self-host/install.sh',
      'self-host/supabase', 'self-host/supabase/docker-compose.yml', 'self-host/supabase/volumes',
      'self-host/supabase/volumes/api', 'self-host/supabase/volumes/api/kong.yml', 'self-host/supabase/volumes/db',
      'self-host/supabase/volumes/db/roles.sql', 'self-host/supabase/volumes/functions', 'self-host/supabase/volumes/functions/main',
      'self-host/supabase/volumes/functions/main/index.ts', 'self-host/web-entrypoint.d', 'self-host/web-entrypoint.d/40-harmony-config.sh',
    ])
  })

  it('gives them what umask 022 gives and leaves every other file as it was', () => {
    const r = lib('public_readable; echo "$PUBLIC_CHANGED"')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('19')
    const at = (p: string) => mode(join(co, p))
    for (const p of ['.', 'docs', 'self-host', 'self-host/web-entrypoint.d', 'self-host/supabase', 'self-host/supabase/volumes/db', 'self-host/supabase/volumes/functions/main']) expect(at(p), p).toBe(0o755)
    for (const p of ['docs/a.md', 'self-host/Caddyfile', 'self-host/supabase/volumes/db/roles.sql', 'self-host/supabase/volumes/api/kong.yml', 'self-host/supabase/volumes/functions/main/index.ts']) expect(at(p), p).toBe(0o644)
    for (const p of ['self-host/install.sh', 'self-host/web-entrypoint.d/40-harmony-config.sh']) expect(at(p), p).toBe(0o755)
    for (const p of ['self-host/.env', 'self-host/federation.env', 'self-host/livekit.yaml', 'self-host/backups/1/database.dump',
      'self-host/supabase/.env', 'self-host/supabase/.env.bak', 'self-host/supabase/docker-compose.override.yml', 'self-host/supabase/test.http',
      'self-host/supabase/volumes/db/data/PG_VERSION', 'self-host/supabase/volumes/db/data.before-restore-1/PG_VERSION',
      'self-host/supabase/volumes/storage/stub/object']) expect(at(p), p).toBe(0o600)
    for (const p of ['.git', 'self-host/backups', 'self-host/supabase/volumes/db/data', 'self-host/supabase/volumes/storage']) expect(at(p), p).toBe(0o700)
    expect(mode(join(base, 'outside'))).toBe(0o600)
  })

  it('gives the group-only modes of umask 027 the same', () => {
    expect(spawnSync('bash', ['-c', 'umask 027; git clone -q src co027'], { cwd: base }).status).toBe(0)
    const c = join(base, 'co027')
    expect(mode(join(c, 'self-host/Caddyfile'))).toBe(0o640)
    const r = spawnSync('bash', ['-c', `source "${SELF_HOST}/modes.sh"; public_readable`], { cwd: c, encoding: 'utf8', env: { ...process.env, REPO_DIR: c } })
    expect(r.status, r.stderr).toBe(0)
    expect(mode(join(c, 'self-host/Caddyfile'))).toBe(0o644)
    expect(mode(join(c, 'self-host/install.sh'))).toBe(0o755)
    expect(mode(join(c, 'self-host'))).toBe(0o755)
  })

  it('changes nothing once the modes are right', () => {
    expect(lib('public_readable').status).toBe(0)
    const ctime = statSync(join(co, 'self-host/Caddyfile')).ctimeMs
    const r = lib('public_readable; echo "$PUBLIC_CHANGED"')
    expect(r.stdout.trim()).toBe('0')
    expect(unreadable()).toEqual([])
    expect(statSync(join(co, 'self-host/Caddyfile')).ctimeMs).toBe(ctime)
  })
})

describe('configure.sh under umask 077', () => {
  let base: string
  let co: string
  let upstream: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'harmony-modes-configure-'))
    upstream = join(base, 'supabase')
    repo(upstream, {
      'docker/docker-compose.yml': 'services:\n  db:\n    image: supabase/postgres:15.8.1.060\n  auth:\n    image: supabase/gotrue:v2.196.0\n',
      'docker/.env.example': 'ENABLE_EMAIL_AUTOCONFIRM=false\n',
      'docker/reset.sh': '#!/bin/sh\n',
      'docker/volumes/db/roles.sql': '-- roles\n',
      'docker/volumes/api/kong.yml': '_format_version: "2.1"\n',
      'docker/volumes/functions/main/index.ts': '\n',
    })
    repo(join(base, 'src'), {
      ...copies('configure.sh', 'linking.sh', 'modes.sh'),
      'self-host/.gitignore': GITIGNORE,
      'webrtc/livekit.yaml.example': readFileSync(join(SELF_HOST, '..', 'webrtc', 'livekit.yaml.example'), 'utf8'),
    })
    expect(umask077(base, 'git clone -q src co').status).toBe(0)
    co = join(base, 'co')
    mkdirSync(join(base, 'bin'))
    writeFileSync(join(base, 'bin', 'docker'), STUB_DOCKER)
    chmodSync(join(base, 'bin', 'docker'), 0o755)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const configure = (...args: string[]) => umask077(co, `bash self-host/configure.sh ${args.join(' ')}`, {
    PATH: `${join(base, 'bin')}:${process.env.PATH}`,
    SUPABASE_REPO: `file://${upstream}`,
    SUPABASE_REF: 'main',
    HARMONY_DOMAIN: 'chat.test',
    HARMONY_ADMIN_EMAIL: 'admin@chat.test',
    HARMONY_TLS: 'internal',
    HARMONY_VOICE: 'y',
    HARMONY_BOTS: 'y',
    HARMONY_DISCORD: 'y',
    HARMONY_REGISTRATION: 'open',
  })
  const at = (p: string) => mode(join(co, 'self-host', p))
  const SECRETS = ['.env', 'federation.env', 'bot-gateway.env', 'discord-bridge.env', 'livekit.yaml', 'supabase/.env']

  it('provisions supabase/ readable to the containers and writes the secrets 0600', () => {
    const r = configure('--non-interactive')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/\d+ files and directories the containers read made readable to them/)
    for (const p of ['supabase', 'supabase/volumes', 'supabase/volumes/db', 'supabase/volumes/functions/main']) expect(at(p), p).toBe(0o755)
    for (const p of ['supabase/docker-compose.yml', 'supabase/volumes/db/roles.sql', 'supabase/volumes/api/kong.yml', 'modes.sh']) expect(at(p), p).toBe(0o644)
    expect(at('configure.sh')).toBe(0o755)
    for (const p of SECRETS) expect(at(p), p).toBe(0o600)
    expect(r.stdout + r.stderr).not.toMatch(/chmod could not/)
  })

  it('--refresh-supabase leaves the new upstream files readable and the database and secrets as they were', () => {
    expect(configure('--non-interactive').status).toBe(0)
    commit(upstream, { 'docker/volumes/db/pooler.sql': '-- pooler\n', 'docker/volumes/db/roles.sql': '-- roles 2\n' })
    expect(umask077(co, 'mkdir -p self-host/supabase/volumes/db/data && printf 15 > self-host/supabase/volumes/db/data/PG_VERSION').status).toBe(0)
    const r = configure('--refresh-supabase')
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(co, 'self-host/supabase/volumes/db/roles.sql'), 'utf8')).toBe('-- roles 2\n')
    for (const p of ['supabase/volumes/db/pooler.sql', 'supabase/volumes/db/roles.sql']) expect(at(p), p).toBe(0o644)
    expect(at('supabase/volumes/db/data')).toBe(0o700)
    expect(at('supabase/volumes/db/data/PG_VERSION')).toBe(0o600)
    for (const p of SECRETS) expect(at(p), p).toBe(0o600)
  })

  it('takes a livekit.yaml back to 0600', () => {
    expect(configure('--non-interactive').status).toBe(0)
    chmodSync(join(co, 'self-host/livekit.yaml'), 0o644)
    expect(configure('--non-interactive').status).toBe(0)
    expect(at('livekit.yaml')).toBe(0o600)
  })
})

// update.sh from step 1: fetches and fast-forwards the checkout under umask 077, continues in
// the new update.sh, configures, and restarts against the stand-in docker; bootstrap.sh is a
// stand-in, HARMONY_SKIP_BACKUP leaves backup.sh out.
describe('harmony update under umask 077', () => {
  let base: string
  let origin: string
  let co: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'harmony-modes-update-'))
    origin = join(base, 'origin')
    repo(origin, {
      ...copies('update.sh', 'configure.sh', 'lib.sh', 'linking.sh', 'modes.sh'),
      'self-host/bootstrap.sh': 'exit 0\n',
      'self-host/.gitignore': GITIGNORE,
      'webrtc/livekit.yaml.example': readFileSync(join(SELF_HOST, '..', 'webrtc', 'livekit.yaml.example'), 'utf8'),
    })
    expect(umask077(base, 'git clone -q origin co').status).toBe(0)
    co = join(base, 'co')
    const r = umask077(co, `
      sb=self-host/supabase
      mkdir -p $sb/volumes/db
      printf 'services:\\n  auth:\\n    image: supabase/gotrue:v2.196.0\\n' > $sb/docker-compose.yml
      printf 'ENABLE_EMAIL_AUTOCONFIRM=false\\n' > $sb/.env.example
      printf '%s\\n' '${SUPABASE_REF_DEFAULT}' > $sb/.harmony-supabase-ref
      printf -- '-- roles\\n' > $sb/volumes/db/roles.sql
      printf 'DOMAIN=chat.test\\nADMIN_EMAIL=admin@chat.test\\nCADDY_TLS=internal\\nENABLE_VOICE=true\\nENABLE_ANALYTICS=false\\nREGISTRATION=open\\nCOMPOSE_PROFILES=voice\\n' > self-host/.env`)
    expect(r.status, r.stderr).toBe(0)
    mkdirSync(join(base, 'bin'))
    writeFileSync(join(base, 'bin', 'docker'), STUB_DOCKER)
    chmodSync(join(base, 'bin', 'docker'), 0o755)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('leaves the files the new code brings, and supabase/, readable to the containers', () => {
    commit(origin, { 'self-host/Caddyfile': '{}\n', 'self-host/media/cache.conf': 'x\n' })
    const r = umask077(co, 'bash self-host/update.sh', { PATH: `${join(base, 'bin')}:${process.env.PATH}`, HARMONY_SKIP_BACKUP: '1' })
    expect(r.status, r.stderr).toBe(0)
    expect(git(co, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'HEAD'))
    const at = (p: string) => mode(join(co, 'self-host', p))
    for (const p of ['Caddyfile', 'media/cache.conf', 'lib.sh', 'supabase/volumes/db/roles.sql']) expect(at(p), p).toBe(0o644)
    for (const p of ['update.sh', 'media', 'supabase', 'supabase/volumes/db']) expect(at(p), p).toBe(0o755)
    for (const p of ['.env', 'federation.env', 'livekit.yaml', 'supabase/.env']) expect(at(p), p).toBe(0o600)
  })
})

describe('doctor.sh check_files and check_db_init', () => {
  const doctor = readFileSync(join(SELF_HOST, 'doctor.sh'), 'utf8')
  const fn = (name: string) => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(doctor)?.[0] ?? ''

  // One report per line: LEVEL|check|detail|fix. UNREAD is what public_unreadable lists.
  const run = (name: string, stubs: string) => {
    const r = spawnSync('bash', ['-c', `set -uo pipefail
report() { printf '%s|%s|%s|%s\\n' "$1" "$2" "$3" "\${4:-}"; }
SELF_HOST_DIR=/opt/harmony/self-host ENV_FILE=/opt/harmony/self-host/.env
${stubs}
${fn(name)}
${name}`], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim().split('\n').filter(Boolean)
  }
  const files = (unread: string[], composeFile = '') => run('check_files', `
public_unreadable() { ${unread.length ? `printf '%s\\0' ${unread.map((p) => `'${p}'`).join(' ')}` : ':'}; }
env_get() { [ "$2" != COMPOSE_FILE ] || printf '%s' '${composeFile}'; }`)

  it('are defined', () => {
    expect(fn('check_files')).not.toBe('')
    expect(fn('check_db_init')).not.toBe('')
  })

  it('files: OK when every public path is readable', () => {
    expect(files([])).toEqual(['OK|files|the checkout and supabase/ are readable to the containers|'])
  })

  it('files: WARN for the checkout alone, FAIL for supabase/ or a build install', () => {
    const warn = files(['./self-host/Caddyfile', './docs'])
    expect(warn).toHaveLength(1)
    expect(warn[0]).toMatch(/^WARN\|files\|2 files or directories the containers read lack o\+r \(first: self-host\/Caddyfile\)/)
    expect(warn[0]).toContain('|bash /opt/harmony/self-host/configure.sh --non-interactive')
    expect(files(['./self-host/Caddyfile', 'self-host/supabase/volumes/db/roles.sql'])[0]).toMatch(/^FAIL\|files\|2 /)
    expect(files(['./self-host/Caddyfile'], 'docker-compose.yml:docker-compose.build.yml')[0]).toMatch(/^FAIL\|files\|1 /)
  })

  it('db init: FAIL with the way to a new database when authenticator has no password', () => {
    const out = run('check_db_init', `db_sql() { echo t; }`)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^FAIL\|db init\|authenticator has no password/)
    expect(out[0]).toContain('mv supabase/volumes/db/data supabase/volumes/db/data.failed; bash install.sh')
    expect(run('check_db_init', `db_sql() { echo f; }`)[0]).toMatch(/^OK\|db init\|/)
  })
})
