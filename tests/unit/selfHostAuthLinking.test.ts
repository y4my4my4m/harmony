/**
 * self-host account linking of sign-in providers (admin.sh auth, linking.sh, configure.sh,
 * doctor.sh check_auth_linking) and the auth image choice (configure.sh gotrue_image_for).
 *
 * GoTrue 2.196.0 puts a provider without a PROVIDER_LINKING_DOMAINS pair in the "default" domain,
 * where a first sign-in joins the existing account with the same address; with
 * ENABLE_EMAIL_AUTOCONFIRM=true every address counts as verified. admin.sh runs here against a
 * stand-in `docker` that records each auth recreation and each provider write with the linking
 * value the running auth service had at that moment; configure.sh runs whole against one that
 * answers only its version and config checks.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SELF_HOST = resolve(__dirname, '../../self-host')

function lib(script: string): { out: string; status: number } {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; source "${SELF_HOST}/lib.sh"; ${script}`], { encoding: 'utf8' })
  return { out: r.stdout, status: r.status ?? -1 }
}

describe('lib.sh linking_*', () => {
  it('parses what GoTrue parses: provider=domain pairs, comma-separated, sides trimmed and non-empty', () => {
    const valid = ['', '   ', 'custom:a=custom:a', 'custom:a=x, custom:b = x', 'custom:a=b=c']
    const invalid = ['custom:a', 'custom:a=', '=x', 'custom:a=x,', ',custom:a=x', 'custom:a=x,,custom:b=y', 'custom:a:custom:a']
    for (const v of valid) expect(lib(`linking_valid '${v}'`).status, v).toBe(0)
    for (const v of invalid) expect(lib(`linking_valid '${v}'`).status, v).toBe(1)
  })

  it('sets and drops one provider, keeping the other pairs in order and adding no duplicate', () => {
    expect(lib(`linking_set '' custom:a custom:a`).out).toBe('custom:a=custom:a')
    expect(lib(`linking_set 'custom:x=staff, custom:a=old' custom:a custom:a`).out).toBe('custom:x=staff,custom:a=custom:a')
    expect(lib(`linking_set 'custom:a=custom:a,custom:x=staff,custom:a=custom:a' custom:a custom:a`).out)
      .toBe('custom:x=staff,custom:a=custom:a')
    expect(lib(`linking_set 'custom:x=staff,custom:a=custom:a' custom:a`).out).toBe('custom:x=staff')
    expect(lib(`linking_set 'custom:a=custom:a' custom:a`).out).toBe('')
  })

  it('names the mode: by address without a pair or in the domain called default, separate, or shared', () => {
    const v = 'custom:a=custom:a,custom:b=staff,custom:c=staff,custom:d=default,custom:e=x,custom:e=custom:e'
    expect(lib(`linking_mode '${v}' custom:a`).out).toBe('separate')
    expect(lib(`linking_mode '${v}' custom:b`).out).toBe('shared: staff')
    expect(lib(`linking_mode '${v}' custom:d`).out).toBe('by address')
    expect(lib(`linking_mode '${v}' custom:z`).out).toBe('by address')
    expect(lib(`linking_mode '${v}' custom:e`).out).toBe('separate')
  })

  it('gives each provider without a pair a domain of its own and leaves a pair present, default included', () => {
    expect(lib(`linking_isolate '' github google twitch`).out).toBe('github=github,google=google,twitch=twitch')
    expect(lib(`linking_isolate 'custom:a=custom:a, github=default,google=staff' github google twitch`).out)
      .toBe('custom:a=custom:a,github=default,google=staff,twitch=twitch')
    expect(lib(`linking_isolate 'github=github,google=google,twitch=twitch' github google twitch`).out)
      .toBe('github=github,google=google,twitch=twitch')
  })

  it('names the providers the auth service has on, from its environment or from supabase/.env', () => {
    const env = 'GOTRUE_EXTERNAL_GITHUB_ENABLED=true\nGOTRUE_EXTERNAL_LINKEDIN_OIDC_ENABLED=1\n' +
      'GOTRUE_EXTERNAL_EMAIL_ENABLED=true\nGOTRUE_EXTERNAL_TWITCH_ENABLED=false\nGOTRUE_EXTERNAL_GOOGLE_ENABLED='
    expect(lib(`oauth_enabled "$(printf '${env}')"`).out).toBe('github linkedin_oidc')
    const dir = mkdtempSync(join(tmpdir(), 'oauth-enabled-'))
    try {
      writeFileSync(join(dir, '.env'), 'GOOGLE_ENABLED=true\nGITHUB_ENABLED=false\nDISCORD_ENABLED=true\n')
      expect(lib(`SB_ENV='${join(dir, '.env')}'; oauth_enabled ''`).out).toBe('google')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('configure.sh gotrue_image_for', () => {
  const configure = readFileSync(join(SELF_HOST, 'configure.sh'), 'utf8')
  const fn = /^gotrue_image_for\(\) \{\n[\s\S]*?\n\}\n/m.exec(configure)?.[0] ?? ''
  const min = /^GOTRUE_MIN=(.+)$/m.exec(configure)?.[1] ?? ''
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gotrue-image-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const choose = (stackImage: string, current = '') => {
    writeFileSync(join(dir, 'compose.yml'), `services:\n  auth:\n    image: ${stackImage}\n`)
    return lib(`GOTRUE_MIN=${min}\n${fn}\ngotrue_image_for '${join(dir, 'compose.yml')}' '${current}'`).out
  }

  it('is defined, with the minimum the overrides name', () => {
    expect(fn).not.toBe('')
    expect(readFileSync(join(SELF_HOST, 'supabase-overrides.yml'), 'utf8'))
      .toContain(`image: \${GOTRUE_IMAGE:-supabase/gotrue:v${min}}`)
  })

  it('raises an older stack to the minimum and never runs older than a newer stack', () => {
    expect(choose('supabase/gotrue:v2.177.0')).toBe(`supabase/gotrue:v${min}`)
    expect(choose('supabase/gotrue:v2.210.3')).toBe('supabase/gotrue:v2.210.3')
    expect(choose('supabase/auth:v3.0.0')).toBe(`supabase/gotrue:v${min}`)
  })

  it('keeps a newer image already set, and replaces an older one', () => {
    expect(choose('supabase/gotrue:v2.177.0', 'supabase/gotrue:v2.199.0')).toBe('supabase/gotrue:v2.199.0')
    expect(choose('supabase/gotrue:v2.210.0', 'supabase/gotrue:v2.199.0')).toBe('supabase/gotrue:v2.210.0')
    expect(choose('supabase/gotrue:v2.177.0', 'something/else:latest')).toBe(`supabase/gotrue:v${min}`)
  })
})

describe('configure.sh and the built-in providers', () => {
  const ref = /^SUPABASE_REF_DEFAULT=(.+)$/m.exec(readFileSync(join(SELF_HOST, 'configure.sh'), 'utf8'))?.[1] ?? ''
  let root: string
  let sbEnv: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-configure-'))
    const sb = join(root, 'self-host', 'supabase')
    mkdirSync(sb, { recursive: true })
    mkdirSync(join(root, 'bin'))
    for (const f of ['configure.sh', 'linking.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    writeFileSync(join(root, 'bin', 'docker'), '#!/usr/bin/env bash\n[ "$*" != "compose version --short" ] || echo 2.30.0\n')
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    writeFileSync(join(sb, 'docker-compose.yml'), 'services:\n  auth:\n    image: supabase/gotrue:v2.196.0\n')
    writeFileSync(join(sb, '.env.example'), 'ENABLE_EMAIL_AUTOCONFIRM=false\n')
    writeFileSync(join(sb, '.harmony-supabase-ref'), `${ref}\n`)
    sbEnv = join(sb, '.env')
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
      HARMONY_VOICE: 'n',
      HARMONY_BOTS: 'n',
      HARMONY_REGISTRATION: 'open',
      ...extra,
    },
  })
  const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(sbEnv, 'utf8'))?.[1]
  const SMTP = { HARMONY_SMTP_HOST: 'smtp.chat.test', HARMONY_SMTP_USER: 'harmony', HARMONY_SMTP_PASS: 'p4ss' }

  it('keeps each built-in provider apart on an install without SMTP, once', () => {
    writeFileSync(sbEnv, 'ENABLE_EMAIL_AUTOCONFIRM=true\nPROVIDER_LINKING_DOMAINS=custom:a=custom:a\n')
    let r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value('PROVIDER_LINKING_DOMAINS')).toBe('custom:a=custom:a,github=github,google=google,twitch=twitch')
    expect(r.stdout).toContain('PROVIDER_LINKING_DOMAINS=custom:a=custom:a,github=github')
    r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value('PROVIDER_LINKING_DOMAINS')).toBe('custom:a=custom:a,github=github,google=google,twitch=twitch')
    expect(r.stdout).not.toContain('PROVIDER_LINKING_DOMAINS')
  })

  it('leaves a pair present, a provider set to default included', () => {
    writeFileSync(sbEnv, 'ENABLE_EMAIL_AUTOCONFIRM=true\nPROVIDER_LINKING_DOMAINS=google=default,twitch=social\n')
    expect(configure().status).toBe(0)
    expect(value('PROVIDER_LINKING_DOMAINS')).toBe('google=default,twitch=social,github=github')
  })

  it('keeps them apart on the run that configures SMTP: earlier accounts never proved their address', () => {
    writeFileSync(sbEnv, 'ENABLE_EMAIL_AUTOCONFIRM=true\n')
    const r = configure(SMTP)
    expect(r.status, r.stderr).toBe(0)
    expect(value('ENABLE_EMAIL_AUTOCONFIRM')).toBe('false')
    expect(value('PROVIDER_LINKING_DOMAINS')).toBe('github=github,google=google,twitch=twitch')
  })

  it('keeps them apart on a new install without SMTP, not on one with it', () => {
    expect(configure().status).toBe(0)
    expect(value('ENABLE_EMAIL_AUTOCONFIRM')).toBe('true')
    expect(value('PROVIDER_LINKING_DOMAINS')).toBe('github=github,google=google,twitch=twitch')

    rmSync(sbEnv)
    expect(configure(SMTP).status).toBe(0)
    expect(value('ENABLE_EMAIL_AUTOCONFIRM')).toBe('false')
    expect(value('PROVIDER_LINKING_DOMAINS')).toBeUndefined()
  })

  it('control: an install that confirms addresses by email keeps linking by verified address', () => {
    writeFileSync(sbEnv, 'SMTP_HOST=smtp.chat.test\nENABLE_EMAIL_AUTOCONFIRM=false\nPROVIDER_LINKING_DOMAINS=custom:a=custom:a\n')
    let r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value('PROVIDER_LINKING_DOMAINS')).toBe('custom:a=custom:a')
    r = configure(SMTP)
    expect(r.status, r.stderr).toBe(0)
    expect(value('PROVIDER_LINKING_DOMAINS')).toBe('custom:a=custom:a')
  })

  it('leaves a value GoTrue cannot parse as it is, and says so', () => {
    writeFileSync(sbEnv, 'ENABLE_EMAIL_AUTOCONFIRM=true\nPROVIDER_LINKING_DOMAINS=custom:a\n')
    const r = configure()
    expect(r.status, r.stderr).toBe(0)
    expect(value('PROVIDER_LINKING_DOMAINS')).toBe('custom:a')
    expect(r.stderr).toContain('not kept apart')
  })
})

// Stand-in for docker as admin.sh and lib.sh call it. $FAKE_STATE/events gets one line per auth
// recreation and per provider write, with the linking value the running auth service has;
// $FAKE_STATE/auth_extra holds the rest of its environment.
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
state="$FAKE_STATE"
printf '%s\n' "$*" >> "$state/calls"
case "$1" in
compose)
	case "$2" in
	ps) printf 'fake-%s\n' "${"$"}{@: -1}" ;;
	up)
		v="$(sed -n 's/^PROVIDER_LINKING_DOMAINS=//p' supabase/.env | head -1)"
		printf '%s' "$v" > "$state/auth_env"
		printf 'recreate auth=%s\n' "$v" >> "$state/events" ;;
	esac ;;
inspect)
	case "$*" in
	*State.Health*) echo healthy ;;
	*Config.Env*)
		printf 'GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS=%s\n' "$(cat "$state/auth_env" 2>/dev/null)"
		cat "$state/auth_extra" 2>/dev/null || true ;;
	esac ;;
exec)
	prog="$(cat)"
	running="$(cat "$state/auth_env" 2>/dev/null)"
	params="$(printf '%s' "$prog" | sed -n 's/^const PARAMS_B64 = "\(.*\)";$/\1/p' | base64 -d)"
	id="$(printf '%s' "$params" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | base64 -d)"
	touch "$state/providers"
	case "$prog" in
	*'exists: (await gotrueProviders()).some'*)
		if grep -qxF "$id" "$state/providers"; then e=true; else e=false; fi
		echo "{\"ok\":true,\"exists\":$e}" ;;
	*'const existing = (await gotrueProviders()).find'*)
		printf 'add %s auth=%s\n' "$id" "$running" >> "$state/events"
		if grep -qxF "$id" "$state/providers"; then c=false; else c=true; echo "$id" >> "$state/providers"; fi
		echo "{\"ok\":true,\"id\":\"$id\",\"name\":\"Authentik\",\"type\":\"oidc\",\"created\":$c}" ;;
	*'const known = (await gotrueProviders()).some'*)
		printf 'remove %s auth=%s\n' "$id" "$running" >> "$state/events"
		if grep -qxF "$id" "$state/providers"; then
			r=true; grep -vxF "$id" "$state/providers" > "$state/p2" || true; mv "$state/p2" "$state/providers"
		else r=false; fi
		echo "{\"ok\":true,\"id\":\"$id\",\"removed\":$r,\"unlisted\":$r}" ;;
	*'const rows = providers.map'*)
		rows="$(while read -r p; do [ -n "$p" ] && printf '%s\tName\toidc\tshown\thttps://idp.test/\n' "$p"; done < "$state/providers")"
		echo "{\"ok\":true,\"rows\":\"$(printf '%s' "$rows" | base64 | tr -d '\n')\",\"stale\":\"\"}" ;;
	esac ;;
esac
`

describe('harmony auth and account linking', () => {
  let root: string
  let state: string
  let sbEnv: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harmony-auth-'))
    state = join(root, 'state')
    mkdirSync(state)
    mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, 'self-host', 'supabase'), { recursive: true })
    for (const f of ['admin.sh', 'lib.sh', 'linking.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
    writeFileSync(join(root, 'bin', 'docker'), FAKE_DOCKER)
    chmodSync(join(root, 'bin', 'docker'), 0o755)
    sbEnv = join(root, 'self-host', 'supabase', '.env')
    writeFileSync(sbEnv, 'API_EXTERNAL_URL=https://db.chat.test\nENABLE_EMAIL_AUTOCONFIRM=true\nPROVIDER_LINKING_DOMAINS=custom:other=staff\n')
    writeFileSync(join(state, 'auth_env'), 'custom:other=staff')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const harmony = (...args: string[]) => spawnSync('bash', [join(root, 'self-host', 'admin.sh'), 'auth', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      FAKE_STATE: state,
      HARMONY_NONINTERACTIVE: '1',
      HARMONY_OAUTH_CLIENT_SECRET: 's3cret',
    },
  })
  const add = (...extra: string[]) =>
    harmony('add-provider', 'authentik', '--name', 'Authentik', '--issuer', 'https://idp.test/', '--client-id', 'c1', ...extra)
  const linking = () => /^PROVIDER_LINKING_DOMAINS=(.*)$/m.exec(readFileSync(sbEnv, 'utf8'))?.[1]
  const events = () => { try { return readFileSync(join(state, 'events'), 'utf8').trim().split('\n') } catch { return [] } }
  const setAutoconfirm = (on: boolean) =>
    writeFileSync(sbEnv, readFileSync(sbEnv, 'utf8').replace(/^ENABLE_EMAIL_AUTOCONFIRM=.*$/m, `ENABLE_EMAIL_AUTOCONFIRM=${on}`))

  it('keeps a new provider apart, and the auth service has the pair before the provider exists', () => {
    const r = add()
    expect(r.status, r.stderr).toBe(0)
    expect(linking()).toBe('custom:other=staff,custom:authentik=custom:authentik')
    expect(events()).toEqual([
      'recreate auth=custom:other=staff,custom:authentik=custom:authentik',
      'add custom:authentik auth=custom:other=staff,custom:authentik=custom:authentik',
    ])
    expect(r.stdout).toContain('kept apart')
  })

  it('adds no duplicate and recreates nothing on an update', () => {
    expect(add().status).toBe(0)
    expect(add().status).toBe(0)
    expect(linking()).toBe('custom:other=staff,custom:authentik=custom:authentik')
    expect(events().filter((e) => e.startsWith('recreate'))).toHaveLength(1)
  })

  it('refuses --link-existing-accounts while addresses are confirmed automatically, changing nothing', () => {
    const r = add('--link-existing-accounts')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('ENABLE_EMAIL_AUTOCONFIRM=true')
    expect(linking()).toBe('custom:other=staff')
    expect(events()).toEqual([])
  })

  it('links with --provider-verifies-email under automatic confirmation, and with SMTP alone', () => {
    let r = add('--link-existing-accounts', '--provider-verifies-email')
    expect(r.status, r.stderr).toBe(0)
    expect(linking()).toBe('custom:other=staff')
    expect(events()).toEqual(['add custom:authentik auth=custom:other=staff'])
    expect(r.stderr).toContain('counts as verified')

    expect(add('--separate-accounts').status).toBe(0)
    expect(linking()).toBe('custom:other=staff,custom:authentik=custom:authentik')
    setAutoconfirm(false)
    r = add('--link-existing-accounts')
    expect(r.status, r.stderr).toBe(0)
    expect(linking()).toBe('custom:other=staff')
  })

  it('keeps a linked provider linked on an update without an option', () => {
    setAutoconfirm(false)
    expect(add('--link-existing-accounts').status).toBe(0)
    expect(add().status).toBe(0)
    expect(linking()).toBe('custom:other=staff')
    expect(events().filter((e) => e.startsWith('recreate'))).toEqual([])
  })

  it('refuses --provider-verifies-email alone and both account options together', () => {
    expect(add('--provider-verifies-email').status).not.toBe(0)
    expect(add('--separate-accounts', '--link-existing-accounts').status).not.toBe(0)
    expect(events()).toEqual([])
  })

  it('stops before any change when PROVIDER_LINKING_DOMAINS does not parse', () => {
    writeFileSync(sbEnv, readFileSync(sbEnv, 'utf8').replace(/^PROVIDER_LINKING_DOMAINS=.*$/m, 'PROVIDER_LINKING_DOMAINS=custom:other'))
    const r = add()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('provider=domain')
    expect(events()).toEqual([])
  })

  it('removes the provider while its pair still holds, then drops the pair', () => {
    expect(add().status).toBe(0)
    const r = harmony('remove-provider', 'authentik')
    expect(r.status, r.stderr).toBe(0)
    expect(linking()).toBe('custom:other=staff')
    expect(events().slice(-2)).toEqual([
      'remove custom:authentik auth=custom:other=staff,custom:authentik=custom:authentik',
      'recreate auth=custom:other=staff',
    ])
  })

  it('lists each provider with its mode and warns about one linking by address under automatic confirmation', () => {
    writeFileSync(join(state, 'providers'), 'custom:authentik\ncustom:open\n')
    writeFileSync(sbEnv, readFileSync(sbEnv, 'utf8').replace(/^PROVIDER_LINKING_DOMAINS=.*$/m,
      'PROVIDER_LINKING_DOMAINS=custom:authentik=custom:authentik,custom:gone=custom:gone'))
    const r = harmony('providers')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/custom:authentik\s+Name\s+oidc\s+shown\s+separate/)
    expect(r.stdout).toMatch(/custom:open\s+Name\s+oidc\s+shown\s+by address/)
    expect(r.stderr).toContain('custom:open join existing accounts by address')
    expect(r.stdout).toContain('custom:gone')
  })

  it('keeps a built-in provider apart, and links it only once its addresses can be trusted', () => {
    let r = harmony('linking', 'google', '--separate-accounts')
    expect(r.status, r.stderr).toBe(0)
    expect(linking()).toBe('custom:other=staff,google=google')
    expect(events()).toEqual(['recreate auth=custom:other=staff,google=google'])
    expect(r.stdout).toContain('kept apart')
    expect(harmony('linking', 'google', '--separate-accounts').status).toBe(0)
    expect(events()).toHaveLength(1)

    r = harmony('linking', 'google', '--link-existing-accounts')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('ENABLE_EMAIL_AUTOCONFIRM=true')
    expect(linking()).toBe('custom:other=staff,google=google')

    r = harmony('linking', 'google', '--link-existing-accounts', '--provider-verifies-email')
    expect(r.status, r.stderr).toBe(0)
    expect(linking()).toBe('custom:other=staff,google=default')
    expect(events().at(-1)).toBe('recreate auth=custom:other=staff,google=default')
  })

  it('never links GitHub under automatic confirmation; with SMTP it does', () => {
    let r = harmony('linking', 'github', '--link-existing-accounts', '--provider-verifies-email')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('unverified ones included')
    expect(events()).toEqual([])
    setAutoconfirm(false)
    r = harmony('linking', 'github', '--link-existing-accounts')
    expect(r.status, r.stderr).toBe(0)
    expect(linking()).toBe('custom:other=staff,github=default')
  })

  it('refuses a provider GoTrue lacks or no mode, and points a custom provider at add-provider', () => {
    expect(harmony('linking', 'myspace', '--separate-accounts').status).not.toBe(0)
    expect(harmony('linking', 'github').status).not.toBe(0)
    const r = harmony('linking', 'custom:authentik', '--separate-accounts')
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('add-provider authentik')
    expect(events()).toEqual([])
  })

  it('lists the built-in providers and any other on, and warns about one on that links by address', () => {
    writeFileSync(sbEnv, readFileSync(sbEnv, 'utf8').replace(/^PROVIDER_LINKING_DOMAINS=.*$/m,
      'PROVIDER_LINKING_DOMAINS=custom:other=staff,github=github'))
    writeFileSync(join(state, 'auth_env'), 'custom:other=staff,github=github')
    writeFileSync(join(state, 'auth_extra'),
      'GOTRUE_EXTERNAL_GITHUB_ENABLED=true\nGOTRUE_EXTERNAL_DISCORD_ENABLED=true\nGOTRUE_EXTERNAL_TWITCH_ENABLED=false\n')
    let r = harmony('providers')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/github\s+on\s+separate/)
    expect(r.stdout).toMatch(/google\s+off\s+by address/)
    expect(r.stdout).toMatch(/twitch\s+off\s+by address/)
    expect(r.stdout).toMatch(/discord\s+on\s+by address/)
    expect(r.stderr).toContain('discord join existing accounts by address')
    expect(r.stderr).not.toMatch(/github|google|twitch/)

    setAutoconfirm(false)
    r = harmony('providers')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/discord\s+on\s+by address/)
    expect(r.stderr).not.toContain('join existing accounts')
  })
})

describe('doctor.sh check_auth_linking', () => {
  const doctor = readFileSync(join(SELF_HOST, 'doctor.sh'), 'utf8')
  const fn = /^check_auth_linking\(\) \{\n[\s\S]*?\n\}\n/m.exec(doctor)?.[0] ?? ''
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'doctor-linking-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // One report per line: LEVEL|detail|fix. AUTH is the running auth service's environment, empty
  // when it is not running; CUSTOM the ids of instance_config.custom_oauth_providers.
  const check = (sbEnv: string, auth: string, custom = '') => {
    writeFileSync(join(dir, 'sb.env'), sbEnv)
    writeFileSync(join(dir, 'auth.env'), auth)
    writeFileSync(join(dir, 'custom'), custom)
    const r = lib(`SB_ENV='${join(dir, 'sb.env')}'
report() { printf '%s|%s|%s\\n' "$1" "$3" "\${4:-}"; }
auth_env() { cat '${join(dir, 'auth.env')}'; }
db_ready() { true; }
db_sql() { cat '${join(dir, 'custom')}'; }
${fn}
check_auth_linking`)
    expect(r.status).toBe(0)
    return r.out.trim().split('\n').filter(Boolean)
  }
  const running = (linking: string, ...on: string[]) =>
    [`GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS=${linking}`, ...on.map((p) => `GOTRUE_EXTERNAL_${p}_ENABLED=true`)].join('\n') + '\n'

  it('is defined', () => expect(fn).not.toBe(''))

  it('warns about a built-in provider on that links by address under automatic confirmation', () => {
    const out = check('ENABLE_EMAIL_AUTOCONFIRM=true\n', running('', 'GITHUB'))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^WARN\|github join existing accounts by address/)
    expect(out[0]).toContain('harmony auth linking ID --separate-accounts')
  })

  it('counts a provider on without a sign-in button, and reads supabase/.env when auth is down', () => {
    expect(check('ENABLE_EMAIL_AUTOCONFIRM=true\nPROVIDER_LINKING_DOMAINS=github=github\n',
      running('github=github', 'GITHUB', 'DISCORD'))[0]).toMatch(/^WARN\|discord join/)
    expect(check('ENABLE_EMAIL_AUTOCONFIRM=true\nTWITCH_ENABLED=true\n', '')[0]).toMatch(/^WARN\|twitch join/)
  })

  it('warns about built-in and custom providers apart, each with its own fix', () => {
    const out = check('ENABLE_EMAIL_AUTOCONFIRM=true\n', running('', 'GOOGLE'), 'custom:authentik')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatch(/^WARN\|google join.*\|harmony auth linking/)
    expect(out[1]).toMatch(/^WARN\|custom:authentik join.*\|harmony auth add-provider/)
  })

  it('passes once each is apart, and says nothing without a provider on', () => {
    const v = 'github=github,google=google,twitch=twitch'
    expect(check(`ENABLE_EMAIL_AUTOCONFIRM=true\nPROVIDER_LINKING_DOMAINS=${v}\n`, running(v, 'GITHUB', 'GOOGLE')))
      .toEqual(['OK|your sign-in providers keep their accounts apart|'])
    expect(check('ENABLE_EMAIL_AUTOCONFIRM=true\n', running(''))).toEqual([])
  })

  it('control: with addresses confirmed by email, linking by address is fine', () => {
    expect(check('ENABLE_EMAIL_AUTOCONFIRM=false\n', running('', 'GITHUB'), 'custom:authentik'))
      .toEqual(['OK|github custom:authentik join existing accounts by verified address; the others are kept apart|'])
  })

  it('reports a running value older than supabase/.env before anything else', () => {
    expect(check('ENABLE_EMAIL_AUTOCONFIRM=true\nPROVIDER_LINKING_DOMAINS=github=github\n', running('', 'GITHUB')))
      .toEqual(['WARN|the auth service runs with an older PROVIDER_LINKING_DOMAINS than supabase/.env|docker compose up -d auth'])
  })
})

describe('the shell scripts parse', () => {
  it.each(['admin.sh', 'lib.sh', 'linking.sh', 'configure.sh', 'doctor.sh', 'update.sh', 'harmony'])('%s', (f) => {
    expect(() => execFileSync('bash', ['-n', join(SELF_HOST, f)])).not.toThrow()
  })
})
