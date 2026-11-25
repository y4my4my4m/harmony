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
import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
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

  // create_bot stores pgcrypto's digest; BotAuthMiddleware and WebSocketGateway hash the
  // presented token with node:crypto. The two must agree byte for byte.
  it('authenticates a token issued by create_bot under the hash the gateway computes', () => {
    const issued = sql(`
      BEGIN;
      SELECT set_config('request.jwt.claim.sub', '${OWNER_AUTH_ID}', true);
      SELECT set_config('request.jwt.claims', '{"sub":"${OWNER_AUTH_ID}"}', true);
      SELECT set_config('role', 'authenticated', true);
      SELECT public.create_bot('issuedbot')->>'token';
      COMMIT;
    `)
    expect(issued.ok, why(issued)).toBe(true)

    const token = issued.rows.flat().find((v) => /^harmony_bot_[0-9a-f]{64}$/.test(v))
    expect(token).toBeDefined()

    const hash = createHash('sha256').update(token!).digest('hex')
    const r = sql(`SELECT public.verify_bot_token('${hash}')::text`)
    expect(r.ok, why(r)).toBe(true)

    const verification = JSON.parse(r.rows[0][0])
    expect(verification.valid).toBe(true)
    expect(verification.username).toBe('issuedbot')
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

/** A failed call raised one of the contract's P0001 codes, not a schema error such as 42703. */
function raisedContractCode(r: SqlResult): boolean {
  return /ERROR:\s+P0001: [A-Z_]+/.test(why(r))
}

describe('bot command RPCs', () => {
  const weather = {
    name: 'weather',
    description: 'Weather',
    options: [{ type: 3, name: 'city', description: 'City', required: true }],
    required_permissions: ['BAN_MEMBERS'],
  }
  const json = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`

  it('replaces, upserts and lists slash commands with permission names', () => {
    const replaced = sql(`SELECT public.bot_commands_replace('${BOT_ID}', ${json([weather])})::text`)
    expect(replaced.ok, why(replaced)).toBe(true)
    const [stored] = JSON.parse(replaced.rows[0][0])
    expect(stored).toMatchObject({ name: 'weather', description: 'Weather', required_permissions: ['BAN_MEMBERS'] })

    const kept = sql(`SELECT public.bot_command_upsert('${BOT_ID}', ${json({ ...weather, description: 'Forecast' })})::text`)
    expect(kept.ok, why(kept)).toBe(true)
    expect(JSON.parse(kept.rows[0][0])).toMatchObject({ created: false, command: { id: stored.id, description: 'Forecast' } })

    const ping = { name: 'ping', description: 'Ping', options: [], required_permissions: [] }
    const created = sql(`SELECT public.bot_command_upsert('${BOT_ID}', ${json(ping)})::text`)
    expect(created.ok, why(created)).toBe(true)
    expect(JSON.parse(created.rows[0][0])).toMatchObject({ created: true, command: { name: 'ping' } })

    const listed = sql(`SELECT public.get_bot_commands('${BOT_ID}')::text`)
    expect(listed.ok, why(listed)).toBe(true)
    expect(JSON.parse(listed.rows[0][0]).map((c: { name: string }) => c.name)).toEqual(['ping', 'weather'])

    const cleared = sql(`SELECT public.bot_commands_replace('${BOT_ID}', '[]'::jsonb)::text`)
    expect(cleared.ok, why(cleared)).toBe(true)
    expect(JSON.parse(cleared.rows[0][0])).toEqual([])
  })

  it('refuses unknown permissions, duplicate names and a 101st command with their codes', () => {
    const unknown = sql(
      `SELECT public.bot_commands_replace('${BOT_ID}', ${json([{ ...weather, required_permissions: ['NOPE'] }])})`,
    )
    expect(why(unknown)).toMatch(/P0001: BOT_COMMAND_UNKNOWN_PERMISSION:NOPE/)

    const duplicate = sql(`SELECT public.bot_commands_replace('${BOT_ID}', ${json([weather, weather])})`)
    expect(why(duplicate)).toMatch(/P0001: BOT_COMMAND_DUPLICATE:weather/)

    const tooMany = sql(`
      SELECT public.bot_commands_replace('${BOT_ID}', (
        SELECT jsonb_agg(jsonb_build_object('name', 'c' || i, 'description', 'x',
                                            'options', '[]'::jsonb, 'required_permissions', '[]'::jsonb))
          FROM generate_series(1, 101) i))`)
    expect(why(tooMany)).toMatch(/P0001: BOT_COMMAND_LIMIT/)
  })
})

describe('bot interaction RPCs', () => {
  it('claims nothing for a bot without pending interactions', () => {
    const r = sql(`SELECT public.claim_bot_interactions(ARRAY['${BOT_ID}']::uuid[], 50)::text`)
    expect(r.ok, why(r)).toBe(true)
    expect(JSON.parse(r.rows[0][0])).toEqual([])
  })

  it('answers INTERACTION_UNKNOWN to an ack or a reply of an interaction that does not exist', () => {
    const ack = sql(`SELECT public.bot_interaction_ack('${BOT_ID}', gen_random_uuid(), false, false, NULL)`)
    expect(why(ack)).toMatch(/P0001: INTERACTION_UNKNOWN/)

    const reply = sql(
      `SELECT public.bot_interaction_reply('${BOT_ID}', gen_random_uuid(), 'original', false, '[{"type":"text","text":"x"}]'::jsonb)`,
    )
    expect(why(reply)).toMatch(/P0001: INTERACTION_UNKNOWN/)
  })

  it('runs record and fail for an interaction that does not exist', () => {
    for (const statement of [
      `SELECT public.bot_interaction_record('${BOT_ID}', gen_random_uuid(), NULL, 'failed')`,
      `SELECT public.bot_interaction_fail('${BOT_ID}', gen_random_uuid(), 'offline')`,
    ]) {
      const r = sql(statement)
      expect(r.ok || raisedContractCode(r), why(r)).toBe(true)
    }
  })
})

describe('bot_rate_limit_take', () => {
  // The interaction bucket's counter; it counts no 'overall' request.
  it('admits up to the limit and answers the seconds left after it', () => {
    const bucket = `interactions-contract-${Date.now()}`
    const first = sql(`SELECT public.bot_rate_limit_take('${BOT_ID}', '${bucket}', 1, 5)`)
    expect(first.ok, why(first)).toBe(true)
    expect(first.rows[0][0]).toBe('0')

    const second = sql(`SELECT public.bot_rate_limit_take('${BOT_ID}', '${bucket}', 1, 5)`)
    expect(second.ok, why(second)).toBe(true)
    expect(Number(second.rows[0][0])).toBeGreaterThan(0)

    const overall = sql(`SELECT count(*) FROM public.bot_rate_limits WHERE bot_id = '${BOT_ID}' AND bucket = 'overall'`)
    expect(overall.rows[0][0]).toBe('0')
  })
})

describe('check_and_increment_bot_rate_limit', () => {
  // Returns the seconds to wait; 0 admits.
  it('admits the first request in a window and refuses the next', () => {
    const bucket = `/api/v1/contract/${Date.now()}`
    const first = sql(
      `SELECT public.check_and_increment_bot_rate_limit('${BOT_ID}', '${bucket}', 1, 60)`,
    )
    expect(first.ok, why(first)).toBe(true)
    expect(first.rows[0][0]).toBe('0')

    const second = sql(
      `SELECT public.check_and_increment_bot_rate_limit('${BOT_ID}', '${bucket}', 1, 60)`,
    )
    expect(second.ok, why(second)).toBe(true)
    expect(Number(second.rows[0][0])).toBeGreaterThan(0)
  })
})

describe('bridge_import_server_emoji, two overlapping imports of one new Discord emoji', () => {
  const SERVER_ID = '00000000-0000-0000-0000-0000000000c0'
  const BRIDGE_BOT_ID = '00000000-0000-0000-0000-0000000000b1'
  const URL = `https://db.test/storage/v1/object/public/emojis/${SERVER_ID}/discord/777001.png`
  const LOCK = `hashtextextended('server_emojis:${SERVER_ID}', 0)`

  // The first import is a session that holds the per-server lock with its row inserted and
  // commits 3 s later. The second finds no row, waits on the lock, and must then answer the
  // committed row: an error here has the gateway delete the image both imports stored.
  it('answers existing to the import that waited, and keeps one row', async () => {
    const seeded = sql(`
      INSERT INTO public.servers (id, name, owner) VALUES ('${SERVER_ID}', 'Race', '${OWNER_PROFILE_ID}');
      INSERT INTO public.bots (id, owner_id, username, bot_type) VALUES ('${BRIDGE_BOT_ID}', '${OWNER_PROFILE_ID}', 'racebridge', 'bridge');
      INSERT INTO public.discord_bridges (server_id, bot_id, mode, discord_guild_id, created_by)
        VALUES ('${SERVER_ID}', '${BRIDGE_BOT_ID}', 'self', '900000000000000777', '${OWNER_PROFILE_ID}');
    `)
    expect(seeded.ok, why(seeded)).toBe(true)

    const first = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-q'])
    const firstDone = new Promise<number | null>((resolve) => first.on('close', resolve))
    first.stdin.end(`
      BEGIN;
      SELECT pg_advisory_xact_lock(${LOCK});
      INSERT INTO public.emojis (name, url, server_id, scope, discord_emoji_id)
        VALUES ('RaceMoji', '${URL}', '${SERVER_ID}', 'server', '777001');
      SELECT pg_sleep(3);
      COMMIT;
    `)

    let held = false
    for (let i = 0; i < 50 && !held; i++) {
      const lock = sql(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted
                           AND (classid::bigint << 32 | objid::bigint) = ${LOCK}`)
      held = lock.ok && lock.rows[0]?.[0] === '1'
      if (!held) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(held, 'the first import never took the lock').toBe(true)

    const second = sql(
      `SELECT status FROM public.bridge_import_server_emoji('${BRIDGE_BOT_ID}', '${SERVER_ID}', '777001', 'RaceMoji', '${URL}')`,
    )
    expect(await firstDone).toBe(0)
    expect(second.ok, why(second)).toBe(true)
    expect(second.rows[0]?.[0]).toBe('existing')

    const rows = sql(`SELECT count(*) FROM public.emojis WHERE server_id = '${SERVER_ID}' AND discord_emoji_id = '777001'`)
    expect(rows.rows[0]?.[0]).toBe('1')
  }, 60_000)
})

describe('bridge_upload_reserve, two overlapping claims of one server', () => {
  const SERVER_ID = '00000000-0000-0000-0000-0000000000c5'
  const CHANNEL_ID = '00000000-0000-0000-0000-0000000000c6'
  const LOCK = `hashtextextended('bridge_upload:${SERVER_ID}', 0)`
  const claim = (id: string) => `SELECT public.bridge_upload_reserve('${id}', '${CHANNEL_ID}', 600000)`

  // The first claim is a session that commits 3 s later. The second fits the cap (1 MB) alone and
  // not beside the first: it waits for the first and then reads its bytes.
  it('refuses the claim that waited, and holds one', async () => {
    const seeded = sql(`
      INSERT INTO public.servers (id, name, owner) VALUES ('${SERVER_ID}', 'Uploads', '${OWNER_PROFILE_ID}');
      INSERT INTO public.channels (id, server_id, name, type) VALUES ('${CHANNEL_ID}', '${SERVER_ID}', 'uploads', 0);
      UPDATE public.instance_config SET config_value = '1'::jsonb WHERE config_key = 'bridge_mirror_server_limit_mb';
    `)
    expect(seeded.ok, why(seeded)).toBe(true)

    const first = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-q'])
    const firstDone = new Promise<number | null>((resolve) => first.on('close', resolve))
    first.stdin.end(`
      BEGIN;
      ${claim('00000000-0000-0000-0000-00000000f001')};
      SELECT pg_sleep(3);
      COMMIT;
    `)

    let held = false
    for (let i = 0; i < 50 && !held; i++) {
      const lock = sql(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted
                           AND (classid::bigint << 32 | objid::bigint) = ${LOCK}`)
      held = lock.ok && lock.rows[0]?.[0] === '1'
      if (!held) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(held, 'the first claim never took the lock').toBe(true)

    const second = sql(claim('00000000-0000-0000-0000-00000000f002'))
    expect(await firstDone).toBe(0)
    expect(second.ok, why(second)).toBe(true)
    expect(second.rows[0]?.[0]).toBe('busy')
    expect(sql(`SELECT sum(bytes) FROM public.bridge_upload_reservations WHERE server_id = '${SERVER_ID}'`).rows[0]?.[0]).toBe('600000')

    sql(`SELECT public.bridge_upload_release('00000000-0000-0000-0000-00000000f001')`)
    expect(sql(claim('00000000-0000-0000-0000-00000000f002')).rows[0]?.[0]).toBe('reserved')
  }, 60_000)
})

describe('managed Matrix bridges', () => {
  const SERVERS = ['00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2']
  const CHANNELS = ['00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000d4']
  const ROOM = '!contract:example.org'
  let bridges: string[] = []

  /** Statements of the owner's client, each committed. */
  const asOwner = (statements: string) => `
    SELECT set_config('request.jwt.claim.sub', '${OWNER_AUTH_ID}', false);
    SELECT set_config('request.jwt.claims', '{"sub":"${OWNER_AUTH_ID}"}', false);
    SET ROLE authenticated;
    ${statements}`
  const pair = (bridge: number, room: string) =>
    `SELECT public.matrix_bridge_pair('${bridges[bridge]}', '${CHANNELS[bridge]}', '${room}') -> 'pairs' -> 0 ->> 'room_id';`

  /**
   * A session that runs `first`, holds its transaction for 3 s, runs `last` and commits. Resolves once
   * it holds, to a promise of its exit status (3 after an error).
   */
  async function holding(first: string, held: string, last = '') {
    const session = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'])
    const exit = new Promise<number | null>((resolve) => session.on('close', resolve))
    session.stdin.end(`BEGIN; ${first} SELECT pg_sleep(3); ${last} COMMIT;`)
    for (let i = 0; i < 50; i++) {
      const waiting = sql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(3)%' AND state = 'active'`)
      if (waiting.rows[0]?.[0] === '1') return { exit }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`${held} never held`)
  }

  beforeAll(() => {
    const seeded = sql(`
      INSERT INTO public.servers (id, name, owner) VALUES ('${SERVERS[0]}', 'Matrix A', '${OWNER_PROFILE_ID}'), ('${SERVERS[1]}', 'Matrix B', '${OWNER_PROFILE_ID}');
      INSERT INTO public.channels (id, server_id, name, type) VALUES ('${CHANNELS[0]}', '${SERVERS[0]}', 'general', 0), ('${CHANNELS[1]}', '${SERVERS[1]}', 'general', 0);
      ${asOwner(SERVERS.map((id) => `SELECT 'bridge=' || (public.matrix_bridge_create('${id}', 'self') ->> 'id');`).join('\n'))}`)
    expect(seeded.ok, why(seeded)).toBe(true)
    bridges = seeded.rows.flat().filter((v) => v.startsWith('bridge=')).map((v) => v.slice('bridge='.length))
    expect(bridges).toHaveLength(2)
  })

  it('runs every function the gateway calls', () => {
    const r = sql(`
      SELECT bot_id AS bot FROM public.matrix_bridges WHERE id = '${bridges[0]}' \\gset
      SELECT public.matrix_bridge_config(:'bot')::text;
      SELECT public.matrix_bridge_report_status(:'bot', 'account', '{"ready":true}', '{"rooms":[]}', '0.2.0', '[]')::text;
      SELECT public.matrix_bridge_redeem_code('MX-AAAA-BBBB-CCCC') IS NULL;`)
    expect(r.ok, why(r)).toBe(true)
    const member = sql(`SELECT count(*) FROM public.matrix_bridge_channel_member('${BOT_ID}', '${CHANNELS[0]}', '${OWNER_PROFILE_ID}')`)
    expect(why(member)).toMatch(/42501: Active Matrix binding required/)
    const check = sql(`SELECT public.matrix_bridge_send_check('${BOT_ID}', '${CHANNELS[0]}')::text, public.matrix_bridge_send_check('${BOT_ID}', '${CHANNELS[0]}', '${OWNER_PROFILE_ID}')::text`)
    expect(check.ok, why(check)).toBe(true)
    for (const answer of check.rows[0]) {
      expect(JSON.parse(answer)).toEqual({ platform: null, room_id: null, sender_mode: null, messages_encrypted: null, relay_allowed: null, member: null })
    }
    expect(JSON.parse(r.rows[0][0])).toMatchObject({ bridge_id: bridges[0], server_id: SERVERS[0], pairs: [], privacy_version: '0:0' })
    expect(JSON.parse(r.rows[1][0])).toEqual({ ok: true })
    expect(r.rows[2][0]).toBe('t')

    const host = sql(`
      SELECT count(*) FROM public.matrix_bridge_hosted_list();
      SELECT public.matrix_bridge_instance_hosted() IS NULL;
      SELECT public.matrix_bridge_link_room('ML-AAAA-BBBB-CCCC', '!a:example.org', '@sam:example.org') IS NULL;
      SELECT public.bridge_host_report(p_platform => 'discord') IS NULL;
      SELECT public.bridge_host_report(p_platform => 'matrix', p_version => '1', p_status => '{"hosted":0}') IS NULL;
      SELECT string_agg(platform, ',' ORDER BY platform) FROM public.bridge_hosts;`)
    expect(host.ok, why(host)).toBe(true)
    expect(host.rows.map((row) => row[0])).toEqual(['0', 't', 't', 'f', 'f', 'discord,matrix'])
  })

  it('a room two bridges bind at the same time has one channel', async () => {
    const named = sql(asOwner(pair(0, ROOM) + pair(1, ROOM)))
    expect(named.ok, why(named)).toBe(true)
    const bind = (bridge: number) => `SELECT public.matrix_bridge_bind_room(
      (SELECT bot_id FROM public.matrix_bridges WHERE id = '${bridges[bridge]}'), '${CHANNELS[bridge]}', '${ROOM}', 'relay');`
    const session = await holding(bind(0), 'the first bind')
    const second = sql(bind(1))
    expect(await session.exit).toBe(0)
    expect(why(second)).toMatch(/23505: The Matrix room is bound to another channel/)
    const rows = sql(`SELECT channel_id FROM public.bridge_channels WHERE room_id = '${ROOM}' AND room_bound`)
    expect(rows.rows).toEqual([[CHANNELS[0]]])
  }, 60_000)

  it('redeems a code once when two bridges present it at the same time', async () => {
    const issued = sql(asOwner(`SELECT 'code=' || (public.matrix_bridge_setup_code('${bridges[0]}') ->> 'code');`))
    const code = issued.rows.flat().find((v) => v.startsWith('code='))!.slice('code='.length)
    const session = await holding(`SELECT public.matrix_bridge_redeem_code('${code}') IS NOT NULL;`, 'the first redeem')
    const second = sql(`SELECT public.matrix_bridge_redeem_code('${code}') IS NULL`)
    expect(await session.exit).toBe(0)
    expect(second.ok, why(second)).toBe(true)
    expect(second.rows[0][0]).toBe('t')
    const tokens = sql(`SELECT count(*) FROM public.bot_tokens t JOIN public.matrix_bridges b ON b.bot_id = t.bot_id
                         WHERE b.id = '${bridges[0]}' AND t.is_active`)
    expect(tokens.rows[0][0]).toBe('1')
  }, 60_000)

  // The session locks and writes as matrix_bridge_setup_code: the bridge, then its codes.
  it('a redeem waits for a new code without a deadlock, and then redeems nothing', async () => {
    const issued = sql(asOwner(`SELECT 'code=' || (public.matrix_bridge_setup_code('${bridges[0]}') ->> 'code');`))
    const code = issued.rows.flat().find((v) => v.startsWith('code='))!.slice('code='.length)
    const session = await holding(`SELECT 1 FROM public.matrix_bridges WHERE id = '${bridges[0]}' FOR UPDATE;`, 'the new code',
      `DELETE FROM public.matrix_bridge_setup_codes WHERE bridge_id = '${bridges[0]}';`)
    const old = sql(`SELECT public.matrix_bridge_redeem_code('${code}') IS NULL`)
    expect(await session.exit).toBe(0)
    expect(old.ok, why(old)).toBe(true)
    expect(old.rows[0][0]).toBe('t')
  }, 60_000)

  it('a room bound while its pair is renamed is refused', async () => {
    const named = sql(asOwner(pair(1, '#old:example.org')))
    expect(named.ok, why(named)).toBe(true)
    const session = await holding(asOwner(pair(1, '#new:example.org')) + ' RESET ROLE;', 'the renaming')
    const bound = sql(`SELECT public.matrix_bridge_bind_room(
                         p_bot_id => (SELECT bot_id FROM public.matrix_bridges WHERE id = '${bridges[1]}'), p_channel_id => '${CHANNELS[1]}',
                         p_room_id => '!old:example.org', p_initial_sender_mode => 'relay', p_room_alias => '#old:example.org')`)
    expect(await session.exit).toBe(0)
    expect(why(bound)).toMatch(/22023: The pair names another Matrix room/)
    const row = sql(`SELECT room_alias, room_id IS NULL FROM public.bridge_channels WHERE channel_id = '${CHANNELS[1]}'`)
    expect(row.rows).toEqual([['#new:example.org', 't']])
  }, 60_000)

  // The session locks and writes as matrix_bridge_pair: the bridge, then the pair.
  it('binding a room waits for a pairing without a deadlock', async () => {
    const named = sql(asOwner(pair(1, '#kept:example.org')))
    expect(named.ok, why(named)).toBe(true)
    const session = await holding(`SELECT 1 FROM public.matrix_bridges WHERE id = '${bridges[1]}' FOR UPDATE;`, 'the pairing',
      `UPDATE public.bridge_channels SET direction = 'to_matrix' WHERE channel_id = '${CHANNELS[1]}';`)
    const bound = sql(`SELECT public.matrix_bridge_bind_room((SELECT bot_id FROM public.matrix_bridges WHERE id = '${bridges[1]}'),
                         '${CHANNELS[1]}', '!kept:example.org', 'relay', '#kept:example.org') ->> 'room_id'`)
    expect(await session.exit).toBe(0)
    expect(bound.ok, why(bound)).toBe(true)
    expect(bound.rows[0][0]).toBe('!kept:example.org')
  }, 60_000)

  describe('of the instance', () => {
    const LINKERS = ['00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000d6']
    const GENERAL = ['00000000-0000-0000-0000-0000000000d7', '00000000-0000-0000-0000-0000000000d8']
    let own: string[] = []

    const code = (bridge: number) => {
      const r = sql(asOwner(`SELECT 'code=' || (public.matrix_bridge_room_code('${own[bridge]}', '${GENERAL[bridge]}') ->> 'code');`))
      expect(r.ok, why(r)).toBe(true)
      return r.rows.flat().find((v) => v.startsWith('code='))!.slice('code='.length)
    }
    const link = (bridge: number, room: string) =>
      `SELECT public.matrix_bridge_link_room('${code(bridge)}', '${room}', '@sam:example.org') ->> 'channel_id';`
    const bound = (room: string) => sql(`SELECT channel_id FROM public.bridge_channels WHERE room_id = '${room}' AND room_bound`).rows

    beforeAll(() => {
      const seeded = sql(`
        INSERT INTO public.servers (id, name, owner) VALUES ('${LINKERS[0]}', 'Link A', '${OWNER_PROFILE_ID}'), ('${LINKERS[1]}', 'Link B', '${OWNER_PROFILE_ID}');
        INSERT INTO public.channels (id, server_id, name, type) VALUES ('${GENERAL[0]}', '${LINKERS[0]}', 'general', 0), ('${GENERAL[1]}', '${LINKERS[1]}', 'general', 0);
        UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'matrix_bridge_instance_enabled';
        INSERT INTO public.matrix_bridge_instance (connection, homeserver_url, access_token_secret)
          VALUES ('account', 'http://synapse:8008', vault.create_secret('syt_contract', NULL, 'contract'));
        ${asOwner(LINKERS.map((id) => `SELECT 'bridge=' || (public.matrix_bridge_create('${id}', 'instance') ->> 'id');`).join('\n'))}`)
      expect(seeded.ok, why(seeded)).toBe(true)
      own = seeded.rows.flat().filter((v) => v.startsWith('bridge=')).map((v) => v.slice('bridge='.length))
      expect(own).toHaveLength(2)
    })

    it('a room two codes link at the same time has one channel', async () => {
      const second = link(1, '!both:example.org')
      const session = await holding(link(0, '!both:example.org'), 'the first link')
      const r = sql(second)
      expect(await session.exit).toBe(0)
      expect(r.ok, why(r)).toBe(true)
      expect(r.rows[0][0]).toBe(GENERAL[1])
      expect(bound('!both:example.org')).toEqual([[GENERAL[1]]])
    }, 60_000)

    it('a code takes a room a bridge is binding at the same time', async () => {
      const named = sql(asOwner(pair(1, '!bound:example.org')))
      expect(named.ok, why(named)).toBe(true)
      const second = link(0, '!bound:example.org')
      const session = await holding(`SELECT public.matrix_bridge_bind_room((SELECT bot_id FROM public.matrix_bridges WHERE id = '${bridges[1]}'),
                                       '${CHANNELS[1]}', '!bound:example.org', 'relay');`, 'the bind')
      const r = sql(second)
      expect(await session.exit).toBe(0)
      expect(r.ok, why(r)).toBe(true)
      expect(bound('!bound:example.org')).toEqual([[GENERAL[0]]])
      expect(sql(`SELECT room_bound, state_error FROM public.bridge_channels WHERE channel_id = '${CHANNELS[1]}'`).rows).toEqual([['f', 'room_in_use']])
    }, 60_000)

    // The session locks the bridges in id order, as two rooms moving in opposite directions meet.
    it('two rooms moving between two bridges do not deadlock', async () => {
      const [first, last] = [...own].sort()
      const holder = own.indexOf(first)
      const taker = own.indexOf(last)
      const held = sql(link(holder, '!crossing:example.org'))
      expect(held.ok, why(held)).toBe(true)
      const moving = link(taker, '!crossing:example.org')
      const session = await holding(`SELECT 1 FROM public.matrix_bridges WHERE id = '${first}' FOR UPDATE;`, 'the other move',
        `SELECT 1 FROM public.matrix_bridges WHERE id = '${last}' FOR UPDATE;`)
      const r = sql(moving)
      expect(await session.exit).toBe(0)
      expect(r.ok, why(r)).toBe(true)
      expect(bound('!crossing:example.org')).toEqual([[GENERAL[taker]]])
    }, 60_000)
  })
})
