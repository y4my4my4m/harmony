#!/usr/bin/env bash
# Times the pending migrations against seeded rows and records what each one locks.
#
# Builds a throwaway Postgres from a schema-only dump, seeds the tables the pending
# set touches, then applies the migrations one at a time. Per migration it records
# wall-clock duration, the heaviest lock mode seen in pg_locks for that backend and
# the relation it was held on, which tables changed relfilenode (a rewrite), and how
# long a concurrent writer was kept out.
#
# Nothing here connects to a live database; the two schema-only dumps are the input.
#
#   scripts/time-migrations.sh --scale 1
#   scripts/time-migrations.sh --scale 4 --variant staging
#   scripts/time-migrations.sh --render "$TMPDIR/migration-cost"
#
# --scale multiplies every count in seed_counts(). Scale 1 is 500k messages and
# 150k profiles. Every number the script emits belongs to the scale it ran at, so
# each output file names the scale it was taken at.
#
# Three passes per variant, each from the same seeded template:
#   quiet  - the migration is the only session; gives the duration column
#   loaded - one session per measured table takes ROW EXCLUSIVE (the mode every
#            INSERT, UPDATE and DELETE takes) in a loop and reports its longest
#            wait; that wait is how long the table was closed to writers
#   alt    - the blocking statement and its CONCURRENTLY rewrite, side by side
#
# Locks are captured two ways, and lock_src names which one produced the row. A
# ddl_command_end event trigger reads pg_locks for its own backend, where every
# lock the statement took is still held: exact, and it covers DDL only. A second
# session polls pg_locks filtered to the migration's pid every 2 ms, which covers
# the rest. block_ms is first-to-last sample, so it rounds down and a lock held
# for under one interval reads as empty rather than as absent.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGDIR="$ROOT/db_schema/migrations"

SCALE=1
VARIANTS="prod staging"
IMAGE="supabase/postgres:15.8.1.085"
CONTAINER="mcost-pg-$$"
PROD_DUMP="${PROD_DUMP:-$HOME/temp/schema-prod.sql}"
STAGING_DUMP="${STAGING_DUMP:-$HOME/temp/schema-staging.sql}"
OUTDIR="${TMPDIR:-/tmp}/migration-cost"
FIRST_PENDING="20260816000001"
PASSES="quiet loaded"
KEEP=0
RENDER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --scale)         SCALE="$2"; shift 2 ;;
    --variant)       VARIANTS="$2"; shift 2 ;;
    --passes)        PASSES="$2"; shift 2 ;;
    --image)         IMAGE="$2"; shift 2 ;;
    --container)     CONTAINER="$2"; shift 2 ;;
    --prod-dump)     PROD_DUMP="$2"; shift 2 ;;
    --staging-dump)  STAGING_DUMP="$2"; shift 2 ;;
    --out)           OUTDIR="$2"; shift 2 ;;
    --first-pending) FIRST_PENDING="$2"; shift 2 ;;
    --keep)          KEEP=1; shift ;;
    --render)        RENDER="$2"; shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# --render turns the TSVs into the markdown table. No database involved.
# ---------------------------------------------------------------------------
if [ -n "$RENDER" ]; then
  python3 - "$RENDER" <<'PY'
import csv, glob, os, sys
d = sys.argv[1]
runs, tags = {}, []
for f in sorted(glob.glob(os.path.join(d, 'timing-*.tsv'))):
    tag = os.path.basename(f)[len('timing-'):-len('.tsv')]
    tags.append(tag)
    with open(f) as fh:
        for r in csv.DictReader(fh, delimiter='\t'):
            runs.setdefault(r['version'], {})[tag] = r
quiet = [t for t in tags if not t.endswith('-loaded')]
load  = [t for t in tags if t.endswith('-loaded')]
hdr = ['migration'] + [t + ' ms' for t in quiet] + ['heaviest lock', 'rewrote', 'max writer stall ms']
print('| ' + ' | '.join(hdr) + ' |')
print('|' + '---|' * len(hdr))
for v in sorted(runs):
    row = runs[v]
    ref = next(iter(row.values()))
    lock = max((r.get('max_lock', '') for r in row.values()), key=len, default='')
    rel = next((r.get('lock_rel', '') for r in row.values() if r.get('max_lock') == lock), '')
    rewrote = next((r['rewrote'] for r in row.values() if r.get('rewrote')), '-')
    stall = max((float(row[t]['stall_ms']) for t in load
                 if t in row and row[t].get('stall_ms')), default=None)
    cells = [v] + [row.get(t, {}).get('sql_ms', '-') for t in quiet]
    cells += [(lock + (' ' + rel if rel else '')) or '-', rewrote or '-',
              ('%.0f' % stall) if stall is not None else '-']
    print('| ' + ' | '.join(cells) + ' |')
PY
  exit 0
fi

[ -f "$PROD_DUMP" ]    || { printf 'no prod dump at %s\n' "$PROD_DUMP" >&2; exit 1; }
[ -f "$STAGING_DUMP" ] || { printf 'no staging dump at %s\n' "$STAGING_DUMP" >&2; exit 1; }
mkdir -p "$OUTDIR"

# ---------------------------------------------------------------------------
# Row profile at scale 1. Every count is multiplied by --scale.
# ---------------------------------------------------------------------------
seed_counts() {
  awk -v s="$SCALE" 'BEGIN{
    printf "n_profiles=%d\n", int(150000*s)
    printf "n_follows=%d\n",  int(300000*s)
    printf "n_posts=%d\n",    int(150000*s)
    printf "n_inter=%d\n",    int(300000*s)
    printf "n_messages=%d\n", int(500000*s)
    printf "n_tokens=%d\n",   int(50000*s)
    printf "n_userserv=%d\n", int(200000*s)
    printf "n_calls=%d\n",    int(100000*s)
    printf "n_prekeys=%d\n",  int(100000*s)
    printf "n_servers=200\nn_channels=2000\nn_bots=200\nn_convs=5000\n"
  }'
}
eval "$(seed_counts)"

psql_db() { docker exec -i "$CONTAINER" psql -U postgres -d "$1" -v ON_ERROR_STOP=1 "${@:2}"; }
psql_q()  { docker exec -i "$CONTAINER" psql -U postgres -d "$1" -tAq -c "$2"; }

cleanup() {
  if [ "$KEEP" = 1 ]; then printf '==> container %s left running\n' "$CONTAINER"; return; fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

printf '==> starting %s (%s)\n' "$CONTAINER" "$IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=mcost -e POSTGRES_DB=postgres --shm-size=1g "$IMAGE" \
  postgres -c max_connections=100 -c shared_buffers=1GB -c work_mem=64MB \
           -c maintenance_work_mem=512MB -c max_wal_size=8GB \
           -c checkpoint_timeout=30min >/dev/null

# The image runs initdb, applies its own migrations and restarts, so a single
# successful connection is not readiness. Require three in a row.
ok=0
for _ in $(seq 1 180); do
  if docker exec "$CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 3 ] && break
  else
    ok=0
  fi
  sleep 1
done
[ "$ok" -ge 3 ] || { printf 'postgres never came up\n' >&2; exit 1; }

# Wall clock across docker exec carries ~40 ms of connection setup. \timing gives
# the server-side time of each statement; their sum is the sql_ms column.
docker exec -i "$CONTAINER" tee /tmp/mcost_psqlrc >/dev/null <<'RC'
\timing on
RC

# ---------------------------------------------------------------------------
# Template database: dump, then seed.
# ---------------------------------------------------------------------------
prepare_db() {                                    # $1 dbname, $2 dump
  local db="$1" dump="$2"
  # TEMPLATE postgres, not template1: the image builds auth, storage and the
  # extensions schema into postgres only, and the dumps reference auth.users.
  psql_db template1 -q -c "CREATE DATABASE $db TEMPLATE postgres"
  psql_db "$db" -q <<'SQL'
DO $$ BEGIN CREATE ROLE supabase_realtime_admin NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto  WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm   WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgjwt     WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent  WITH SCHEMA extensions;
SQL
  # gotrue 2.180+ ships this; the image's auth schema predates it, and three
  # production policies call it.
  docker exec -i "$CONTAINER" psql -U supabase_auth_admin -d "$db" -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE FUNCTION auth.session_meets_aal_requirement() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
SQL
  # postgres is not a superuser in this image; the staging dump carries twelve
  # ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin.
  docker exec -i "$CONTAINER" psql -U supabase_admin -d "$db" -q -c "GRANT supabase_admin TO postgres" >/dev/null
  # realtime.send and the storage columns ship with the services, not the image.
  # Every broadcast trigger calls realtime.send, and 20260816000011 updates posts.
  docker exec -i "$CONTAINER" psql -U supabase_admin -d "$db" -q \
    < "$ROOT/scripts/test-db/supabase-compat.sql" >/dev/null
  docker exec -i "$CONTAINER" psql -U postgres -d "$db" -q < "$dump" 2>&1 \
    | grep -E '^ERROR' | grep -v 'schema "public" already exists' || true
}

seed_db() {                                       # $1 dbname
  local db="$1" fvc_new
  fvc_new=$(psql_q "$db" "SELECT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='federated_voice_calls'
                AND column_name='ap_id')")
  docker exec -i "$CONTAINER" psql -U postgres -d "$db" -q -v ON_ERROR_STOP=1 \
    -v n_profiles="$n_profiles" -v n_follows="$n_follows" -v n_posts="$n_posts" \
    -v n_inter="$n_inter" -v n_messages="$n_messages" -v n_tokens="$n_tokens" \
    -v n_userserv="$n_userserv" -v n_calls="$n_calls" -v n_prekeys="$n_prekeys" \
    -v n_servers="$n_servers" -v n_channels="$n_channels" -v n_bots="$n_bots" \
    -v n_convs="$n_convs" -v fvc_new="$fvc_new" <<'SQL'
-- Row triggers are off for the load only. Foreign keys stay on: DISABLE TRIGGER
-- USER leaves internally generated constraint triggers enabled, so every row here
-- satisfies its references and its CHECKs. They are back on before any migration
-- runs, so migration-time trigger cost is real.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles','follows','posts','post_interactions','messages',
                           'bot_tokens','user_servers','servers','channels','bots',
                           'conversations','prekeys','federated_voice_calls'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t);
    END IF;
  END LOOP;
END $$;

-- Deterministic ids: one uuid prefix per table, low 48 bits are the series index.
CREATE FUNCTION pg_temp.uid(pfx text, i bigint) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT (pfx||'0000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid $$;

INSERT INTO auth.users (id)
SELECT pg_temp.uid('2000',i) FROM generate_series(1,:n_profiles) i;

-- One profile in five is remote and carries a NULL auth_user_id, which is the case
-- the UNIQUE constraint has to keep permitting.
INSERT INTO public.profiles (id, auth_user_id, username, display_name, domain, is_local,
                             followers_count, following_count, created_at)
SELECT pg_temp.uid('1000',i),
       CASE WHEN i % 5 = 0 THEN NULL ELSE pg_temp.uid('2000',i) END,
       'u'||i, 'User '||i,
       CASE WHEN i % 5 = 0 THEN 'remote'||(i%37)||'.example' ELSE 'har.mony.lol' END,
       (i % 5 <> 0), 0, 0, now() - (i||' seconds')::interval
FROM generate_series(1,:n_profiles) i;

INSERT INTO public.servers (id, name, slug, owner, rules)
SELECT pg_temp.uid('6000',i), 'server '||i, 's'||i,
       pg_temp.uid('1000',1+(i%:n_profiles)), '[]'::jsonb
FROM generate_series(1,:n_servers) i;

INSERT INTO public.channels (id, server_id, name, type)
SELECT pg_temp.uid('7000',i), pg_temp.uid('6000',1+(i%:n_servers)), 'chan'||i, 0
FROM generate_series(1,:n_channels) i;

INSERT INTO public.bots (id, username, owner_id)
SELECT pg_temp.uid('8000',i), 'bot-'||i, pg_temp.uid('1000',1+(i%:n_profiles))
FROM generate_series(1,:n_bots) i;

INSERT INTO public.bot_tokens (id, bot_id, token_hash, token_prefix, revoked_at)
SELECT pg_temp.uid('9000',i), pg_temp.uid('8000',1+(i%:n_bots)),
       encode(sha256(('tok'||i)::bytea),'hex'), 'hm_'||lpad(to_hex(i),8,'0'),
       CASE WHEN i % 11 = 0 THEN now() ELSE NULL END
FROM generate_series(1,:n_tokens) i;

INSERT INTO public.conversations (id, type)
SELECT pg_temp.uid('a000',i), 'direct' FROM generate_series(1,:n_convs) i;

-- (a,b) has to be unique: staging carries follows_follower_id_following_id_key,
-- production does not. a walks the profiles, k is the pass number over them.
INSERT INTO public.follows (id, follower_id, following_id, status)
SELECT pg_temp.uid('5000',i), pg_temp.uid('1000',a), pg_temp.uid('1000',b),
       CASE WHEN i % 10 = 0 THEN 'pending' ELSE 'accepted' END
FROM (SELECT i, a, 1 + ((a - 1 + k * 7919) % :n_profiles) b
        FROM (SELECT i, 1 + ((i-1) % :n_profiles) a, 1 + ((i-1) / :n_profiles) k
                FROM generate_series(1,:n_follows) i) q) r
WHERE a <> b
ON CONFLICT DO NOTHING;

-- Both counters hold twice the truth on every profile that has one: the state
-- 20260816000012 exists to repair, where two triggers counted every follow.
UPDATE public.profiles p SET followers_count = 2*c.n
  FROM (SELECT following_id id, count(*) n FROM public.follows WHERE status='accepted' GROUP BY 1) c
 WHERE p.id = c.id;
UPDATE public.profiles p SET following_count = 2*c.n
  FROM (SELECT follower_id id, count(*) n FROM public.follows WHERE status='accepted' GROUP BY 1) c
 WHERE p.id = c.id;

-- One post in seven is a reblog; its target is named in metadata->>'reblog_of'.
INSERT INTO public.posts (id, author_id, content, metadata, reblogs_count, is_deleted)
SELECT pg_temp.uid('3000',i),
       pg_temp.uid('1000',1+(i%:n_profiles)),
       jsonb_build_array(jsonb_build_object('type','text','text','post body '||i)),
       CASE WHEN i % 7 = 0
            THEN jsonb_build_object('reblog_of', pg_temp.uid('3000',1+((i*13)%:n_posts))::text)
            ELSE '{}'::jsonb END,
       0, false
FROM generate_series(1,:n_posts) i;

-- Stale reblog counters: wrong on every reblog target, plus 5% of the rest. The
-- second backfill statement in 20260816000011 costs what that 5% costs.
UPDATE public.posts SET reblogs_count = 99
 WHERE id IN (SELECT (metadata->>'reblog_of')::uuid FROM public.posts WHERE metadata ? 'reblog_of')
    OR (('x'||substr(replace(id::text,'-',''),1,4))::bit(16)::int % 20) = 0;

-- Same construction as follows: staging has a unique triple here too.
INSERT INTO public.post_interactions (id, user_id, post_id, interaction_type)
SELECT pg_temp.uid('b000',i), pg_temp.uid('1000',a), pg_temp.uid('3000',p),
       (ARRAY['favorite','reblog','bookmark','emoji_reaction'])[1+(i%4)]
FROM (SELECT i, a, 1 + ((a - 1 + k * 7919) % :n_posts) p
        FROM (SELECT i, 1 + ((i-1) % :n_profiles) a, 1 + ((i-1) / :n_profiles) k
                FROM generate_series(1,:n_inter) i) q) r
ON CONFLICT DO NOTHING;

-- 5% carry bot_id, the rest user_id; messages_user_or_bot_check forbids both.
INSERT INTO public.messages (id, channel_id, user_id, bot_id, content, created_at, updated_at)
SELECT pg_temp.uid('4000',i),
       pg_temp.uid('7000',1+(i%:n_channels)),
       CASE WHEN i % 20 = 0 THEN NULL ELSE pg_temp.uid('1000',1+(i%:n_profiles)) END,
       CASE WHEN i % 20 = 0 THEN pg_temp.uid('8000',1+(i%:n_bots)) ELSE NULL END,
       jsonb_build_array(jsonb_build_object('type','text','text','message body '||i)),
       now() - (i||' seconds')::interval, now()
FROM generate_series(1,:n_messages) i;

-- id is bigint identity on production and uuid on staging, so it is never named.
INSERT INTO public.user_servers (user_id, server_id, status)
SELECT pg_temp.uid('1000',1+(i%:n_profiles)),
       pg_temp.uid('6000',1+((i/:n_profiles)%:n_servers)), 'accepted'
FROM generate_series(1,:n_userserv) i
ON CONFLICT DO NOTHING;

INSERT INTO public.prekeys (id, user_id, device_id, prekey_id, public_key, is_one_time, used_at)
SELECT pg_temp.uid('c000',i), pg_temp.uid('1000',1+(i%:n_profiles)),
       'dev'||(i%3), i, encode(sha256(('pk'||i)::bytea),'base64'), true,
       CASE WHEN i % 4 = 0 THEN now() ELSE NULL END
FROM generate_series(1,:n_prekeys) i
ON CONFLICT DO NOTHING;

-- The two federated_voice_calls shapes share only id and ended_at.
\if :fvc_new
INSERT INTO public.federated_voice_calls
  (id, ap_id, caller_id, caller_federated_id, recipient_id, call_type,
   livekit_url, room_name, status)
SELECT pg_temp.uid('d000',i), 'https://har.mony.lol/calls/'||i,
       pg_temp.uid('1000',1+(i%:n_profiles)), 'u'||i||'@har.mony.lol',
       pg_temp.uid('1000',1+((i*3)%:n_profiles)),
       (ARRAY['voice','video'])[1+(i%2)], 'wss://lk.example', 'room'||i,
       (ARRAY['pending','accepted','ended','expired'])[1+(i%4)]
FROM generate_series(1,:n_calls) i;
\else
INSERT INTO public.federated_voice_calls (id, channel_id, room_id, sfu_url)
SELECT pg_temp.uid('d000',i), pg_temp.uid('7000',1+(i%:n_channels)),
       'room'||i, 'wss://lk.example'
FROM generate_series(1,:n_calls) i;
\endif

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles','follows','posts','post_interactions','messages',
                           'bot_tokens','user_servers','servers','channels','bots',
                           'conversations','prekeys','federated_voice_calls'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', t);
    END IF;
  END LOOP;
END $$;
SQL
  # FULL, not plain: a plain vacuum leaves the free space the seed's own counter
  # updates made, and the migration backfills then rewrite into it and the table
  # does not grow. Compacted first, the growth column measures the migration.
  psql_db "$db" -q -c 'VACUUM (FULL, ANALYZE)'
}

# ---------------------------------------------------------------------------
# Instruments. Schema mcost, so the migrations that sweep public do not see them.
# ---------------------------------------------------------------------------
install_probe_objects() {                          # $1 dbname
  psql_db "$1" -q <<'SQL'
CREATE SCHEMA mcost;
CREATE UNLOGGED TABLE mcost.lock_samples(ts timestamptz, mode text, nsp text, relname text, kind "char");
CREATE UNLOGGED TABLE mcost.stalls(tbl text PRIMARY KEY, wait_ms double precision);
CREATE UNLOGGED TABLE mcost.filenodes(phase text, relname text, filenode oid, bytes bigint);
CREATE UNLOGGED TABLE mcost.ddl_locks(tag text, mode text, nsp text, relname text, kind "char");

CREATE FUNCTION mcost.snapshot_filenodes(p_phase text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO mcost.filenodes
  SELECT p_phase, c.relname, c.relfilenode, pg_relation_size(c.oid)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r';
$$;

-- Polls the migration backend's granted relation locks every 5 ms. Commits each
-- pass so a terminate at the end of the migration keeps what it has collected.
CREATE PROCEDURE mcost.sample_locks(p_deadline timestamptz) LANGUAGE plpgsql AS $$
DECLARE v_pid int;
BEGIN
  -- COMMIT every pass: pg_stat_activity's backend array is cached for the life of
  -- a transaction, so a wait loop that never commits never sees the migration
  -- connect. It also stops this session pinning a snapshot, which is what
  -- CREATE INDEX CONCURRENTLY waits out.
  LOOP
    COMMIT;
    SELECT pid INTO v_pid FROM pg_stat_activity
     WHERE application_name = 'mcost_mig' AND pid <> pg_backend_pid() LIMIT 1;
    EXIT WHEN v_pid IS NOT NULL OR clock_timestamp() > p_deadline;
    PERFORM pg_sleep(0.001);
  END LOOP;
  IF v_pid IS NULL THEN RETURN; END IF;
  LOOP
    INSERT INTO mcost.lock_samples
    SELECT clock_timestamp(), l.mode, n.nspname, c.relname, c.relkind
      FROM pg_locks l
      LEFT JOIN pg_class c ON c.oid = l.relation
      LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE l.pid = v_pid AND l.granted AND l.locktype = 'relation';
    COMMIT;
    EXIT WHEN clock_timestamp() > p_deadline
           OR NOT EXISTS (SELECT 1 FROM pg_stat_activity
                           WHERE pid = v_pid AND application_name = 'mcost_mig');
    PERFORM pg_sleep(0.002);
  END LOOP;
END $$;

-- LOCK TABLE ... IN ROW EXCLUSIVE MODE is the lock every INSERT, UPDATE and DELETE
-- takes, and nothing else: no triggers fire, no rows are written. The longest wait
-- to acquire it is how long the table was closed to writers.
CREATE PROCEDURE mcost.write_probe(p_tbl text, p_deadline timestamptz) LANGUAGE plpgsql AS $$
DECLARE t0 timestamptz; w double precision; best double precision := 0;
BEGIN
  LOOP
    BEGIN
      t0 := clock_timestamp();
      EXECUTE format('LOCK TABLE public.%I IN ROW EXCLUSIVE MODE', p_tbl);
      w := extract(epoch FROM (clock_timestamp() - t0)) * 1000;
    EXCEPTION WHEN OTHERS THEN w := 0;
    END;
    COMMIT;
    IF w > best THEN
      best := w;
      INSERT INTO mcost.stalls VALUES (p_tbl, best)
        ON CONFLICT (tbl) DO UPDATE SET wait_ms = excluded.wait_ms;
      COMMIT;
    END IF;
    EXIT WHEN clock_timestamp() > p_deadline;
    PERFORM pg_sleep(0.002);
  END LOOP;
END $$;
SQL
  # Exact, not sampled: at ddl_command_end every lock the statement took is still
  # held, so this records the set rather than a 2 ms glimpse of it. Event triggers
  # are per-database and superuser-only, hence the separate connection.
  docker exec -i "$CONTAINER" psql -U supabase_admin -d "$1" -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE FUNCTION mcost.record_ddl_locks() RETURNS event_trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('application_name') <> 'mcost_mig' THEN RETURN; END IF;
  INSERT INTO mcost.ddl_locks
  SELECT tg_tag, l.mode, n.nspname, c.relname, c.relkind
    FROM pg_locks l
    JOIN pg_class c ON c.oid = l.relation
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE l.pid = pg_backend_pid() AND l.granted AND l.locktype = 'relation'
     AND n.nspname NOT IN ('mcost', 'pg_catalog', 'information_schema', 'graphql');
END $$;
CREATE EVENT TRIGGER mcost_ddl ON ddl_command_end EXECUTE FUNCTION mcost.record_ddl_locks();
SQL
}

# ---------------------------------------------------------------------------
# The blocking statement and its online rewrite, measured side by side. Each
# case drops the object first so both forms start from the same schema.
# ---------------------------------------------------------------------------
ALT_UNITS=()
write_alternatives() {
  local d="$OUTDIR/alt"
  mkdir -p "$d"
  ALT_UNITS=()

  local setup_uniq='ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_auth_user_id_key;
DROP INDEX IF EXISTS public.profiles_auth_user_id_key;'
  printf '%s\n' "$setup_uniq" > "$d/1a_profiles_unique_blocking.sql.setup.sql"
  printf '%s\n' "$setup_uniq" > "$d/1b_profiles_unique_concurrent.sql.setup.sql"
  cat > "$d/1a_profiles_unique_blocking.sql" <<'SQL'
ALTER TABLE public.profiles ADD CONSTRAINT profiles_auth_user_id_key UNIQUE (auth_user_id);
SQL
  cat > "$d/1b_profiles_unique_concurrent.sql" <<'SQL'
CREATE UNIQUE INDEX CONCURRENTLY profiles_auth_user_id_key ON public.profiles (auth_user_id);
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_auth_user_id_key UNIQUE USING INDEX profiles_auth_user_id_key;
SQL

  local setup_fk='ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_bot_id_fkey;'
  printf '%s\n' "$setup_fk" > "$d/2a_messages_fk_blocking.sql.setup.sql"
  printf '%s\n' "$setup_fk" > "$d/2b_messages_fk_not_valid.sql.setup.sql"
  cat > "$d/2a_messages_fk_blocking.sql" <<'SQL'
ALTER TABLE public.messages ADD CONSTRAINT messages_bot_id_fkey
    FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;
SQL
  cat > "$d/2b_messages_fk_not_valid.sql" <<'SQL'
ALTER TABLE public.messages ADD CONSTRAINT messages_bot_id_fkey
    FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_bot_id_fkey;
SQL

  # prekeys.used_by exists on production only; 20260818000006 is what adds it
  # elsewhere. Against the staging dump both of these fail, visibly, with 42703.
  local setup_idx='DROP INDEX IF EXISTS public.idx_prekeys_used_by;'
  printf '%s\n' "$setup_idx" > "$d/3a_prekeys_index_blocking.sql.setup.sql"
  printf '%s\n' "$setup_idx" > "$d/3b_prekeys_index_concurrent.sql.setup.sql"
  cat > "$d/3a_prekeys_index_blocking.sql" <<'SQL'
CREATE INDEX idx_prekeys_used_by ON public.prekeys(used_by);
SQL
  cat > "$d/3b_prekeys_index_concurrent.sql" <<'SQL'
CREATE INDEX CONCURRENTLY idx_prekeys_used_by ON public.prekeys(used_by);
SQL

  # The follow-counter backfill of 20260816000012, as four statements outside a
  # transaction instead of inside the migration's. Nothing else in that file
  # holds a lock over them once they are separated.
  cat > "$d/4a_follow_backfill_inline.sql" <<'SQL'
BEGIN;
UPDATE public.profiles p SET followers_count = c.n
  FROM (SELECT following_id AS id, count(*) AS n
          FROM public.follows WHERE status = 'accepted' GROUP BY 1) c
 WHERE p.id = c.id AND p.followers_count IS DISTINCT FROM c.n;
UPDATE public.profiles p SET following_count = c.n
  FROM (SELECT follower_id AS id, count(*) AS n
          FROM public.follows WHERE status = 'accepted' GROUP BY 1) c
 WHERE p.id = c.id AND p.following_count IS DISTINCT FROM c.n;
COMMIT;
SQL

  ALT_UNITS=(1a_profiles_unique_blocking.sql 1b_profiles_unique_concurrent.sql
             2a_messages_fk_blocking.sql 2b_messages_fk_not_valid.sql
             3a_prekeys_index_blocking.sql 3b_prekeys_index_concurrent.sql
             4a_follow_backfill_inline.sql)
}

PENDING=()
while IFS= read -r f; do
  [ "${f:0:14}" \< "$FIRST_PENDING" ] && continue
  PENDING+=("$f")
done < <(find "$MIGDIR" -maxdepth 1 -name '*.sql' -type f -printf '%f\n' | sort)
[ "${#PENDING[@]}" -gt 0 ] || { printf 'no pending migrations\n' >&2; exit 1; }
printf '==> %s pending migration(s), first %s\n' "${#PENDING[@]}" "${PENDING[0]:0:14}"

PROBE_TABLES="profiles messages posts post_interactions bot_tokens user_servers federated_voice_calls"

# Units are SQL files under UNIT_DIR. A companion <name>.setup.sql runs first and
# is not timed, which is how an alternative gets the schema back to the pre-state.
UNIT_DIR="$MIGDIR"
UNITS=()

run_pass() {                                       # $1 db, $2 template, $3 mode, $4 tsv
  local db="$1" tmpl="$2" mode="$3" tsv="$4"
  psql_db template1 -q -c "DROP DATABASE IF EXISTS $db" >/dev/null
  psql_db template1 -q -c "CREATE DATABASE $db TEMPLATE $tmpl" >/dev/null
  install_probe_objects "$db"
  printf 'version\tfile\tms\tsql_ms\tstmt_ms\tmax_lock\tlock_rel\tlock_src\tblock_lock\tblock_ms\trewrote\tgrew_bytes\tstall_ms\tstall_tbl\n' > "$tsv"

  local f v t started ended ms sql_ms stmt_ms row sampler probes
  for f in "${UNITS[@]}"; do
    v="${f%.sql}"; v="${v:0:34}"
    [ -f "$UNIT_DIR/$f.setup.sql" ] && psql_db "$db" -q -f - < "$UNIT_DIR/$f.setup.sql" >/dev/null
    psql_db "$db" -q -c "TRUNCATE mcost.lock_samples, mcost.stalls, mcost.filenodes, mcost.ddl_locks" \
                     -c "SELECT mcost.snapshot_filenodes('before')" >/dev/null

    docker exec -i -e PGAPPNAME=mcost_sampler "$CONTAINER" psql -U postgres -d "$db" -q -Atc \
      "CALL mcost.sample_locks(clock_timestamp() + interval '3600 seconds')" >/dev/null 2>&1 &
    sampler=$!

    probes=()
    if [ "$mode" = loaded ]; then
      for t in $PROBE_TABLES; do
        docker exec -i -e PGAPPNAME=mcost_probe "$CONTAINER" psql -U postgres -d "$db" -q -Atc \
          "CALL mcost.write_probe('$t', clock_timestamp() + interval '3600 seconds')" >/dev/null 2>&1 &
        probes+=("$!")
      done
      sleep 1
    fi

    started=$(date +%s%N)
    docker exec -i -e PGAPPNAME=mcost_mig -e PSQLRC=/tmp/mcost_psqlrc "$CONTAINER" \
      psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -f - < "$UNIT_DIR/$f" \
      > "$OUTDIR/.out" 2>>"$OUTDIR/errors-$(basename "$tsv" .tsv).log" \
      || printf '!! %s did not apply cleanly\n' "$f" >&2
    ended=$(date +%s%N)
    ms=$(( (ended - started) / 1000000 ))
    sql_ms=$(grep -oE '^Time: [0-9.]+' "$OUTDIR/.out" | awk '{s+=$2} END{printf "%.0f", s+0}')
    stmt_ms=$(grep -oE '^Time: [0-9.]+' "$OUTDIR/.out" | awk '{printf "%s%.0f", (NR>1?",":""), $2}')

    psql_db "$db" -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                          WHERE application_name IN ('mcost_sampler','mcost_probe')" >/dev/null 2>&1 || true
    wait "$sampler" 2>/dev/null || true
    [ "${#probes[@]}" -gt 0 ] && { wait "${probes[@]}" 2>/dev/null || true; }

    psql_db "$db" -q -c "SELECT mcost.snapshot_filenodes('after')" >/dev/null

    row=$(psql_q "$db" "
      WITH lk AS (
        SELECT 'ddl' src, mode, nsp, relname, kind, count(*) n FROM mcost.ddl_locks
          WHERE kind IN ('r','p','m') GROUP BY 1,2,3,4,5
        UNION ALL
        SELECT 'sampled', mode, nsp, relname, kind, count(*) FROM mcost.lock_samples
          WHERE relname IS NOT NULL AND kind IN ('r','p','m') AND nsp <> 'mcost'
          GROUP BY 1,2,3,4,5
      ),
      w AS (SELECT *, CASE WHEN nsp='public' THEN relname ELSE nsp||'.'||relname END rel,
                   array_position(
              ARRAY['AccessShareLock','RowShareLock','RowExclusiveLock',
                    'ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock',
                    'ExclusiveLock','AccessExclusiveLock'], mode) wt FROM lk),
      -- The heaviest mode anywhere, and every relation it was held on.
      hi AS (SELECT mode, wt FROM w ORDER BY wt DESC, (nsp='public') DESC LIMIT 1),
      rel AS (SELECT rel, sum(n) n, bool_or(src='ddl') exact FROM w
               WHERE mode = (SELECT mode FROM hi) GROUP BY 1),
      relr AS (SELECT rel, row_number() OVER (ORDER BY n DESC, rel) rn FROM rel),
      top AS (
        SELECT (SELECT mode FROM hi) mode,
               (SELECT string_agg(rel, ',' ORDER BY rn) FROM relr WHERE rn <= 4)
                 || CASE WHEN (SELECT count(*) FROM relr) > 4
                         THEN ' +'||((SELECT count(*) FROM relr) - 4)||' more' ELSE '' END relname,
               CASE WHEN (SELECT bool_or(exact) FROM rel) THEN 'ddl' ELSE 'sampled' END src),
      -- How long a write-blocking mode stayed held, from first to last sample.
      -- Migrations run in one transaction, so this runs from acquisition to COMMIT.
      hold AS (
        SELECT CASE WHEN nsp='public' THEN relname ELSE nsp||'.'||relname END rel, mode,
               extract(epoch FROM (max(ts) - min(ts))) * 1000 ms
          FROM mcost.lock_samples
         WHERE kind IN ('r','p','m') AND nsp <> 'mcost'
           AND mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')
         GROUP BY 1,2 ORDER BY 3 DESC LIMIT 1),
      d AS (SELECT b.relname, b.filenode bf, a.filenode af, a.bytes - b.bytes db
              FROM mcost.filenodes b JOIN mcost.filenodes a
                ON a.relname = b.relname AND a.phase = 'after' AND b.phase = 'before')
      SELECT coalesce((SELECT mode FROM top),'')||E'\t'||
             coalesce((SELECT relname FROM top),'')||E'\t'||
             coalesce((SELECT src FROM top),'')||E'\t'||
             coalesce((SELECT mode||' '||rel FROM hold),'')||E'\t'||
             coalesce((SELECT round(ms)::text FROM hold),'')||E'\t'||
             coalesce((SELECT string_agg(relname,',') FROM d WHERE bf <> af),'')||E'\t'||
             coalesce((SELECT sum(db) FROM d),0)::text||E'\t'||
             coalesce((SELECT round(wait_ms)::text FROM mcost.stalls ORDER BY wait_ms DESC LIMIT 1),'')||E'\t'||
             coalesce((SELECT tbl FROM mcost.stalls ORDER BY wait_ms DESC LIMIT 1),'')")
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$v" "$f" "$ms" "$sql_ms" "$stmt_ms" "$row" >> "$tsv"
    printf '    %-34s %7s ms sql  block %5s ms  %s\n' "$v" "$sql_ms" \
           "$(printf '%s' "$row" | cut -f5)" "$(printf '%s' "$row" | cut -f1,2)"
  done
}

for variant in $VARIANTS; do
  case "$variant" in
    prod)    dump="$PROD_DUMP" ;;
    staging) dump="$STAGING_DUMP" ;;
    *) printf 'unknown variant %s\n' "$variant" >&2; exit 2 ;;
  esac
  tmpl="mcost_tmpl_${variant}"
  printf '==> %s: building from %s at scale %s\n' "$variant" "$dump" "$SCALE"
  prepare_db "$tmpl" "$dump"
  seed_db "$tmpl"
  psql_q "$tmpl" "SELECT string_agg(t||'='||n,' ' ORDER BY t) FROM (
      SELECT 'profiles' t, count(*) n FROM public.profiles UNION ALL
      SELECT 'messages', count(*) FROM public.messages UNION ALL
      SELECT 'posts', count(*) FROM public.posts UNION ALL
      SELECT 'post_interactions', count(*) FROM public.post_interactions UNION ALL
      SELECT 'follows', count(*) FROM public.follows UNION ALL
      SELECT 'bot_tokens', count(*) FROM public.bot_tokens UNION ALL
      SELECT 'user_servers', count(*) FROM public.user_servers UNION ALL
      SELECT 'federated_voice_calls', count(*) FROM public.federated_voice_calls UNION ALL
      SELECT 'prekeys', count(*) FROM public.prekeys) s" | tee "$OUTDIR/rows-${variant}-s${SCALE}.txt"

  for p in $PASSES; do
    case "$p" in
      quiet)  UNIT_DIR="$MIGDIR"; UNITS=("${PENDING[@]}")
              run_pass "mcost_run_${variant}"  "$tmpl" quiet  "$OUTDIR/timing-${variant}-s${SCALE}.tsv" ;;
      loaded) UNIT_DIR="$MIGDIR"; UNITS=("${PENDING[@]}")
              run_pass "mcost_load_${variant}" "$tmpl" loaded "$OUTDIR/timing-${variant}-s${SCALE}-loaded.tsv" ;;
      alt)    write_alternatives; UNIT_DIR="$OUTDIR/alt"; UNITS=("${ALT_UNITS[@]}")
              run_pass "mcost_alt_${variant}"  "$tmpl" loaded "$OUTDIR/alt-${variant}-s${SCALE}.tsv" ;;
    esac
  done
done

printf '==> wrote %s\n' "$OUTDIR"
