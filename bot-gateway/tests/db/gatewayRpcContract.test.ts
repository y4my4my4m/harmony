/**
 * The bot gateway against a database built from db_schema/migrations/.
 *
 * plpgsql resolves column references at first execution, so a SECURITY DEFINER
 * function naming a column its table lacks installs cleanly and raises only when
 * called. Existence checks cannot see that; these tests call.
 *
 * Requires docker. Run with `npm run test:db`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GATEWAY_ROOT = path.resolve(__dirname, '../..')
const REPO_ROOT = path.resolve(GATEWAY_ROOT, '..')

const IMAGE = process.env.SUPABASE_PG_IMAGE ?? 'supabase/postgres:15.8.1.060'
const CONTAINER =
  process.env.BOT_GATEWAY_DB_CONTAINER ??
  `botgw-rpc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`

const OWNER_AUTH_ID = '00000000-0000-0000-0000-0000000000a0'
const OWNER_PROFILE_ID = '00000000-0000-0000-0000-0000000000a1'
const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const BOT_TOKEN = 'hrm_bot_contract_fixture'

// spawnSync blocks the event loop, so vitest's hookTimeout cannot interrupt a docker command
// that hangs - the job runs to its own timeout instead. The timeout here is the only bound.
const DOCKER_TIMEOUT_MS = 300_000

function docker(args: string[], input?: string) {
  const r = spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: DOCKER_TIMEOUT_MS,
  })
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} exceeded ${DOCKER_TIMEOUT_MS}ms`)
  }
  return r
}

interface SqlResult {
  ok: boolean
  rows: string[][]
  stderr: string
}

// SOH, ASCII 0x01. No value in these queries contains it.
const FIELD_SEP = '\u0001'

/** psql over the container's unix socket as postgres; VERBOSITY exposes the SQLSTATE. */
function sql(text: string): SqlResult {
  const r = docker(
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tA', '-F', FIELD_SEP],
    `\\set VERBOSITY verbose\n\\set ON_ERROR_STOP on\n${text}\n`,
  )
  const stderr = r.stderr ?? ''
  return {
    ok: r.status === 0 && !/^psql:.*ERROR:/m.test(stderr),
    rows: (r.stdout ?? '')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.split(FIELD_SEP)),
    stderr,
  }
}

/** First line of the postgres error, SQLSTATE included. */
function why(r: SqlResult): string {
  return (
    r.stderr
      .split('\n')
      .find((l) => l.includes('ERROR:'))
      ?.trim() ?? r.stderr.trim()
  )
}

function tsSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return tsSources(full)
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : []
  })
}

interface RpcCallSite {
  fn: string
  args: string[]
  where: string
}

/**
 * Every supabase.rpc() call in src/, with the argument names it passes.
 * Discovered rather than listed: a new call site is covered the day it lands.
 */
function rpcCallSites(): RpcCallSite[] {
  const sites: RpcCallSite[] = []
  for (const file of tsSources(path.join(GATEWAY_ROOT, 'src'))) {
    const source = readFileSync(file, 'utf8')
    const re = /\.rpc\(\s*'([a-z0-9_]+)'\s*(?:,\s*\{([^}]*)\})?/g
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const line = source.slice(0, m.index).split('\n').length
      sites.push({
        fn: m[1],
        args: [...(m[2] ?? '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((a) => a[1]),
        where: `${path.relative(REPO_ROOT, file)}:${line}`,
      })
    }
  }
  return sites
}

const CALL_SITES = rpcCallSites()

function waitForTcp(): void {
  // The unix socket accepts connections before the TCP listener binds. A schema
  // load started too early lands in a database nothing can reach.
  let consecutive = 0
  for (let i = 0; i < 180; i += 1) {
    const r = docker([
      'exec', CONTAINER, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres',
      '-tAc', 'select 1',
    ])
    consecutive = r.status === 0 ? consecutive + 1 : 0
    if (consecutive >= 5) return
    spawnSync('sleep', ['1'])
  }
  const logs = docker(['logs', '--tail', '40', CONTAINER])
  throw new Error(`postgres in ${CONTAINER} never accepted TCP:\n${logs.stdout}\n${logs.stderr}`)
}

function buildSchema(): void {
  docker(['exec', CONTAINER, 'rm', '-rf', '/db_schema'])
  const copied = docker(['cp', path.join(REPO_ROOT, 'db_schema'), `${CONTAINER}:/db_schema`])
  if (copied.status !== 0) throw new Error(`docker cp db_schema failed: ${copied.stderr}`)
  docker(['cp', path.join(REPO_ROOT, 'scripts/test-db/supabase-compat.sql'), `${CONTAINER}:/compat.sql`])

  // supabase_admin owns the realtime schema; postgres is not superuser in this image.
  docker([
    'exec', CONTAINER, 'psql', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', 'postgres', '-q',
    '-f', '/compat.sql',
  ])

  // The stub is created inside an exception-guarded DO block, so a privilege failure
  // leaves it absent instead of raising. Broadcast triggers abort every INSERT without it.
  const stub = sql(
    `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'realtime' AND p.proname = 'send'`,
  )
  if (stub.rows[0]?.[0] !== '1') throw new Error('realtime.send stub missing after compat')

  const init = docker([
    'exec', CONTAINER, 'sh', '-c',
    'set -e; for f in $(ls /db_schema/migrations/*.sql | LC_ALL=C sort); do ' +
    'psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done',
  ])
  if (init.status !== 0) {
    throw new Error(`schema load failed:\n${`${init.stdout}\n${init.stderr}`.slice(-4000)}`)
  }

  const built = sql(`SELECT to_regclass('public.bots') IS NOT NULL
                          AND to_regclass('public.bot_tokens') IS NOT NULL
                          AND to_regclass('public.emojis') IS NOT NULL`)
  if (built.rows[0]?.[0] !== 't') throw new Error(`init.sql produced no bot tables:\n${built.stderr}`)
}

function seed(): void {
  const r = sql(`
    INSERT INTO auth.users (id, email) VALUES ('${OWNER_AUTH_ID}', 'botowner@test.local');
    INSERT INTO public.profiles (id, auth_user_id, username, display_name)
      VALUES ('${OWNER_PROFILE_ID}', '${OWNER_AUTH_ID}', 'botowner', 'Bot Owner');
    INSERT INTO public.bots (id, owner_id, username) VALUES ('${BOT_ID}', '${OWNER_PROFILE_ID}', 'testbot');
    INSERT INTO public.bot_tokens (bot_id, token_hash, token_prefix, scopes)
      VALUES ('${BOT_ID}', encode(digest('${BOT_TOKEN}', 'sha256'), 'hex'), 'hrm_bot', ARRAY['bot']);
  `)
  if (!r.ok) throw new Error(`seed failed: ${why(r)}`)
}

beforeAll(() => {
  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
    throw new Error('docker is required for the bot-gateway database suite')
  }
  docker(['rm', '-f', CONTAINER])
  const run = docker(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=postgres', IMAGE])
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`)
  waitForTcp()
  buildSchema()
  seed()
})

afterAll(() => {
  docker(['rm', '-f', CONTAINER])
})

describe('RPC surface the gateway depends on', () => {
  // Guards the discovery regex: an empty result would make the next test vacuous.
  it('finds the call sites it is meant to check', () => {
    expect(CALL_SITES.length).toBeGreaterThan(0)
    expect(CALL_SITES.map((s) => s.fn)).toContain('verify_bot_token')
  })

  // PostgREST resolves overloads by argument name. A rename on either side answers
  // PGRST202 "function not found" at runtime and compiles fine on both.
  it('every rpc name and argument matches a function in the init schema', () => {
    const catalogue = new Map(
      sql(`SELECT p.proname, pg_get_function_arguments(p.oid)
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'`).rows.map((r) => [r[0], r[1]] as [string, string]),
    )

    const broken = CALL_SITES.flatMap((site) => {
      const signature = catalogue.get(site.fn)
      if (signature === undefined) return [`${site.where}: public.${site.fn} does not exist`]
      const declared = new Set(
        [...signature.matchAll(/(?:^|,\s*)([a-z_][a-z0-9_]*)\s+/g)].map((m) => m[1]),
      )
      return site.args
        .filter((a) => !declared.has(a))
        .map((a) => `${site.where}: public.${site.fn} has no argument ${a} (${signature})`)
    })

    expect(broken).toEqual([])
  })
})

describe('verify_bot_token', () => {
  // The body reads bot_tokens.is_active and writes bot_tokens.uses_count.
  // Production has both columns; db_schema/init/06_tables_misc.sql and staging
  // have neither.
  it('authenticates an active token', () => {
    const r = sql(
      `SELECT public.verify_bot_token(encode(digest('${BOT_TOKEN}', 'sha256'), 'hex'))::text`,
    )
    expect(r.ok, why(r)).toBe(true)

    const verification = JSON.parse(r.rows[0][0])
    expect(verification.valid).toBe(true)
    expect(verification.bot_id).toBe(BOT_ID)
    expect(verification.username).toBe('testbot')
    expect(verification.scopes).toEqual(['bot'])
  })

  it('reports an unknown token as invalid rather than raising', () => {
    const r = sql(`SELECT public.verify_bot_token('not-a-real-hash')::text`)
    expect(r.ok, why(r)).toBe(true)
    expect(JSON.parse(r.rows[0][0]).valid).toBe(false)
  })
})

describe('create_federated_emoji', () => {
  // RETURNS TABLE declares an OUT parameter named id, which shadows the column
  // in any unqualified reference: 42702 on every call.
  it('inserts and returns the row, crediting the bot owner as uploader', () => {
    const r = sql(
      `SELECT uploader::text, domain, scope, server_id IS NULL
         FROM public.create_federated_emoji('blobcat', 'https://remote.test/blobcat.png', '${BOT_ID}', 'remote.test')`,
    )
    expect(r.ok, why(r)).toBe(true)
    expect(r.rows[0]).toEqual([OWNER_PROFILE_ID, 'remote.test', 'instance', 't'])
  })
})

describe('check_and_increment_bot_rate_limit', () => {
  // Returns true when the request must be refused.
  it('admits the first request in a window and refuses the next', () => {
    const bucket = `/api/v1/contract/${Date.now()}`
    const first = sql(
      `SELECT public.check_and_increment_bot_rate_limit('${BOT_ID}', '${bucket}', 1, 60)`,
    )
    expect(first.ok, why(first)).toBe(true)
    expect(first.rows[0][0]).toBe('f')

    const second = sql(
      `SELECT public.check_and_increment_bot_rate_limit('${BOT_ID}', '${bucket}', 1, 60)`,
    )
    expect(second.ok, why(second)).toBe(true)
    expect(second.rows[0][0]).toBe('t')
  })
})
