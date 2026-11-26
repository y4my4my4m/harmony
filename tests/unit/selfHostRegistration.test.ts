/**
 * self-host registration per sign-in method (admin.sh registration and auth sign-up, lib.sh
 * registration_hand_over, doctor.sh check_registration; migration 20261126500001).
 *
 * GoTrue's DISABLE_SIGNUP refuses every new account, a sign-in provider's included. Where the auth
 * service runs the sign-up hook and the hook applies instance_config.registration_policy, the
 * switch stays off and the hook decides. admin.sh runs here against a stand-in `docker`:
 * $FAKE_STATE/events gets one line per stored policy, open_registration write, provider write and
 * auth recreation, in order; auth_config is what `compose config auth` renders; hook_applies is
 * the database's answer (t or f); modes the rows of signup_modes.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SELF_HOST = resolve(__dirname, '../../self-host')

const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
state="$FAKE_STATE"
last="${"$"}{@: -1}"
case "$1" in
compose)
	case "$2" in
	ps) printf 'fake-%s\n' "$last" ;;
	config) cat "$state/auth_config" 2>/dev/null ;;
	up)
		v="$(sed -n 's/^DISABLE_SIGNUP=//p' supabase/.env | head -1)"
		printf '%s' "$v" > "$state/live"
		printf 'recreate DISABLE_SIGNUP=%s\n' "$v" >> "$state/events" ;;
	esac ;;
inspect)
	case "$*" in
	*State.Health*) echo healthy ;;
	*Config.Env*) printf 'GOTRUE_DISABLE_SIGNUP=%s\n' "$(cat "$state/live" 2>/dev/null)" ;;
	esac ;;
exec)
	case "$*" in
	*pg_isready*) exit 0 ;;
	*psql*)
		case "$last" in
		*signup_registration_refusal*) cat "$state/hook_applies" 2>/dev/null || echo t ;;
		*"is_local AND is_admin"*) echo 1 ;;
		*"'registration_policy'"*) printf 'store %s\n' "$(printf '%s' "$last" | grep -o "'\"[a-z]*\"'::jsonb" | head -1 | tr -d "'\"" | sed 's/::jsonb//')" >> "$state/events" ;;
		*open_registration*) printf 'open_registration %s\n' "$(printf '%s' "$last" | grep -o "'[a-z]*'::jsonb" | head -1 | tr -d "'" | sed 's/::jsonb//')" >> "$state/events" ;;
		*jsonb_each*) cat "$state/modes" 2>/dev/null || true ;;
		*signup_providers*) printf '%s\n' "$last" >> "$state/provider_sql"; echo providers >> "$state/events" ;;
		esac ;;
	esac ;;
esac
`

const HOOKED = 'name: harmony\nservices:\n  auth:\n    environment:\n' +
  '      GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED: "true"\n' +
  '      GOTRUE_HOOK_BEFORE_USER_CREATED_URI: pg-functions://postgres/public/before_user_created_hook\n'
const UNHOOKED = 'name: harmony\nservices:\n  auth:\n    environment:\n      GOTRUE_DISABLE_SIGNUP: "true"\n'

describe('harmony registration and harmony auth sign-up', () => {
  let root: string
  let state: string
  let env: string
  let sbEnv: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-registration-'))
    state = join(root, 'state')
    mkdirSync(state)
    mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, 'self-host', 'supabase'), { recursive: true })
    for (const f of ['admin.sh', 'lib.sh', 'linking.sh', 'modes.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER)
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    env = join(root, 'self-host', '.env')
    sbEnv = join(root, 'self-host', 'supabase', '.env')
    writeFileSync(env, 'DOMAIN=chat.test\nREGISTRATION=closed\n')
    writeFileSync(sbEnv, 'API_EXTERNAL_URL=https://db.chat.test\nDISABLE_SIGNUP=true\n')
    writeFileSync(join(state, 'live'), 'true')
    writeFileSync(join(state, 'auth_config'), HOOKED)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const run = (...args: string[]) => spawnSync('bash', [join(root, 'self-host', 'admin.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_STATE: state, HARMONY_NONINTERACTIVE: '1' },
  })
  const lib = (script: string) => spawnSync('bash', ['-c', `set -euo pipefail; source "${join(root, 'self-host', 'lib.sh')}"; ${script}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, FAKE_STATE: state },
  })
  const events = () => { try { return readFileSync(join(state, 'events'), 'utf8').trim().split('\n') } catch { return [] } }
  const value = (file: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1]
  const providerSql = () => { try { return readFileSync(join(state, 'provider_sql'), 'utf8') } catch { return '' } }

  it('hands closed registration to the hook: the policy is stored before the switch turns off', () => {
    const r = run('registration', 'closed')
    expect(r.status, r.stderr).toBe(0)
    expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('false')
    expect(events()).toEqual(['store closed', 'open_registration false', 'recreate DISABLE_SIGNUP=false'])
  })

  it('keeps the switch on while the auth service does not run the hook', () => {
    writeFileSync(join(state, 'auth_config'), UNHOOKED)
    const r = run('registration', 'invite')
    expect(r.status, r.stderr).toBe(0)
    expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('true')
    expect(value(env, 'REGISTRATION')).toBe('invite')
    expect(events()).toEqual(['store invite', 'open_registration false', 'recreate DISABLE_SIGNUP=true'])
  })

  it('and while the database\'s hook does not apply the policy', () => {
    writeFileSync(join(state, 'hook_applies'), 'f')
    expect(run('registration', 'closed').status).toBe(0)
    expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('true')
  })

  it('opens with the switch off and the policy stored as open', () => {
    const r = run('registration', 'open')
    expect(r.status, r.stderr).toBe(0)
    expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('false')
    expect(events()).toEqual(['store open', 'open_registration true', 'recreate DISABLE_SIGNUP=false'])
  })

  it('says when providers set to create accounts create none because the switch stays on', () => {
    writeFileSync(join(state, 'auth_config'), UNHOOKED)
    writeFileSync(join(state, 'modes'), 'custom:school\tdomains\tmyschool.edu\n')
    const r = run('registration', 'closed')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('create none')
  })

  it('stores a domain list for a custom provider, lowercased, without @ or duplicates', () => {
    writeFileSync(sbEnv, 'DISABLE_SIGNUP=false\n')
    const r = run('auth', 'sign-up', 'school', '--domains', ' MySchool.edu, @corp.example,myschool.edu,')
    expect(r.status, r.stderr).toBe(0)
    expect(providerSql()).toContain(`jsonb_build_object('custom:school', '{"mode": "domains", "domains": ["myschool.edu", "corp.example"]}'::jsonb)`)
    expect(r.stdout).toContain('addresses it has verified at myschool.edu, corp.example')
    expect(events()).toEqual(['providers'])
  })

  it('names a built-in provider as the auth service does', () => {
    writeFileSync(sbEnv, 'DISABLE_SIGNUP=false\n')
    const r = run('auth', 'sign-up', 'Discord', '--open')
    expect(r.status, r.stderr).toBe(0)
    expect(providerSql()).toContain(`jsonb_build_object('discord', '{"mode": "open"}'::jsonb)`)
  })

  it('drops the provider\'s entry to follow registration', () => {
    const r = run('auth', 'sign-up', 'custom:school', '--follow-registration')
    expect(r.status, r.stderr).toBe(0)
    expect(providerSql()).toContain(`- 'custom:school'`)
    expect(events()).toEqual(['providers'])
  })

  it('refuses what is not a domain name, a glob included, and mixed modes, writing nothing', () => {
    for (const args of [
      ['school', '--domains', 'not a domain'],
      ['school', '--domains', '*'],
      ['school', '--domains', 'myschool'],
      ['school', '--domains', ''],
      ['school', '--open', '--domains', 'myschool.edu'],
      ['school'],
      ['bad id!', '--open'],
    ]) {
      const r = run('auth', 'sign-up', ...args)
      expect(r.status, args.join(' ')).not.toBe(0)
    }
    expect(providerSql()).toBe('')
    expect(events()).toEqual([])
  })

  it('hands invite registration to the hook when a provider opens while the switch is on', () => {
    writeFileSync(env, 'DOMAIN=chat.test\nREGISTRATION=invite\n')
    const r = run('auth', 'sign-up', 'school', '--open')
    expect(r.status, r.stderr).toBe(0)
    expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('false')
    expect(events()).toEqual(['providers', 'store invite', 'open_registration false', 'recreate DISABLE_SIGNUP=false'])
  })

  it('stores the mode but warns when the switch stays on and the auth service lacks the hook', () => {
    writeFileSync(join(state, 'auth_config'), UNHOOKED)
    const r = run('auth', 'sign-up', 'school', '--open')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('refuses every new account')
    expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('true')
    expect(events()).toEqual(['providers'])
  })

  it('asks for an update when the database\'s hook does not read provider modes', () => {
    writeFileSync(join(state, 'hook_applies'), 'f')
    const r = run('auth', 'sign-up', 'school', '--open')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('harmony update')
    expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('true')
  })

  describe('registration_hand_over (update.sh)', () => {
    it('stores invite or closed and turns the switch off for the next recreation', () => {
      writeFileSync(env, 'REGISTRATION=invite-only\n')
      const r = lib('registration_hand_over')
      expect(r.status, r.stderr).toBe(0)
      expect(events()).toEqual(['store invite'])
      expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('false')
    })

    it('leaves an install at open with the switch on, one with the switch off, and one without the hook', () => {
      writeFileSync(env, 'REGISTRATION=open\n')
      expect(lib('registration_hand_over').status).toBe(0)
      expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('true')

      writeFileSync(env, 'REGISTRATION=closed\n')
      writeFileSync(join(state, 'auth_config'), UNHOOKED)
      expect(lib('registration_hand_over').status).toBe(0)
      expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('true')

      writeFileSync(join(state, 'auth_config'), HOOKED)
      writeFileSync(join(state, 'hook_applies'), 'f')
      expect(lib('registration_hand_over').status).toBe(0)
      expect(value(sbEnv, 'DISABLE_SIGNUP')).toBe('true')

      writeFileSync(sbEnv, 'DISABLE_SIGNUP=false\n')
      writeFileSync(join(state, 'hook_applies'), 't')
      expect(lib('registration_hand_over').status).toBe(0)
      expect(events()).toEqual([])
    })

    it('runs after the migrations in update.sh', () => {
      const update = readFileSync(join(SELF_HOST, 'update.sh'), 'utf8')
      const migrate = update.indexOf('bootstrap.sh" --migrations-only')
      const handOver = update.indexOf('\tregistration_hand_over')
      const restart = update.indexOf('STEP=restart')
      expect(migrate).toBeGreaterThan(0)
      expect(handOver).toBeGreaterThan(migrate)
      expect(restart).toBeGreaterThan(handOver)
    })
  })

  it('takes an invite pass before GoTrue makes the invited account', () => {
    const admin = readFileSync(join(SELF_HOST, 'admin.sh'), 'utf8')
    const program = /^NODE_INVITE='[\s\S]*?^'$/m.exec(admin)?.[0] ?? ''
    expect(program.indexOf('signup_invite_pass')).toBeGreaterThan(0)
    expect(program.indexOf('signup_invite_pass')).toBeLessThan(program.indexOf('/auth/v1/invite'))
    expect(program.indexOf('signup_invite_pass')).toBeLessThan(program.indexOf('generate_link'))
  })
})

describe('doctor.sh check_registration', () => {
  const doctor = readFileSync(join(SELF_HOST, 'doctor.sh'), 'utf8')
  const fn = /^check_registration\(\) \{\n[\s\S]*?\n\}\n/m.exec(doctor)?.[0] ?? ''
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'doctor-registration-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  interface Case { policy: string; live: string; hooked?: boolean; stored?: string; openReg?: string; modes?: string }
  // One report per line: LEVEL|detail|fix.
  const check = (c: Case) => {
    writeFileSync(join(dir, '.env'), `REGISTRATION=${c.policy}\n`)
    writeFileSync(join(dir, 'auth.env'), (c.live ? `GOTRUE_DISABLE_SIGNUP=${c.live}\n` : '') +
      (c.hooked === false ? '' : 'GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED=true\n'))
    writeFileSync(join(dir, 'modes'), c.modes ?? '')
    const openReg = c.openReg ?? (c.policy === 'open' ? 'true' : 'false')
    const r = spawnSync('bash', ['-c', `set -euo pipefail; source "${SELF_HOST}/lib.sh"
ENV_FILE='${join(dir, '.env')}'
report() { printf '%s|%s|%s\\n' "$1" "$3" "\${4:-}"; }
auth_env() { cat '${join(dir, 'auth.env')}'; }
hook_applies_registration() { ${c.hooked === false ? 'false' : 'true'}; }
signup_modes() { cat '${join(dir, 'modes')}'; }
db_sql() {
	case "$*" in
	*open_registration*) echo '${openReg}' ;;
	*registration_policy*) echo '${c.stored ?? ''}' ;;
	esac
}
${fn}
check_registration`], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim().split('\n').filter(Boolean)
  }

  it('is defined', () => expect(fn).not.toBe(''))

  it('passes invite applied by the hook, and names providers that create accounts', () => {
    const out = check({ policy: 'invite', live: 'false', stored: 'invite', modes: 'custom:school\tdomains\tmyschool.edu\n' })
    expect(out).toEqual(['OK|invite, applied by the sign-up hook; providers that create accounts: custom:school|'])
  })

  it('fails when the switch is off and nothing applies closed registration', () => {
    expect(check({ policy: 'closed', live: 'false', hooked: false, stored: 'closed' })[0])
      .toMatch(/^FAIL\|.*anyone can sign up\|harmony registration closed$/)
    expect(check({ policy: 'closed', live: 'false', stored: 'open' })[0]).toMatch(/^FAIL\|/)
    expect(check({ policy: 'invite', live: 'false' })[0]).toMatch(/^FAIL\|/)
  })

  it('passes the switch on, and warns when a provider set to create accounts cannot', () => {
    expect(check({ policy: 'closed', live: 'true' })).toEqual(['OK|closed|'])
    expect(check({ policy: 'closed', live: 'true', modes: 'discord\topen\t\n' })[0])
      .toMatch(/^WARN\|closed; the auth service refuses every new account, so discord create none\|harmony registration closed$/)
  })

  it('passes open, and warns about a switch, a stored policy or an announcement that disagree', () => {
    expect(check({ policy: 'open', live: 'false' })).toEqual(['OK|open|'])
    expect(check({ policy: 'open', live: 'false', stored: 'open' })).toEqual(['OK|open|'])
    expect(check({ policy: 'open', live: 'true' })[0]).toMatch(/^WARN\|/)
    expect(check({ policy: 'open', live: 'false', stored: 'closed' })[0]).toMatch(/^WARN\|/)
    expect(check({ policy: 'invite', live: 'true', openReg: 'true' })[0]).toMatch(/^WARN\|/)
  })

  it('warns while the auth service is not running', () => {
    expect(check({ policy: 'closed', live: '' })[0]).toMatch(/^WARN\|.*sign-up disabled=\?/)
  })
})
