/**
 * self-host account linking of custom sign-in providers (admin.sh auth, lib.sh linking_*) and the
 * auth image choice (configure.sh gotrue_image_for).
 *
 * GoTrue 2.196.0 puts a provider without a PROVIDER_LINKING_DOMAINS pair in the "default" domain,
 * where a first sign-in joins the existing account with the same address; with
 * ENABLE_EMAIL_AUTOCONFIRM=true every address counts as verified. admin.sh runs here against a
 * stand-in `docker` that records each auth recreation and each provider write with the linking
 * value the running auth service had at that moment.
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

// Stand-in for docker as admin.sh and lib.sh call it. $FAKE_STATE/events gets one line per auth
// recreation and per provider write, with the linking value the running auth service has.
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
	*Config.Env*) printf 'GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS=%s\n' "$(cat "$state/auth_env" 2>/dev/null)" ;;
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
    for (const f of ['admin.sh', 'lib.sh']) copyFileSync(join(SELF_HOST, f), join(root, 'self-host', f))
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
})

describe('the shell scripts parse', () => {
  it.each(['admin.sh', 'lib.sh', 'configure.sh', 'doctor.sh', 'update.sh', 'harmony'])('%s', (f) => {
    expect(() => execFileSync('bash', ['-n', join(SELF_HOST, f)])).not.toThrow()
  })
})
