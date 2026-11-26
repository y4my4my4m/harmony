/**
 * A self-host instance on a full disk: container logs without rotation (one instance's supabase-kong
 * log reached 4.5 GB of 16 GB), harmony backup filling what was left, Redis then unable to load its
 * append-only file, and the stack waiting on Redis. The scripts run against a stand-in `docker`
 * and `df`; scripts/check-self-host-stack.sh renders the real stack, and the Redis repair was run
 * against redis:7-alpine with a damaged incr and base file.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const SELF_HOST = resolve(__dirname, '../../self-host')
const GB = 1048576
const MB = 1024

type Logging = { driver?: string; options?: Record<string, string> }
type Dep = { condition?: string; required?: boolean }
type Service = { logging?: Logging; depends_on?: Record<string, Dep> | string[] }
const composeOf = (file: string) =>
  (parse(readFileSync(join(SELF_HOST, file), 'utf8'), { logLevel: 'error', merge: true }) as { services: Record<string, Service> }).services

// Services of supabase/supabase docker/docker-compose.yml at SUPABASE_REF_DEFAULT.
const UPSTREAM = ['studio', 'kong', 'auth', 'rest', 'realtime', 'storage', 'imgproxy', 'meta', 'functions', 'analytics', 'db', 'vector', 'supavisor']

describe('container logs in the compose files', () => {
  const harmony = composeOf('docker-compose.yml')
  const overrides = composeOf('supabase-overrides.yml')

  it.each([
    ...Object.keys(harmony).map((s) => ['docker-compose.yml', s] as const),
    ...Object.keys(overrides).map((s) => ['supabase-overrides.yml', s] as const),
  ])('%s %s rotates its json-file log: 20 MB and four compressed files', (file, name) => {
    const svc = (file === 'docker-compose.yml' ? harmony : overrides)[name]
    expect(svc.logging).toEqual({ driver: 'json-file', options: { 'max-size': '20m', 'max-file': '5', compress: 'true' } })
  })

  it('reaches every service of the pinned Supabase stack', () => {
    expect(Object.keys(overrides).sort()).toEqual([...UPSTREAM].sort())
  })

  it('starts the services that can run without Redis while Redis cannot', () => {
    for (const name of ['federation-server', 'federation-worker', 'livekit']) {
      expect((harmony[name].depends_on as Record<string, Dep>).redis).toEqual({ condition: 'service_healthy', required: false })
    }
    expect(harmony.caddy.depends_on).toEqual({
      web: { condition: 'service_started', required: false },
      'federation-server': { condition: 'service_started', required: false },
      'media-cache': { condition: 'service_started', required: false },
    })
    expect(overrides.db.depends_on).toEqual({ vector: { condition: 'service_healthy', required: false } })
  })
})

// Stand-in docker. State files in $FAKE_STATE: db (running|exited|restarting), redis (STATE/HEALTH),
// redis_after (state once redis is started again), aof_rc (redis-check-aof: 0 or 3), repair
// (fixed|emptied|copy failed), ids and inspect (container_logs), root (DockerRootDir), dump_bytes,
// dump_rc, dump_slow, dumpall_rc, storage_kb, rc.<compose command>.
const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
S="$FAKE_STATE"
printf '%s' "$*" | tr '\n\t' '  ' >> "$S/calls"; echo >> "$S/calls"
st() { if [ -f "$S/$1" ]; then cat "$S/$1"; else printf '%s' "$2"; fi; }
running() { case "$(st redis running/healthy)" in running/*) return 0 ;; esac; return 1; }
case "$*" in
'compose version'*) echo 2.30.0 ;;
'info -f'*) st root ''; echo ;;
'image inspect'*) exit 0 ;;
'compose ps -aq') st ids fake-db; echo ;;
'compose ps -a --format {{.Service}} {{.Image}}') echo 'redis redis:7-alpine' ;;
'compose ps -a --format {{.State}}/{{.Health}} redis') st redis running/healthy; echo ;;
'compose ps -a --format {{.State}} db') st db running; echo ;;
'compose ps -q --status running db') [ "$(st db running)" = running ] && echo fake-db; exit 0 ;;
'compose ps -q --status running redis') running && echo fake-redis; exit 0 ;;
'compose ps -q --status running '*) [ -e "$S/running.@{@: -1}" ] && echo "fake-@{@: -1}"; exit 0 ;;
'compose ps'*) ;;
'compose up -d --no-deps db') echo running > "$S/db" ;;
'compose stop db') echo exited > "$S/db" ;;
'compose stop redis') echo exited/ > "$S/redis" ;;
'compose up -d --no-deps redis') st redis_after running/healthy > "$S/redis.next"; mv "$S/redis.next" "$S/redis" ;;
'compose run '*'--fix'*) r="$(st repair fixed)"; echo "$r"; [ "$r" = "the copy failed: No space left on device" ] && exit 1; exit 0 ;;
'compose run '*redis-check-aof*) r="$(st aof_rc 0)"; [ "$r" = 3 ] && echo appendonly.aof.12.incr.aof; exit "$r" ;;
'compose '*) exit "$(st "rc.$2" 0)" ;;
'inspect -f {{index .Config.Labels'*) st inspect '' ;;
'inspect -f {{if .State.Health}}'*)
  if [ "@{@: -1}" = fake-db ]; then echo healthy; exit 0; fi
  s="$(st redis running/healthy)"; h="@{s#*/}"; echo "@{h:-running}" ;;
'inspect -f {{.Config.Image}}'*) echo supabase/postgres:15 ;;
'exec '*pg_isready*) [ "$(st db running)" = running ]; exit $? ;;
'exec '*'test -s'*) exit 1 ;;
'exec '*pg_dumpall*) echo roles; exit "$(st dumpall_rc 0)" ;;
'exec '*pg_dump*)
  if [ -e "$S/dump_slow" ]; then while :; do echo chunk; /bin/sleep 0.02; done; fi
  head -c "$(st dump_bytes 1000)" /dev/zero; exit "$(st dump_rc 0)" ;;
'exec '*psql*) echo 20261126500001 ;;
'run '*'--entrypoint du'*) echo "$(st storage_kb 0) /s" ;;
'run '*'--entrypoint tar'*) echo tarball ;;
esac
exit 0
`.replace(/@\{/g, '${')

// Stand-in df -Pk: $FAKE_STATE/df KiB available, or $FAKE_STATE/df_low once a partial dump has data.
const FAKE_DF = String.raw`#!/usr/bin/env bash
S="$FAKE_STATE"
avail="$(cat "$S/df" 2>/dev/null || echo 52428800)"
for f in "$S"/../self-host/backups/*/database.dump.partial; do
  [ -s "$f" ] && [ -f "$S/df_low" ] && avail="$(cat "$S/df_low")"
done
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo "/dev/root 16252928 15000000 $avail 97% /"
`

class Instance {
  root = mkdtempSync(join(tmpdir(), 'harmony-disk-'))
  selfHost = join(this.root, 'self-host')
  state = join(this.root, 'state')
  backups = join(this.selfHost, 'backups')
  dockerRoot = join(this.root, 'docker')

  constructor(files: string[]) {
    mkdirSync(this.selfHost)
    mkdirSync(this.state)
    mkdirSync(join(this.root, 'bin'))
    mkdirSync(join(this.selfHost, 'supabase', 'volumes', 'storage'), { recursive: true })
    for (const f of files) copyFileSync(join(SELF_HOST, f), join(this.selfHost, f))
    writeFileSync(join(this.selfHost, 'configure.sh'), 'exit 0\n')
    writeFileSync(join(this.selfHost, 'bootstrap.sh'), 'exit 0\n')
    writeFileSync(join(this.selfHost, '.env'), 'DOMAIN=chat.test\nHARMONY_VERSION=1.9.9\nENABLE_ANALYTICS=false\nENABLE_STUDIO=false\n')
    for (const [name, body] of [['docker', FAKE_DOCKER], ['df', FAKE_DF], ['sleep', '#!/bin/sh\nexit 0\n']]) {
      writeFileSync(join(this.root, 'bin', name), body)
      chmodSync(join(this.root, 'bin', name), 0o755)
    }
    this.set('root', this.dockerRoot)
  }

  set(key: string, value: string | number) {
    writeFileSync(join(this.state, key), String(value))
  }

  get(key: string) {
    return readFileSync(join(this.state, key), 'utf8').trim()
  }

  calls(): string[] {
    const f = join(this.state, 'calls')
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : []
  }

  backupDirs() {
    return existsSync(this.backups) ? readdirSync(this.backups).filter((n) => !n.startsWith('.')).sort() : []
  }

  /** A container log of SIZE bytes (sparse), listed for container_logs. */
  log(service: string, size: number, maxSize = '') {
    const id = `${service}-id`
    const path = join(this.dockerRoot, 'containers', id, `${id}-json.log`)
    mkdirSync(join(this.dockerRoot, 'containers', id), { recursive: true })
    writeFileSync(path, '')
    truncateSync(path, size)
    const ids = existsSync(join(this.state, 'ids')) ? this.get('ids').split('\n') : []
    this.set('ids', [...ids, id].join('\n'))
    const inspect = existsSync(join(this.state, 'inspect')) ? readFileSync(join(this.state, 'inspect'), 'utf8') : ''
    this.set('inspect', `${inspect}${service}|/${service === 'kong' ? 'supabase-kong' : `harmony-${service}`}|json-file|${maxSize}|${path}\n`)
    return path
  }

  run(script: string, args: string[], env: Record<string, string> = {}) {
    return spawnSync('bash', [join(this.selfHost, script), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(this.root, 'bin')}:${process.env.PATH}`, FAKE_STATE: this.state, HARMONY_NONINTERACTIVE: '1', ...env },
    })
  }

  dispose() {
    rmSync(this.root, { recursive: true, force: true })
  }
}

describe('harmony backup and free space', () => {
  let h: Instance
  beforeEach(() => {
    h = new Instance(['backup.sh', 'lib.sh', 'linking.sh', 'modes.sh'])
  })
  afterEach(() => h.dispose())

  const backup = (...args: string[]) => h.run('backup.sh', ['create', ...args])
  const seedDump = (name: string, bytes: number) => {
    mkdirSync(join(h.backups, name), { recursive: true })
    writeFileSync(join(h.backups, name, 'manifest'), 'contents=database,config\n')
    writeFileSync(join(h.backups, name, 'database.dump'), '')
    truncateSync(join(h.backups, name, 'database.dump'), bytes)
  }

  it('writes a backup with room to spare', () => {
    const r = backup()
    expect(r.status, r.stderr).toBe(0)
    expect(h.backupDirs()).toHaveLength(1)
    const dir = join(h.backups, h.backupDirs()[0])
    expect(readdirSync(dir).sort()).toEqual(['config.tar', 'database.dump', 'manifest', 'roles.sql', 'storage.tar'])
    expect(statSync(join(dir, 'database.dump')).mode & 0o777).toBe(0o600)
  })

  it('refuses below 1 GB free before it starts anything, and says where space comes from', () => {
    h.set('df', 900 * MB)
    h.set('db', 'exited')
    seedDump('20260101-000000-nightly', 1000)
    const r = backup()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('900 MB free on /; a backup leaves at least 1.0 GB free')
    expect(r.stderr).toContain('Nothing was written.')
    expect(r.stderr).toContain('harmony repair empties container logs over 100 MB')
    expect(r.stderr).toContain('oldest 20260101-000000-nightly')
    expect(h.calls().filter((c) => c.includes('up -d') || c.includes('pg_dump'))).toEqual([])
    expect(h.backupDirs()).toEqual(['20260101-000000-nightly'])
    expect(h.get('db')).toBe('exited')
  })

  it('refuses when the last dump and the uploads would not leave 1 GB, and offers --no-storage', () => {
    seedDump('20260101-000000', 2 * GB * 1024)
    h.set('storage_kb', 3 * GB)
    h.set('df', 5 * GB)
    const r = backup()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('the backup needs about 5.0 GB (database 2.0 GB, the size of the last dump; uploads 3.0 GB) and leaves 1.0 GB free; 5.0 GB is free on /')
    expect(r.stderr).toContain('--no-storage leaves the uploads out')
    expect(h.backupDirs()).toEqual(['20260101-000000'])
    expect(h.calls().some((c) => c.includes('pg_dump'))).toBe(false)

    const lean = backup('--no-storage')
    expect(lean.status, lean.stderr).toBe(0)
    expect(h.backupDirs()).toHaveLength(2)
  })

  it('stops a dump that brings free space below 1 GB and deletes the partial backup', () => {
    h.set('dump_slow', 1)
    h.set('df_low', 800 * MB)
    const r = backup()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('stopped: free space on / fell below 1.0 GB during the dump. The partial backup is deleted.')
    expect(h.backupDirs()).toEqual([])
  })

  it('deletes what it wrote when a later step fails', () => {
    h.set('dumpall_rc', 1)
    const r = backup()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('pg_dumpall --globals-only failed')
    expect(h.backupDirs()).toEqual([])
  })

  it('stops the database again when it started it and the backup fails', () => {
    h.set('db', 'exited')
    h.set('dump_rc', 1)
    const r = backup()
    expect(r.status).toBe(1)
    expect(h.calls()).toContain('compose up -d --no-deps db')
    expect(h.calls()).toContain('compose stop db')
    expect(h.get('db')).toBe('exited')
    expect(r.stdout).toContain('The database was not running before the backup; it is stopped again.')
    expect(h.backupDirs()).toEqual([])
  })

  it('leaves a database it found running alone when the backup fails', () => {
    h.set('dump_rc', 1)
    expect(backup().status).toBe(1)
    expect(h.calls()).not.toContain('compose stop db')
    expect(h.calls()).not.toContain('compose up -d --no-deps db')
    expect(existsSync(join(h.state, 'db'))).toBe(false)
  })

  it('keeps the database it started running for what follows a backup that succeeds', () => {
    h.set('db', 'exited')
    expect(backup('--no-storage').status).toBe(0)
    expect(h.get('db')).toBe('running')
  })

  it('names the full disk when Postgres does not start', () => {
    h.set('db', 'restarting')
    h.set('df', 2 * GB)
    mkdirSync(join(h.selfHost, 'supabase', 'volumes', 'db'), { recursive: true })
    // free_kb of supabase/volumes/db reads the same stand-in; a second df file is not needed: the
    // pre-check passes at 2 GB, then the database never answers and space is low.
    writeFileSync(join(h.root, 'bin', 'df'), FAKE_DF.replace('avail="$(cat "$S/df" 2>/dev/null || echo 52428800)"',
      'avail="$(cat "$S/df" 2>/dev/null)"; case "$*" in *volumes/db*) avail=10240 ;; esac'))
    const r = backup('--no-storage')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Postgres did not become ready within 240 s, with 10 MB free on /: Postgres cannot start on a full disk.')
    expect(h.calls()).not.toContain('compose up -d --no-deps db')
  })
})

describe('harmony update and disk space', () => {
  let h: Instance
  let oldCommit: string
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', h.root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()

  beforeEach(() => {
    h = new Instance(['update.sh', 'backup.sh', 'lib.sh', 'linking.sh', 'modes.sh'])
    writeFileSync(join(h.root, '.gitignore'), '*\n')
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'old')
    oldCommit = git('rev-parse', 'HEAD')
    git('commit', '-q', '--allow-empty', '-m', 'new')
  })
  afterEach(() => h.dispose())

  const update = (env: Record<string, string> = {}) => h.run('update.sh', ['--code-updated', oldCommit], env)

  it('empties container logs over 100 MB before it pulls images or writes a backup', () => {
    const kong = h.log('kong', 4608 * MB * 1024)
    const web = h.log('web', 30 * MB * 1024)
    const r = update()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Container logs over 100 MB emptied, 4.5 GB freed: supabase-kong 4.5 GB')
    expect(statSync(kong).size).toBe(0)
    expect(statSync(web).size).toBe(30 * MB * 1024)
    const c = h.calls()
    expect(c.findIndex((x) => x.startsWith('inspect -f {{index .Config.Labels'))).toBeLessThan(c.indexOf('compose pull'))
    expect(c.indexOf('compose pull')).toBeLessThan(c.findIndex((x) => x.includes('pg_dump ')))
    expect(r.stdout).toContain('Update complete (1.9.9).')
  })

  it('stops before pulling when less than 1 GB stays free', () => {
    h.set('df', 700 * MB)
    const r = update()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('700 MB free on /')
    expect(r.stderr).toContain('Update stopped during: space')
    expect(r.stderr).toContain('the database is unchanged')
    expect(h.calls()).not.toContain('compose pull')
    expect(h.backupDirs()).toEqual([])
  })

  it('repairs a Redis that cannot load its append-only file once the containers are recreated', () => {
    h.set('redis', 'restarting/')
    h.set('aof_rc', 3)
    h.set('running.federation-server', '')
    const r = update()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('Redis cannot load its append-only file: appendonly.aof.12.incr.aof is damaged')
    expect(r.stdout).toContain('Redis: the damaged append-only file is truncated at the damage')
    const c = h.calls()
    const up = c.indexOf('compose up -d')
    const stop = c.indexOf('compose stop redis')
    expect(up).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(up)
    expect(c.findIndex((x) => x.startsWith('compose run') && x.includes('--fix'))).toBeGreaterThan(stop)
    expect(c).toContain('compose up -d --no-deps redis')
    expect(c).toContain('compose restart federation-server')
    expect(h.get('redis')).toBe('running/healthy')
  })

  it('leaves a healthy Redis alone', () => {
    const r = update()
    expect(r.status, r.stderr).toBe(0)
    expect(h.calls().some((x) => x.startsWith('compose run') || x === 'compose stop redis')).toBe(false)
  })
})

describe('harmony repair', () => {
  let h: Instance
  beforeEach(() => {
    h = new Instance(['harmony', 'lib.sh', 'linking.sh', 'modes.sh'])
  })
  afterEach(() => h.dispose())

  const repair = (...args: string[]) => h.run('harmony', ['repair', ...args])

  it('empties big logs, repairs Redis and starts the stack', () => {
    const kong = h.log('kong', 4608 * MB * 1024)
    h.log('caddy', 5 * MB * 1024, '20m')
    h.set('redis', 'restarting/')
    h.set('aof_rc', 3)
    const r = repair()
    expect(r.status, r.stderr).toBe(0)
    expect(statSync(kong).size).toBe(0)
    expect(r.stdout).toContain('4.5 GB freed: supabase-kong 4.5 GB')
    expect(r.stdout).toContain('Redis: the damaged append-only file is truncated at the damage')
    expect(r.stdout).toContain('Then take a backup: harmony backup')
    const c = h.calls()
    expect(c.findIndex((x) => x.includes('--fix'))).toBeLessThan(c.indexOf('compose up -d'))
  })

  it('starts nothing while the disk stays full', () => {
    h.set('df', 300 * MB)
    h.set('redis', 'restarting/')
    h.set('aof_rc', 3)
    const r = repair()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('300 MB free on /')
    expect(r.stderr).toContain('free space first')
    expect(h.calls().some((x) => x.startsWith('compose up') || x.startsWith('compose run'))).toBe(false)
  })

  it('changes nothing in Redis when the copy of its file does not fit', () => {
    h.set('redis', 'restarting/')
    h.set('redis_after', 'restarting/')
    h.set('aof_rc', 3)
    h.set('repair', 'the copy failed: No space left on device')
    const r = repair()
    expect(r.stderr).toContain('Redis: its append-only file was not repaired, nothing changed: the copy failed: No space left on device')
  })

  it('starts Redis empty when its file cannot be mended, and says what is lost', () => {
    h.set('redis', 'exited/')
    h.set('aof_rc', 3)
    h.set('repair', 'emptied')
    const r = repair()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('Redis starts empty (queued federation deliveries, caches and presence are lost)')
  })

  it('reports an intact file of a Redis that is down for another reason', () => {
    h.set('redis', 'restarting/')
    h.set('redis_after', 'restarting/')
    const r = repair()
    expect(r.stderr).toContain('Redis is not healthy and its append-only file is intact: harmony logs redis')
    expect(h.calls().some((x) => x.includes('--fix'))).toBe(false)
  })

  it('takes no arguments and is in the help', () => {
    expect(repair('--force').status).toBe(1)
    expect(h.run('harmony', ['help']).stdout).toContain('harmony repair')
  })
})

describe('doctor.sh', () => {
  const doctor = readFileSync(join(SELF_HOST, 'doctor.sh'), 'utf8')
  const fnOf = (name: string) => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(doctor)?.[0] ?? ''

  /** One report per line: LEVEL|check|detail|fix. */
  const run = (body: string, env: Record<string, string> = {}) => {
    const r = spawnSync('bash', ['-c', `set -uo pipefail
source "${join(SELF_HOST, 'lib.sh')}"
report() { printf '%s|%s|%s|%s\\n' "$1" "$2" "$3" "\${4:-}"; }
section() { :; }
${body}`], { encoding: 'utf8', env: { ...process.env, ...env } })
    expect(r.stderr).toBe('')
    return r.stdout.trim()
  }

  describe('check_container_logs', () => {
    const logs = (lines: string[]) => run(`container_logs() { printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')}; }
${fnOf('check_container_logs')}
check_container_logs`)

    it('runs in the host checks', () => {
      expect(fnOf('check_container_logs')).not.toBe('')
      expect(doctor).toMatch(/^\tcheck_container_logs\n\tcheck_files$/m)
    })

    it('passes when every container rotates', () => {
      expect(logs(['kong\tsupabase-kong\t20m\t1000\t/l', 'web\tharmony-web\t-\t-\t-'])).toBe('OK|logs|all 2 containers rotate their logs|')
    })

    it('names the containers created before rotation', () => {
      expect(logs(['kong\tsupabase-kong\tnone\t1000\t/l', 'redis\tharmony-redis\tnone\t-\t/r', 'web\tharmony-web\t20m\t5\t/w'])).toBe(
        'WARN|log rotation|2 containers keep every log line, created before log rotation: kong redis|harmony update, or in self-host/: docker compose up -d (recreates them with rotation)',
      )
    })

    it('warns on a log past 100 MB and fails from 1 GB', () => {
      expect(logs([`kong\tsupabase-kong\t20m\t${200 * 1024 * 1024}\t/l`]).split('\n')[0]).toBe(
        'WARN|logs|200 MB in container logs over 100 MB: supabase-kong 200 MB|harmony repair (empties them)',
      )
      expect(logs([`kong\tsupabase-kong\tnone\t${4608 * 1024 * 1024}\t/l`]).split('\n')[0]).toBe(
        'FAIL|logs|4.5 GB in container logs over 100 MB: supabase-kong 4.5 GB|harmony repair (empties them)',
      )
    })

    it('says nothing without containers', () => {
      expect(logs([])).toBe('')
    })
  })

  describe('check_containers', () => {
    const containers = (redis: string, aof: number) => run(`compose() {
  case "$*" in
    'ps --all --format '*) printf 'db\\trunning\\thealthy\\nredis\\t%s\\t%s\\n' "\${REDIS%%/*}" "\${REDIS#*/}" ;;
    'config --services'*) printf 'db\\nredis\\n' ;;
  esac
}
svc_id() { :; }
redis_aof_check() { [ "$AOF" = 3 ] && echo appendonly.aof.12.incr.aof; return "$AOF"; }
${fnOf('check_containers')}
check_containers`, { REDIS: redis, AOF: String(aof) })

    it('names a damaged append-only file of a Redis that restarts', () => {
      const out = containers('restarting/', 3).split('\n')
      expect(out).toContain('FAIL|redis|restarting|docker compose up -d; then harmony logs redis')
      expect(out).toContain(
        'FAIL|redis file|Redis cannot load its append-only file: appendonly.aof.12.incr.aof is damaged, by a write cut short (a full disk, a crash)|harmony repair (truncates it at the damage and keeps the original beside it)',
      )
    })

    it('says nothing of the file of a Redis down for another reason, or a healthy one', () => {
      expect(containers('restarting/', 0)).not.toContain('redis file')
      expect(containers('running/healthy', 3)).toContain('OK|containers|all 2 services running')
      expect(containers('running/healthy', 3)).not.toContain('redis file')
    })
  })
})
