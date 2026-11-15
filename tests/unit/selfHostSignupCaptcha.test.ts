/**
 * harmony doctor's sign-up check line (self-host/doctor.sh check_signup_captcha). It reads the
 * signup_captcha_* keys and sends a dummy token to the provider through signup_captcha_check
 * (20261111100001), the path the hook's requests take. Cloudflare and hCaptcha answer a dummy token
 * with invalid-input-response under a working secret and invalid-input-secret under a wrong one.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const doctor = readFileSync(join(root, 'self-host/doctor.sh'), 'utf8')
const fn = /^check_signup_captcha\(\) \{\n[\s\S]*?\n\}\n/m.exec(doctor)?.[0] ?? ''

interface Db {
  dbDown?: boolean
  fn?: string
  config?: string
  http?: string
  probe?: string
  unverified?: string
}

/** One report per line: LEVEL|detail|fix. */
function check(db: Db = {}): string {
  const r = spawnSync('bash', ['-c', `set -euo pipefail
${db.dbDown ? 'DB_DOWN=1' : 'DB_DOWN='}
report() { printf '%s|%s|%s\\n' "$1" "$3" "\${4:-}"; }
db_ready() { \${DB_DOWN:+false} true; }
db_sql() {
  case "$*" in
    *harmony-doctor-probe*) printf '%s\\n' '${db.probe ?? 'fail|answer|invalid-input-response|'}' ;;
    *to_regprocedure*) echo '${db.fn ?? 't'}' ;;
    *pg_extension*) echo '${db.http ?? 't'}' ;;
    *signup_captcha_counts*) echo '${db.unverified ?? '0'}' ;;
    *signup_captcha_provider*) printf '%s\\n' '${db.config ?? 'turnstile|true|true'}' ;;
  esac
}
${fn}
check_signup_captcha`], { encoding: 'utf8' })
  expect(r.stderr).toBe('')
  expect(r.status).toBe(0)
  return r.stdout.trim()
}

describe('doctor.sh check_signup_captcha', () => {
  it('is defined and runs with the service checks, after the sign-up limits', () => {
    expect(fn).not.toBe('')
    expect(doctor).toMatch(/^\tcheck_signup_limits\n\tcheck_signup_captcha$/m)
  })

  it('says nothing while the database is down or before the migration', () => {
    expect(check({ dbDown: true })).toBe('')
    expect(check({ fn: 'f' })).toBe('')
  })

  it('reports off until a provider is set', () => {
    expect(check({ config: 'off|false|false' })).toBe('OK|off (Admin, Invites, Sign-up check)|')
    expect(check({ config: '' })).toBe('OK|off (Admin, Invites, Sign-up check)|')
  })

  it('warns when a provider is chosen without both keys', () => {
    expect(check({ config: 'turnstile|true|false' })).toMatch(/^WARN\|turnstile is chosen without both keys/)
    expect(check({ config: 'hcaptcha|false|true' })).toMatch(/^WARN\|hcaptcha is chosen without both keys/)
  })

  it('fails without the http extension', () => {
    expect(check({ http: 'f' })).toMatch(/^FAIL\|the database has no http extension/)
  })

  it('passes a secret the provider accepts', () => {
    expect(check()).toBe('OK|turnstile, secret key accepted by challenges.cloudflare.com|')
    expect(check({ config: 'hcaptcha|true|true' })).toBe('OK|hcaptcha, secret key accepted by api.hcaptcha.com|')
  })

  it('fails a refused secret and a database without egress, naming the host', () => {
    expect(check({ probe: 'error|answer|invalid-input-secret|' })).toMatch(
      /^FAIL\|challenges\.cloudflare\.com refuses the secret key.*\|Admin, Invites, Sign-up check: paste the secret key again/,
    )
    expect(check({ probe: 'error|network||Could not resolve host: challenges.cloudflare.com' })).toMatch(
      /^FAIL\|the database cannot reach challenges\.cloudflare\.com:443 \(Could not resolve host: challenges\.cloudflare\.com\)/,
    )
  })

  it('warns on a test key that passes any token, and on another answer', () => {
    expect(check({ probe: 'pass|answer||' })).toMatch(/^WARN\|the secret key passes any token/)
    expect(check({ probe: 'error|answer|internal-error|' })).toMatch(/^WARN\|challenges\.cloudflare\.com answered internal-error/)
  })

  it('warns when sign-ups were allowed unverified in the last 7 days', () => {
    const out = check({ unverified: '3' }).split('\n')
    expect(out).toHaveLength(2)
    expect(out[1]).toMatch(/^WARN\|3 asked sign-up\(s\) in 7 days were allowed unverified/)
  })
})
