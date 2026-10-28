/**
 * self-host instance_config.storage_origin: bootstrap.sh writes https://DB_DOMAIN, the web app's
 * SUPABASE_URL (docker-compose.yml) and so the origin of every public object URL, on every run,
 * --migrations-only (update.sh) included; doctor.sh check_storage_origin warns when the database
 * holds another value or none.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SELF_HOST = resolve(__dirname, '../../self-host')
const bootstrap = readFileSync(join(SELF_HOST, 'bootstrap.sh'), 'utf8')
const doctor = readFileSync(join(SELF_HOST, 'doctor.sh'), 'utf8')
const compose = readFileSync(join(SELF_HOST, 'docker-compose.yml'), 'utf8')

const bash = (script: string) => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${script}`], { encoding: 'utf8' })
  return { out: r.stdout, status: r.status ?? -1 }
}

describe('bootstrap.sh storage_origin_for', () => {
  const fn = /^storage_origin_for\(\) \{\n[\s\S]*?\n\}\n/m.exec(bootstrap)?.[0] ?? ''
  const origin = (dbDomain: string, domain: string) => bash(`${fn}\nstorage_origin_for '${dbDomain}' '${domain}'`)

  it('is defined', () => expect(fn).not.toBe(''))

  it('is https://DB_DOMAIN, else https://db.DOMAIN, host lower-cased', () => {
    expect(origin('db.example.com', 'example.com').out).toBe('https://db.example.com\n')
    expect(origin('', 'Chat.Example.com').out).toBe('https://db.chat.example.com\n')
    expect(origin('API.example.net:8443', 'example.com').out).toBe('https://api.example.net:8443\n')
  })

  it('is empty, and succeeds, without a usable host', () => {
    expect(origin('', '')).toEqual({ out: '', status: 0 })
    expect(origin('evil.test/x', 'example.com')).toEqual({ out: '', status: 0 })
    expect(origin('user@evil.test', 'example.com')).toEqual({ out: '', status: 0 })
  })

  it('matches the SUPABASE_URL the web container receives', () => {
    expect(compose).toMatch(/^\s+SUPABASE_URL: https:\/\/\$\{DB_DOMAIN:-db\.\$\{DOMAIN\}\}$/m)
  })
})

describe('bootstrap.sh writes storage_origin', () => {
  const at = bootstrap.indexOf("VALUES ('storage_origin'")
  const block = bootstrap.slice(bootstrap.lastIndexOf('# --- storage origin', at), bootstrap.indexOf('\nfi\n', at))

  it('upserts the value only when it differs', () => {
    expect(at).toBeGreaterThan(0)
    expect(block).toContain('ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value')
    expect(block).toContain('WHERE instance_config.config_value IS DISTINCT FROM EXCLUDED.config_value')
  })

  it('runs with --migrations-only, as update.sh calls it, beside the upload ceiling', () => {
    expect(at).toBeGreaterThan(bootstrap.indexOf("VALUES ('upload_ceiling_bytes'"))
    expect(at).toBeLessThan(bootstrap.indexOf('if ! $MIGRATIONS_ONLY; then'))
    expect(readFileSync(join(SELF_HOST, 'update.sh'), 'utf8')).toContain('bootstrap.sh" --migrations-only')
  })
})

describe('doctor.sh check_storage_origin', () => {
  const fn = /^check_storage_origin\(\) \{\n[\s\S]*?\n\}\n/m.exec(doctor)?.[0] ?? ''
  // One report per line: LEVEL|check|detail|fix. STORED is instance_config.storage_origin.
  const check = (dbDomain: string, stored: string) => {
    const r = bash(`DB_DOMAIN='${dbDomain}'
report() { printf '%s|%s|%s|%s\\n' "$1" "$2" "$3" "\${4:-}"; }
db_sql() { printf '%s\\n' '${stored}'; }
${fn}
check_storage_origin`)
    expect(r.status).toBe(0)
    return r.out.trim().split('\n')
  }

  it('is defined and runs in the database checks', () => {
    expect(fn).not.toBe('')
    const database = /^check_database\(\) \{\n[\s\S]*?\n\}\n/m.exec(doctor)?.[0] ?? ''
    expect(database).toContain('\tcheck_storage_origin\n')
  })

  it('passes when the database holds https://DB_DOMAIN, case and a trailing slash aside', () => {
    expect(check('db.example.com', 'https://db.example.com')).toEqual(['OK|storage-origin|instance_config.storage_origin = https://db.example.com|'])
    expect(check('db.example.com', 'https://DB.example.com/')[0]).toMatch(/^OK\|/)
  })

  it('warns when it is empty, and when it names another origin', () => {
    const empty = check('db.example.com', '')
    expect(empty).toHaveLength(1)
    expect(empty[0]).toMatch(/^WARN\|storage-origin\|instance_config.storage_origin is empty.*\|bash bootstrap.sh --migrations-only$/)
    const other = check('db.example.com', 'https://db.old.example')
    expect(other[0]).toMatch(/^WARN\|storage-origin\|instance_config.storage_origin is https:\/\/db.old.example, files are served from https:\/\/db.example.com/)
  })
})

describe('the edited shell scripts parse', () => {
  it.each(['bootstrap.sh', 'doctor.sh', 'configure.sh'])('%s', (f) => {
    expect(() => execFileSync('bash', ['-n', join(SELF_HOST, f)])).not.toThrow()
  })
})
