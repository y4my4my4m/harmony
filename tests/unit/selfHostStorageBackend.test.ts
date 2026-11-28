/**
 * self-host uploads in an S3-compatible bucket: supabase-overrides.yml passes a STORAGE_S3_* key of
 * supabase/.env to the storage container only when it is set (scripts/check-self-host-stack.sh
 * renders it); doctor.sh check_storage_backend warns when storage runs with STORAGE_BACKEND=s3 and
 * the stack's own bucket name or without keys.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SELF_HOST = resolve(__dirname, '../../self-host')
const doctor = readFileSync(join(SELF_HOST, 'doctor.sh'), 'utf8')
const overrides = readFileSync(join(SELF_HOST, 'supabase-overrides.yml'), 'utf8')

describe('supabase-overrides.yml storage', () => {
  const storage = /^ {2}storage:\n[\s\S]*?(?=\n\n)/m.exec(overrides)?.[0] ?? ''

  it('names no endpoint, path style or key as a variable that is always passed', () => {
    for (const entry of ['STORAGE_BACKEND=${STORAGE_BACKEND:-file}', 'GLOBAL_S3_BUCKET=${STORAGE_S3_BUCKET:-stub}', 'REGION=${STORAGE_S3_REGION:-stub}']) {
      expect(storage.split('\n')).toContain(`      - ${entry}`)
    }
    for (const name of ['GLOBAL_S3_ENDPOINT', 'GLOBAL_S3_FORCE_PATH_STYLE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      expect(storage).not.toMatch(new RegExp(`^\\s+(?:- )?${name}\\s*[:=]`, 'm'))
    }
  })
})

describe('doctor.sh check_storage_backend', () => {
  const fn = /^check_storage_backend\(\) \{\n[\s\S]*?\n\}\n/m.exec(doctor)?.[0] ?? ''
  // One report per line: LEVEL|check|detail|fix. ENV is the storage container's environment.
  const check = (env: Record<string, string>, running = true) => {
    const cases = Object.entries(env).map(([name, value]) => `${name}) echo '${value}' ;;`).join(' ')
    const r = spawnSync('bash', ['-c', `set -uo pipefail
report() { printf '%s|%s|%s|%s\\n' "$1" "$2" "$3" "\${4:-}"; }
svc_id() { ${running ? 'echo storage-id' : 'true'}; }
docker() { case "$4" in ${cases} *) return 1 ;; esac; }
${fn}
check_storage_backend`], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    return r.stdout.trim()
  }
  const KEYS = { AWS_ACCESS_KEY_ID: 'key', AWS_SECRET_ACCESS_KEY: 'secret' }

  it('is defined and runs in the service checks', () => {
    expect(fn).not.toBe('')
    const services = /^check_services\(\) \{\n[\s\S]*?\n\}\n/m.exec(doctor)?.[0] ?? ''
    expect(services).toContain('\tcheck_storage_backend\n')
  })

  it('passes on the file backend, and says nothing while storage is down', () => {
    expect(check({ STORAGE_BACKEND: 'file', GLOBAL_S3_BUCKET: 'stub' })).toBe('OK|storage-backend|uploads are kept under supabase/volumes/storage|')
    expect(check({ STORAGE_BACKEND: 's3' }, false)).toBe('')
  })

  it('passes on a bucket with keys, under either name storage-api reads', () => {
    expect(check({ STORAGE_BACKEND: 's3', GLOBAL_S3_BUCKET: 'media', ...KEYS })).toBe('OK|storage-backend|uploads are kept in the bucket media|')
    expect(check({ STORAGE_BACKEND: 's3', STORAGE_S3_BUCKET: 'own', GLOBAL_S3_BUCKET: 'stub', ...KEYS })).toBe('OK|storage-backend|uploads are kept in the bucket own|')
  })

  it.each([
    [{ GLOBAL_S3_BUCKET: 'stub', ...KEYS }, 'bucket'],
    [{ ...KEYS }, 'bucket'],
    [{ GLOBAL_S3_BUCKET: 'media', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: 'secret' }, 'AWS_ACCESS_KEY_ID'],
    [{ GLOBAL_S3_BUCKET: 'stub' }, 'bucket, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY'],
  ])('warns on STORAGE_BACKEND=s3 with %j', (env, missing) => {
    expect(check({ STORAGE_BACKEND: 's3', ...env })).toMatch(
      new RegExp(`^WARN\\|storage-backend\\|storage runs with STORAGE_BACKEND=s3 and without ${missing}: .*\\|STORAGE_S3_BUCKET, .*docker compose up -d storage$`))
  })
})
