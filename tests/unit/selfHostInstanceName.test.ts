/**
 * The instance name of a self-hosted instance: what NodeInfo metadata.nodeName and the instance
 * actor show other servers. install.sh asks it (lib.sh ask_instance_name) offering the domain,
 * configure.sh writes it, and an install still named Harmony as releases up to 1.9.7 offered is
 * named after its domain by `harmony update`, its database row too.
 *
 * Prompts read /dev/tty; the interactive cases run under util-linux `script`, which gives the
 * shell a terminal fed from stdin.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SELF_HOST = resolve(__dirname, '../../self-host')
const SCRIPT = spawnSync('script', ['--version']).status === 0

describe('lib.sh instance name', () => {
  let root: string
  let envFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-name-lib-'))
    mkdirSync(join(root, 'self-host'))
    for (const f of ['lib.sh', 'linking.sh', 'modes.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    envFile = join(root, 'self-host', '.env')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const lib = (body: string, env: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', `set -euo pipefail; source "${join(root, 'self-host', 'lib.sh')}"; ${body}`], {
      encoding: 'utf8',
      env: { ...process.env, HARMONY_NONINTERACTIVE: '1', HARMONY_INSTANCE_NAME: '', ...env },
    })
  const ask = (env: Record<string, string> = {}) => lib('ask_instance_name chat.example.org; printf "<%s>" "$INSTANCE_NAME"', env)
  // ask_instance_name with a terminal; `input` is typed line by line.
  const askTyped = (input: string, env: Record<string, string> = {}) =>
    spawnSync('script', ['-qec', `bash -c 'set -euo pipefail; source "${join(root, 'self-host', 'lib.sh')}"; ask_instance_name chat.example.org; printf "<%s>" "$INSTANCE_NAME"'`, '/dev/null'], {
      encoding: 'utf8',
      input,
      env: { ...process.env, HARMONY_NONINTERACTIVE: '0', HARMONY_INSTANCE_NAME: '', ...env },
    })

  it('trims and refuses what an env file cannot hold unquoted', () => {
    expect(lib(`printf '<%s>' "$(trim $'  Example Chat \\t')"`).stdout).toBe('<Example Chat>')
    expect(lib('instance_name_problem "Example Chat"').stdout).toBe('')
    expect(lib('instance_name_problem ""').stdout).toContain('empty')
    for (const bad of ['a$b', 'a #b', 'a"b', 'a\\b', 'a`b', "'ab", 'a\nb']) {
      expect(lib('instance_name_problem "$NAME"', { NAME: bad }).stdout, bad).toContain('cannot contain')
    }
  })

  it.each([
    ['DOMAIN=chat.test\nINSTANCE_NAME=Harmony\n', true],
    ['DOMAIN=chat.test\n', true],
    ['DOMAIN=chat.test\nINSTANCE_NAME=Harmony\nINSTANCE_NAME_CHOSEN=true\n', false],
    ['DOMAIN=chat.test\nINSTANCE_NAME=harmony\n', false],
    ['DOMAIN=chat.test\nINSTANCE_NAME=Example Chat\n', false],
    ['INSTANCE_NAME=Harmony\n', false],
  ])('instance_name_unchosen for %j: %s', (env, unchosen) => {
    writeFileSync(envFile, env)
    expect(lib('instance_name_unchosen').status).toBe(unchosen ? 0 : 1)
  })

  it('offers the domain on a new install', () => {
    expect(ask().stdout).toBe('<chat.example.org>')
  })

  it('offers the configured name, and the domain in place of an earlier release\'s Harmony', () => {
    writeFileSync(envFile, 'DOMAIN=chat.example.org\nINSTANCE_NAME=Example Chat\n')
    expect(ask().stdout).toBe('<Example Chat>')
    writeFileSync(envFile, 'DOMAIN=chat.example.org\nINSTANCE_NAME=Harmony\n')
    expect(ask().stdout).toBe('<chat.example.org>')
    writeFileSync(envFile, 'DOMAIN=chat.example.org\nINSTANCE_NAME=Harmony\nINSTANCE_NAME_CHOSEN=true\n')
    const kept = ask()
    expect(kept.stdout).toBe('<Harmony>')
    expect(kept.stderr).toContain("Harmony is the software's name")
  })

  it('takes HARMONY_INSTANCE_NAME, trimmed; whitespace alone is no name', () => {
    writeFileSync(envFile, 'DOMAIN=chat.example.org\nINSTANCE_NAME=Example Chat\n')
    expect(ask({ HARMONY_INSTANCE_NAME: '  Other Chat ' }).stdout).toBe('<Other Chat>')
    expect(ask({ HARMONY_INSTANCE_NAME: '   ' }).stdout).toBe('<Example Chat>')
  })

  it('takes Harmony from HARMONY_INSTANCE_NAME with a warning', () => {
    const r = ask({ HARMONY_INSTANCE_NAME: 'Harmony' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('<Harmony>')
    expect(r.stderr).toContain("Harmony is the software's name")
  })

  it('stops without a terminal on a name an env file cannot hold', () => {
    const r = ask({ HARMONY_INSTANCE_NAME: 'Chat #1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot contain')
  })

  it.runIf(SCRIPT)('takes the offer for Enter or a blank answer, never an empty name', () => {
    for (const typed of ['\n', '   \n']) {
      const r = askTyped(typed)
      expect(r.status, r.stdout).toBe(0)
      expect(r.stdout).toContain('Instance name, as the app and other servers show it [chat.example.org]:')
      expect(r.stdout).toMatch(/<chat\.example\.org>$/)
    }
  })

  it.runIf(SCRIPT)('asks again after a name with a #', () => {
    const r = askTyped('Chat #1\nChat One\n')
    expect(r.status, r.stdout).toBe(0)
    expect(r.stdout).toContain('cannot contain')
    expect(r.stdout).toMatch(/<Chat One>$/)
  })

  it.runIf(SCRIPT)('asks to confirm Harmony typed over the offer', () => {
    let r = askTyped('Harmony\nn\nExample Chat\n')
    expect(r.status, r.stdout).toBe(0)
    expect(r.stdout).toContain('Name this instance Harmony anyway? (y/n) [n]:')
    expect(r.stdout).toMatch(/<Example Chat>$/)
    r = askTyped('harmony\ny\n')
    expect(r.status, r.stdout).toBe(0)
    expect(r.stdout).toMatch(/<harmony>$/)
  })
})

describe('configure.sh instance name', () => {
  const ref = /^SUPABASE_REF_DEFAULT=(.+)$/m.exec(readFileSync(join(SELF_HOST, 'configure.sh'), 'utf8'))?.[1] ?? ''
  let root: string
  let envFile: string
  let fedEnv: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-name-configure-'))
    const sb = join(root, 'self-host', 'supabase')
    mkdirSync(sb, { recursive: true })
    mkdirSync(join(root, 'bin'))
    for (const f of ['configure.sh', 'linking.sh', 'modes.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    mkdirSync(join(root, 'webrtc'))
    copyFileSync(join(SELF_HOST, '..', 'webrtc', 'livekit.yaml.example'), join(root, 'webrtc', 'livekit.yaml.example'))
    writeFileSync(join(root, 'bin', 'docker'), '#!/usr/bin/env bash\n[ "$*" != "compose version --short" ] || echo 2.30.0\n')
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    writeFileSync(join(sb, 'docker-compose.yml'), 'services:\n  auth:\n    image: supabase/gotrue:v2.196.0\n')
    writeFileSync(join(sb, '.env.example'), 'ENABLE_EMAIL_AUTOCONFIRM=false\n')
    writeFileSync(join(sb, '.harmony-supabase-ref'), `${ref}\n`)
    envFile = join(root, 'self-host', '.env')
    fedEnv = join(root, 'self-host', 'federation.env')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const configure = (extra: Record<string, string> = {}) => spawnSync('bash', [join(root, 'self-host', 'configure.sh'), '--non-interactive'], {
    cwd: root,
    encoding: 'utf8',
    input: '',
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      HARMONY_DOMAIN: 'chat.example.org',
      HARMONY_ADMIN_EMAIL: 'admin@chat.example.org',
      HARMONY_TLS: 'internal',
      HARMONY_VOICE: 'n',
      HARMONY_BOTS: 'n',
      HARMONY_REGISTRATION: 'open',
      HARMONY_INSTANCE_NAME: '',
      ...extra,
    },
  })
  const value = (file: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1]
  const existing = (name: string, chosen = false) =>
    writeFileSync(envFile, `DOMAIN=chat.example.org\nINSTANCE_NAME=${name}\n${chosen ? 'INSTANCE_NAME_CHOSEN=true\n' : ''}ENABLE_ANALYTICS=false\nENABLE_STUDIO=false\n`)

  it('names a new install after its domain, in .env and federation.env', () => {
    const r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value(envFile, 'INSTANCE_NAME')).toBe('chat.example.org')
    expect(value(fedEnv, 'INSTANCE_NAME')).toBe('chat.example.org')
    expect(value(envFile, 'INSTANCE_NAME_CHOSEN')).toBeUndefined()
    expect(r.stderr).not.toContain("software's name")
  })

  it('takes HARMONY_INSTANCE_NAME', () => {
    const r = configure({ HARMONY_INSTANCE_NAME: ' Example Chat ' })
    expect(r.status, r.stderr).toBe(0)
    expect(value(envFile, 'INSTANCE_NAME')).toBe('Example Chat')
    expect(value(fedEnv, 'INSTANCE_NAME')).toBe('Example Chat')
  })

  it('renames Harmony left from an earlier release, and keeps it once chosen', () => {
    existing('Harmony')
    expect(configure().status).toBe(0)
    expect(value(envFile, 'INSTANCE_NAME')).toBe('chat.example.org')
    existing('Harmony', true)
    const r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value(envFile, 'INSTANCE_NAME')).toBe('Harmony')
    expect(value(envFile, 'INSTANCE_NAME_CHOSEN')).toBe('true')
    expect(r.stderr).toContain("Harmony is the software's name")
  })

  it('marks Harmony given as the answer, and drops the mark for another name', () => {
    existing('Example Chat')
    let r = configure({ HARMONY_INSTANCE_NAME: 'Harmony' })
    expect(r.status, r.stderr).toBe(0)
    expect(value(envFile, 'INSTANCE_NAME')).toBe('Harmony')
    expect(value(envFile, 'INSTANCE_NAME_CHOSEN')).toBe('true')
    r = configure()
    expect(value(envFile, 'INSTANCE_NAME')).toBe('Harmony')
    r = configure({ HARMONY_INSTANCE_NAME: 'Example Chat' })
    expect(r.status, r.stderr).toBe(0)
    expect(value(envFile, 'INSTANCE_NAME_CHOSEN')).toBeUndefined()
  })

  it('keeps any other configured name', () => {
    existing('harmony')
    expect(configure().status).toBe(0)
    expect(value(envFile, 'INSTANCE_NAME')).toBe('harmony')
  })

  it('refuses the names lib.sh refuses', () => {
    for (const bad of ['a$b', 'Chat #1', 'a"b', 'a\\b', 'a`b', "'ab"]) {
      const r = configure({ HARMONY_INSTANCE_NAME: bad })
      expect(r.status, bad).toBe(1)
      expect(r.stderr, bad).toContain('cannot contain')
    }
  })
})

// Stand-in docker: every call to $FAKE_STATE/calls, SQL from stdin to $FAKE_STATE/sql; the
// instance_config UPDATE answers one row while $FAKE_STATE/harmony-row exists.
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_STATE/calls"
case "$1 $2" in
'compose version') echo 2.30.0 ;;
'compose ps') echo fake-db ;;
'exec -i')
	sql="$(cat)"
	printf '%s\n' "$sql" >> "$FAKE_STATE/sql"
	case "$sql" in *instance_config*) [ -e "$FAKE_STATE/harmony-row" ] && echo 1 ;; esac ;;
esac
exit 0
`

// update.sh from step 2 (--code-updated: the checkout is the target), stand-in bootstrap.sh;
// HARMONY_SKIP_BACKUP leaves backup.sh out.
describe('harmony update and the instance name', () => {
  const ref = /^SUPABASE_REF_DEFAULT=(.+)$/m.exec(readFileSync(join(SELF_HOST, 'configure.sh'), 'utf8'))?.[1] ?? ''
  let root: string
  let state: string
  let envFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-name-update-'))
    state = join(root, 'state')
    mkdirSync(state)
    mkdirSync(join(root, 'bin'))
    const sb = join(root, 'self-host', 'supabase')
    mkdirSync(sb, { recursive: true })
    for (const f of ['update.sh', 'configure.sh', 'lib.sh', 'linking.sh', 'modes.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
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

  const update = (name: string, extra: Record<string, string> = {}) => {
    writeFileSync(envFile, `DOMAIN=chat.example.org\nADMIN_EMAIL=admin@chat.example.org\nCADDY_TLS=internal\nENABLE_VOICE=false\nENABLE_ANALYTICS=false\nENABLE_STUDIO=false\nREGISTRATION=open\n${name}`)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    return spawnSync('bash', [join(root, 'self-host', 'update.sh'), '--code-updated', head], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_STATE: state, HARMONY_SKIP_BACKUP: '1', HARMONY_INSTANCE_NAME: '', ...extra },
    })
  }
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(envFile, 'utf8'))?.[1]
  const sql = () => (existsSync(join(state, 'sql')) ? readFileSync(join(state, 'sql'), 'utf8') : '')
  const calls = () => readFileSync(join(state, 'calls'), 'utf8').trim().split('\n')

  it('names an install still on Harmony after its domain, the database row too, and says so', () => {
    writeFileSync(join(state, 'harmony-row'), '')
    const r = update('INSTANCE_NAME=Harmony\n')
    expect(r.status, r.stderr).toBe(0)
    expect(value('INSTANCE_NAME')).toBe('chat.example.org')
    expect(sql()).toContain("WHERE config_key = 'instance_name' AND config_value = '\"Harmony\"'::jsonb")
    const exec = calls().find((c) => c.startsWith('exec -i'))
    expect(exec).toContain('-v name=chat.example.org')
    // Renamed after the migrations, before the containers are recreated.
    expect(calls().findIndex((c) => c.startsWith('exec -i'))).toBeLessThan(calls().findIndex((c) => c.startsWith('compose up -d')))
    const lines = r.stdout.split('\n').filter((l) => l.includes('Instance name:'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('chat.example.org, in place of Harmony')
  })

  it('leaves a name set in the admin panel, quietly', () => {
    const r = update('INSTANCE_NAME=Harmony\n')
    expect(r.status, r.stderr).toBe(0)
    expect(value('INSTANCE_NAME')).toBe('chat.example.org')
    expect(sql()).toContain('instance_config')
    expect(r.stdout).not.toContain('Instance name:')
  })

  it.each([
    ['INSTANCE_NAME=Example Chat\n', 'Example Chat'],
    ['INSTANCE_NAME=Harmony\nINSTANCE_NAME_CHOSEN=true\n', 'Harmony'],
  ])('leaves a chosen name and the database alone (%j)', (env, kept) => {
    const r = update(env)
    expect(r.status, r.stderr).toBe(0)
    expect(value('INSTANCE_NAME')).toBe(kept)
    expect(sql()).not.toContain('instance_config')
  })
})
