/**
 * The chat bridges an instance runs: one question (configure.sh, install.sh) and `harmony bridges`.
 * A bridge needs the bot gateway and turns it on. Removing one turns its offers in the admin panel
 * off and keeps communities' settings. Stand-in `docker` as in selfHostStudio.test.ts; it answers
 * the SQL it is given on stdin and records it.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SELF_HOST = resolve(__dirname, '../../self-host')

const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_STATE/calls"
case "$1 $2" in
'compose version') echo 2.30.0 ;;
'compose ps')
	case "$*" in
	*discord-bridge-host*) [[ -f "$FAKE_STATE/running" ]] && echo fake-bridge || true ;;
	*matrix-bridge-host*) [[ -f "$FAKE_STATE/running-matrix" ]] && echo fake-matrix || true ;;
	*) echo fake-db ;;
	esac ;;
'exec -i')
	sql="$(cat)"
	[[ -f "$FAKE_STATE/db-down" ]] && exit 1
	printf '%s\n' "$sql" >> "$FAKE_STATE/sql"
	case "$sql" in
	*'FROM public.discord_bridges'*) cat "$FAKE_STATE/counts" 2>/dev/null || echo '0 0' ;;
	*'FROM public.matrix_bridges'*) cat "$FAKE_STATE/counts-matrix" 2>/dev/null || echo '0 0' ;;
	*bool_or*) echo 'true false' ;;
	esac ;;
esac
exit 0
`

let root: string
let state: string
let envFile: string

beforeEach(() => {
  const ref = /^SUPABASE_REF_DEFAULT=(.+)$/m.exec(readFileSync(join(SELF_HOST, 'configure.sh'), 'utf8'))?.[1] ?? ''
  root = mkdtempSync(join(tmpdir(), 'harmony-bridges-'))
  state = join(root, 'state')
  mkdirSync(state)
  mkdirSync(join(root, 'bin'))
  const sb = join(root, 'self-host', 'supabase')
  mkdirSync(sb, { recursive: true })
  for (const f of ['harmony', 'configure.sh', 'lib.sh', 'linking.sh', 'modes.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
  writeFileSync(join(root, 'self-host', 'bootstrap.sh'), 'exit 0\n')
  writeFileSync(join(root, 'self-host', 'admin.sh'), 'exit 1\n')
  mkdirSync(join(root, 'webrtc'))
  copyFileSync(join(SELF_HOST, '..', 'webrtc', 'livekit.yaml.example'), join(root, 'webrtc', 'livekit.yaml.example'))
  writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER)
  chmodSync(join(root, 'bin', 'docker'), 0o755)
  writeFileSync(join(sb, 'docker-compose.yml'), 'services:\n  auth:\n    image: supabase/gotrue:v2.196.0\n')
  writeFileSync(join(sb, '.env.example'), 'ENABLE_EMAIL_AUTOCONFIRM=false\n')
  writeFileSync(join(sb, '.harmony-supabase-ref'), `${ref}\n`)
  envFile = join(root, 'self-host', '.env')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = (script: string, args: string[], extra: Record<string, string> = {}) => spawnSync('bash', [join(root, 'self-host', script), ...args], {
  cwd: root,
  encoding: 'utf8',
  input: '',
  env: {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    FAKE_STATE: state,
    HARMONY_NONINTERACTIVE: '1',
    ...extra,
  },
})
const configure = (extra: Record<string, string> = {}) => run('configure.sh', ['--non-interactive'], {
  HARMONY_DOMAIN: 'chat.test',
  HARMONY_ADMIN_EMAIL: 'admin@chat.test',
  HARMONY_TLS: 'internal',
  HARMONY_VOICE: 'y',
  HARMONY_REGISTRATION: 'open',
  ...extra,
})
const harmony = (...args: string[]) => run('harmony', args)
const value = (key: string, file = envFile) => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1]
const inSelfHost = (name: string) => join(root, 'self-host', name)
const log = (name: 'calls' | 'sql') => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : '')
const forget = () => { for (const f of ['calls', 'sql']) rmSync(join(state, f), { force: true }) }

describe('the bridge question', () => {
  it('runs none on a new install, with the gateway on, and keeps an answer given once', () => {
    expect(configure().status).toBe(0)
    expect(value('ENABLE_DISCORD_BRIDGE')).toBe('false')
    expect(value('ENABLE_MATRIX_BRIDGE')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots')
    expect(configure({ HARMONY_BOTS: 'n' }).status).toBe(0)
    expect(configure().status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice')
  })

  it('an install from before ENABLE_BOTS keeps what it ran', () => {
    const forgetBots = () => writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^ENABLE_BOTS=.*\n/m, ''))
    expect(configure({ HARMONY_BOTS: 'n' }).status).toBe(0)
    forgetBots()
    expect(configure().status).toBe(0)
    expect(value('ENABLE_BOTS')).toBe('false')

    expect(configure({ HARMONY_BOTS: 'y' }).status).toBe(0)
    forgetBots()
    expect(configure().status).toBe(0)
    expect(value('ENABLE_BOTS')).toBe('true')
  })

  it('turns the gateway on with a bridge, also against HARMONY_BOTS=n, and keeps both on a re-run', () => {
    const r = configure({ HARMONY_DISCORD: 'y', HARMONY_BOTS: 'n' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout + r.stderr).toContain('enabling bots')
    expect(value('ENABLE_BOTS')).toBe('true')
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,discord')
    expect(value('BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).toMatch(/^[0-9a-f]{64}$/)
    expect(value('BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).toBe(value('BRIDGE_HOST_SECRET', inSelfHost('discord-bridge.env')))
    expect(configure().status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,discord')
  })

  it('HARMONY_DISCORD=n keeps the gateway; HARMONY_BOTS=n turns the bridge off with it', () => {
    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    expect(configure({ HARMONY_DISCORD: 'n' }).status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots')
    expect(value('BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).toBeUndefined()
    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    expect(configure({ HARMONY_BOTS: 'n' }).status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice')
  })

  it('runs both, each with a secret of its own, and turns one off without the other', () => {
    const r = configure({ HARMONY_DISCORD: 'y', HARMONY_MATRIX: 'y' })
    expect(r.status, r.stderr).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,discord,matrix')
    const matrix = value('BRIDGE_HOST_SECRET', inSelfHost('matrix-bridge.env'))
    expect(matrix).toMatch(/^[0-9a-f]{64}$/)
    expect(value('MATRIX_BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).toBe(matrix)
    expect(value('BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).not.toBe(matrix)

    expect(configure({ HARMONY_DISCORD: 'n' }).status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,matrix')
    expect(value('BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).toBeUndefined()
    expect(value('MATRIX_BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).toBe(matrix)

    expect(configure({ HARMONY_MATRIX: 'n' }).status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots')
    expect(value('MATRIX_BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).toBeUndefined()
    // The secret comes back as it was, for a host container that still holds it.
    expect(configure({ HARMONY_MATRIX: 'y' }).status).toBe(0)
    expect(value('MATRIX_BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).toBe(matrix)
  })

  it('HARMONY_BOTS=n with one bridge answered keeps the other that runs', () => {
    expect(configure({ HARMONY_MATRIX: 'y' }).status).toBe(0)
    expect(configure({ HARMONY_BOTS: 'n', HARMONY_DISCORD: 'y' }).status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,discord,matrix')
    expect(configure({ HARMONY_BOTS: 'n' }).status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice')
  })

  it('install.sh asks once, in place of the gateway question when a bridge is chosen', () => {
    const install = readFileSync(join(SELF_HOST, 'install.sh'), 'utf8')
    expect(install.match(/ask BRIDGES /g)).toHaveLength(1)
    expect(install).not.toContain('Host Discord bridges')
  })

  it('install.sh preselects what configure.sh takes', () => {
    const install = readFileSync(join(SELF_HOST, 'install.sh'), 'utf8')
    const block = /^\toff=false\n[\s\S]*?\n\tfi\n(?=\n\techo\n\tinfo "Supabase log collection)/m.exec(install)?.[0] ?? ''
    expect(block).toContain('ask_yn "Enable bots?"')
    const yn = /^yn\(\) .*$/m.exec(install)?.[0] ?? ''
    const bridgeDefault = /^bridge_default\(\) \{[\s\S]*?^\}$/m.exec(install)?.[0] ?? ''
    // ask takes the preselected answer, as the installer does without a terminal.
    const preselected = (extra: Record<string, string> = {}) => {
      writeFileSync(inSelfHost('preselected.sh'), `
. "$(dirname "$0")/lib.sh"
ask() { printf -v "$1" '%s' "$3"; }
ask_yn() { local a; ask a "$1" "$2"; truthy "$a"; }
${yn}
${bridgeDefault}
questions() { local cur
${block}
}
questions
echo "bots=$BOTS discord=$DISCORD matrix=$MATRIX"
`)
      const r = run('preselected.sh', [], extra)
      expect(r.status, r.stderr).toBe(0)
      return r.stdout.trim().split('\n').at(-1)
    }
    expect(preselected()).toBe('bots=y discord=n matrix=n')
    expect(preselected({ HARMONY_BOTS: 'n' })).toBe('bots=n discord=n matrix=n')
    expect(preselected({ HARMONY_MATRIX: 'y', HARMONY_BOTS: 'n' })).toBe('bots=y discord=n matrix=y')

    writeFileSync(envFile, 'DOMAIN=chat.test\n')
    expect(preselected()).toBe('bots=n discord=n matrix=n')
    writeFileSync(inSelfHost('bot-gateway.env'), '')
    expect(preselected()).toBe('bots=y discord=n matrix=n')
    writeFileSync(envFile, 'DOMAIN=chat.test\nENABLE_BOTS=false\n')
    expect(preselected()).toBe('bots=n discord=n matrix=n')
    writeFileSync(envFile, 'DOMAIN=chat.test\nENABLE_BOTS=true\nENABLE_DISCORD_BRIDGE=true\nENABLE_MATRIX_BRIDGE=true\n')
    expect(preselected()).toBe('bots=y discord=y matrix=y')
    expect(preselected({ HARMONY_BOTS: 'n' })).toBe('bots=n discord=n matrix=n')
  })
})

describe('harmony bridges', () => {
  it('says what runs, without touching a container', () => {
    expect(configure({ HARMONY_BOTS: 'n' }).status).toBe(0)
    forget()
    const off = harmony('bridges')
    expect(off.status, off.stderr).toBe(0)
    expect(off.stdout).toContain('Bot gateway: off')
    expect(off.stdout).toContain('Discord: off')
    expect(log('calls')).not.toMatch(/compose (up|rm|pull)|--profile/)

    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    writeFileSync(join(state, 'running'), '')
    writeFileSync(join(state, 'counts'), '2 1\n')
    const on = harmony('bridges').stdout
    expect(on).toContain('Bot gateway: on')
    expect(on).toContain('Discord: on.')
    expect(on).toContain("2 with a community's own bot, 1 with this instance's bot")
    expect(on).toContain("own bot yes, this instance's bot no")
  })

  it('reports a host that should run and does not, and still answers with the database down', () => {
    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    writeFileSync(join(state, 'db-down'), '')
    const r = harmony('bridges')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('discord-bridge-host is not running')
    expect(r.stdout).not.toContain('Run here')
  })

  it('add: gateway, secret and host, without pulling newer images, and names the step left', () => {
    expect(configure({ HARMONY_BOTS: 'n' }).status).toBe(0)
    forget()
    const r = harmony('bridges', 'add', 'discord')
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_BOTS')).toBe('true')
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,discord')
    expect(value('DOMAIN')).toBe('chat.test')
    expect(value('REGISTRATION')).toBe('open')
    expect(log('calls')).toMatch(/^compose up -d$/m)
    expect(log('calls')).not.toContain('compose pull')
    expect(r.stdout).toContain('Instance admin, Config, General, Discord bridge')
  })

  it('add: changes nothing when the host already runs, and refuses another name', () => {
    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    writeFileSync(join(state, 'running'), '')
    forget()
    expect(harmony('bridges', 'add', 'discord').stdout).toContain('already runs')
    expect(log('calls')).not.toContain('compose up')
    expect(harmony('bridges', 'add', 'irc').status).toBe(1)
    expect(harmony('bridges', 'add').status).toBe(1)
    expect(harmony('bridges', 'maybe').status).toBe(1)
  })

  it('remove: refuses without --yes while communities use it, changing nothing', () => {
    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    writeFileSync(join(state, 'counts'), '2 1\n')
    forget()
    const r = harmony('bridges', 'remove', 'discord')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("3 communities' bridges stop")
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,discord')
    expect(log('sql')).not.toContain('UPDATE')
    expect(log('calls')).not.toMatch(/compose --profile|compose up/)
  })

  it('remove --yes: offers off, host and secret gone, gateway and data kept', () => {
    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    writeFileSync(join(state, 'counts'), '2 1\n')
    forget()
    const r = harmony('bridges', 'remove', 'discord', '--yes')
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_DISCORD_BRIDGE')).toBe('false')
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots')
    expect(value('BRIDGE_HOST_SECRET', inSelfHost('bot-gateway.env'))).toBeUndefined()
    expect(log('sql')).toMatch(/UPDATE public\.instance_config[\s\S]*discord_bridge_hosting_enabled[\s\S]*discord_bridge_instance_bot_enabled/)
    expect(log('calls')).toContain('compose --profile discord rm -sf discord-bridge-host')
    expect(log('calls')).not.toContain('volume rm')
    expect(r.stdout).toContain('The bot gateway stays on')
  })

  it('remove: asks nothing when no community uses it; --delete-data deletes the volume and needs --yes', () => {
    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    expect(harmony('bridges', 'remove', 'discord').status).toBe(0)
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots')
    expect(harmony('bridges', 'remove', 'discord').stdout).toContain('is off')

    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    expect(harmony('bridges', 'remove', 'discord', '--delete-data').status).toBe(1)
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,discord')
    forget()
    expect(harmony('bridges', 'remove', 'discord', '--delete-data', '--yes').status).toBe(0)
    expect(log('calls')).toContain('volume rm harmony_discord-bridge-data')
    expect(log('calls').indexOf('rm -sf discord-bridge-host')).toBeLessThan(log('calls').indexOf('volume rm'))
  })

  it('remove: with the database down it does not guess, and says the offers are still on', () => {
    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    writeFileSync(join(state, 'db-down'), '')
    expect(harmony('bridges', 'remove', 'discord').status).toBe(1)
    const r = harmony('bridges', 'remove', 'discord', '--yes')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('is not known')
    expect(r.stderr).toContain('were not turned off')
  })

  it('add both: starts what does not run, in one pass', () => {
    expect(configure({ HARMONY_DISCORD: 'y' }).status).toBe(0)
    writeFileSync(join(state, 'running'), '')
    forget()
    const r = harmony('bridges', 'add', 'both')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('The Discord bridge host already runs')
    expect(r.stdout).toContain('Starting the Matrix bridge host')
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,discord,matrix')
    expect(log('calls').match(/^compose up -d$/gm)).toHaveLength(1)
    expect(r.stdout).toContain('Instance admin, Config, General, Matrix bridge')
  })

  it('Matrix: status, counts and offers are its own', () => {
    expect(configure({ HARMONY_DISCORD: 'y', HARMONY_MATRIX: 'y' }).status).toBe(0)
    writeFileSync(join(state, 'running'), '')
    writeFileSync(join(state, 'running-matrix'), '')
    writeFileSync(join(state, 'counts'), '4 5\n')
    writeFileSync(join(state, 'counts-matrix'), '2 1\n')
    const out = harmony('bridges').stdout
    expect(out).toContain('Matrix: on.')
    expect(out).toContain("4 with a community's own bot, 5 with this instance's bot")
    expect(out).toContain("2 with a community's own account, 1 with this instance's bridge")
    expect(log('sql')).toMatch(/matrix_bridge_hosting_enabled', 'matrix_bridge_instance_enabled'/)
  })

  it('Matrix remove --yes --delete-data: its offers, host and volume, and nothing of Discord', () => {
    expect(configure({ HARMONY_DISCORD: 'y', HARMONY_MATRIX: 'y' }).status).toBe(0)
    writeFileSync(join(state, 'counts-matrix'), '2 1\n')
    expect(harmony('bridges', 'remove', 'matrix').status).toBe(1)
    forget()
    const r = harmony('bridges', 'remove', 'matrix', '--delete-data', '--yes')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain("3 communities' bridges stop: 2 with their own account, 1 with this instance's bridge")
    expect(value('COMPOSE_PROFILES')).toBe('voice,bots,discord')
    expect(log('sql')).toMatch(/UPDATE public\.instance_config[\s\S]*matrix_bridge_hosting_enabled[\s\S]*matrix_bridge_instance_enabled/)
    expect(log('sql')).not.toContain('discord_bridge')
    expect(log('calls')).toContain('compose --profile matrix rm -sf matrix-bridge-host')
    expect(log('calls')).toContain('volume rm harmony_matrix-bridge-data')
    expect(log('calls')).not.toContain('rm -sf discord-bridge-host')
    expect(harmony('bridges', 'remove', 'both', '--yes').status).toBe(1)
  })

  it('is in help', () => {
    const out = harmony('help').stdout
    expect(out).toContain('harmony bridges add discord | matrix | both')
    expect(out).toContain('harmony bridges remove discord | matrix')
    expect(out).toContain('thin layer')
  })
})
