/**
 * Sign-up limits in the self-host stack. GoTrue's per-IP limiters and its before-user-created
 * hook read Sb-Forwarded-For (GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED, supabase/auth v2.197.0
 * internal/sbff). Caddy overwrites the header on the API host, because Kong forwards a
 * client's value unchanged. Behaviour by client network: scripts/check-caddyfile.sh.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(__dirname, '../..')
const overrides = parse(readFileSync(join(root, 'self-host/supabase-overrides.yml'), 'utf8')) as {
  services: Record<string, { environment?: Record<string, unknown> }>
}
const caddyfile = readFileSync(join(root, 'self-host/Caddyfile'), 'utf8')
const migration = readFileSync(join(root, 'db_schema/migrations/20261109100001_signup_limits.sql'), 'utf8')

describe('supabase-overrides.yml auth', () => {
  const env = overrides.services.auth?.environment ?? {}

  it('reads the client address from Sb-Forwarded-For', () => {
    expect(env.GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED).toBe('true')
  })

  it('lifts the instance-wide mail budget above the measured burst', () => {
    expect(String(env.GOTRUE_RATE_LIMIT_EMAIL_SENT)).toBe('${RATE_LIMIT_EMAIL_SENT:-100}')
  })

  it('calls the hook the migration defines', () => {
    expect(env.GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED).toBe('true')
    expect(env.GOTRUE_HOOK_BEFORE_USER_CREATED_URI).toBe(
      'pg-functions://postgres/public/before_user_created_hook',
    )
    expect(migration).toContain('FUNCTION public.before_user_created_hook(event jsonb)')
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.before_user_created_hook\(jsonb\) TO supabase_auth_admin/)
  })
})

describe('Caddyfile API host', () => {
  const dbSite = caddyfile.slice(caddyfile.indexOf('{$DB_DOMAIN} {'))

  it('overwrites the header on every route to Kong that reaches GoTrue', () => {
    const proxies = dbSite.match(/reverse_proxy supabase-kong:8000 \{[^}]*\}/g) ?? []
    expect(proxies).toHaveLength(3)
    expect(proxies[0]).toContain('header_up -Sb-Forwarded-For')
    expect(proxies[1]).toContain('header_up -Sb-Forwarded-For')
    expect(proxies[2]).toContain('header_up Sb-Forwarded-For {client_ip}')
    expect(dbSite).not.toMatch(/reverse_proxy supabase-kong:8000\s*\n/)
  })

  it('sends no address on a token refresh, where a 429 signs auth-js out', () => {
    expect(dbSite).toMatch(/@tokenRefresh \{\s+path \/auth\/v1\/token\s+expression \{http\.request\.uri\.query\} == "grant_type=refresh_token"/)
  })

  it('picks the rightmost untrusted X-Forwarded-For entry', () => {
    expect(caddyfile).toContain('trusted_proxies_strict')
  })

  it('needs no setting for a proxy on a private address or for Cloudflare', () => {
    expect(caddyfile).toMatch(/trusted_proxies static private_ranges \{\$CADDY_TRUSTED_PROXIES:\} 173\.245\.48\.0\/20/)
  })
})

describe('bootstrap.sh', () => {
  const bootstrap = readFileSync(join(root, 'self-host/bootstrap.sh'), 'utf8')

  it('leaves a function for the auth service before any migration can fail', () => {
    const stub = bootstrap.indexOf('CREATE FUNCTION public.before_user_created_hook(event jsonb)')
    expect(stub).toBeGreaterThan(-1)
    expect(stub).toBeLessThan(bootstrap.indexOf("SELECT version FROM supabase_migrations.schema_migrations"))
    expect(bootstrap).toContain('GRANT EXECUTE ON FUNCTION public.before_user_created_hook(jsonb) TO supabase_auth_admin')
  })
})

describe('doctor.sh check_signup_limits', () => {
  const doctor = readFileSync(join(root, 'self-host/doctor.sh'), 'utf8')
  const fn = /^check_signup_limits\(\) \{\n[\s\S]*?\n\}\n/m.exec(doctor)?.[0] ?? ''
  const ON = 'GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED=true\nGOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED=true'

  // One report per line: LEVEL|detail|fix.
  const check = (authEnv: string, sql: { fn?: string; ledger?: string; on?: string; enforce?: string; dbDown?: boolean } = {}) => {
    const r = spawnSync('bash', ['-c', `set -euo pipefail
${sql.dbDown ? 'DB_DOWN=1' : 'DB_DOWN='}
report() { printf '%s|%s|%s\\n' "$1" "$3" "\${4:-}"; }
auth_env() { printf '%b' '${authEnv.replace(/\n/g, '\\n')}'; }
db_ready() { \${DB_DOWN:+false} true; }
db_sql() {
  case "$*" in
    *to_regprocedure*) echo '${sql.fn ?? 't'}' ;;
    *signup_ledger*) echo '${sql.ledger ?? 't'}' ;;
    *signup_limits_enabled*) echo '${sql.on ?? 'true'}' ;;
    *signup_enforce_caps*) echo '${sql.enforce ?? 'false'}' ;;
  esac
}
${fn}
check_signup_limits`], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    return r.stdout.trim()
  }

  it('is defined and runs with the service checks', () => {
    expect(fn).not.toBe('')
    expect(doctor).toMatch(/^\tcheck_signup_limits$/m)
  })

  it('says nothing while the auth service or the database is down', () => {
    expect(check('')).toBe('')
    expect(check(ON, { fn: 'f', dbDown: true })).toBe('')
  })

  it('warns when the service lacks the hook or the header', () => {
    expect(check('GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED=true')).toMatch(/^WARN\|/)
    expect(check('GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED=true')).toMatch(/^WARN\|/)
  })

  it('fails when the service calls a function that does not exist', () => {
    expect(check(ON, { fn: 'f' })).toMatch(/^FAIL\|.*every sign-up fails\|bash bootstrap\.sh --migrations-only$/)
  })

  it('warns while the limits wait for their migration', () => {
    expect(check(ON, { ledger: 'f' })).toMatch(/^WARN\|sign-ups work, without limits/)
  })

  it('reports whether the caps observe or refuse, or that an admin turned the limits off', () => {
    expect(check(ON)).toBe('OK|hook on, network and domain caps observe|')
    expect(check(ON, { enforce: 'true' })).toBe('OK|hook on, network and domain caps refuse|')
    expect(check(ON, { on: 'false' })).toBe('OK|off (Admin, Invites)|')
  })
})
