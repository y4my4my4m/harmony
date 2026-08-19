#!/usr/bin/env bash
# Proves a pg_dump backup restores, and measures how long restoring takes.
#
# The runbook says to take a dump before migrating. This runs that dump into a
# throwaway container and then compares the two catalogs object by object, so
# the claim "the backup is good" rests on a diff rather than on psql's exit
# status. psql exits 0 after an SQL error unless ON_ERROR_STOP is set, and a
# restore that lost forty functions looks identical to one that lost none.
#
#   ./scripts/restore-drill.sh --from-container harmony-db
#   ./scripts/restore-drill.sh --from-file /path/to/backup.sql
#
# Compared between source and restore: tables, views, matviews, sequences,
# functions (by identity signature), indexes, constraints, policies, triggers,
# enum labels, and exact row counts per table. Differences are listed by name.
# Phase durations are printed so the recovery window is measured, not guessed.
#
# --from-file has no live original to compare against, so the file is first
# loaded into its own throwaway instance and that instance becomes the source.
# What is then proved is dump -> restore fidelity plus a clean load of the file;
# whether the file matches the instance it came from is outside the drill.
#
# WHAT THIS DOES NOT COVER
#   * A schema-only dump carries no rows. Row counts are then zero on both
#     sides and prove nothing about data recovery. The drill says so and keeps
#     going; run it against a dump taken without --schema-only to test data.
#   * Only the schemas named by --schema (default: public) are dumped and
#     compared. Roles, role memberships, database-level GRANTs, ownership,
#     tablespaces, publications, subscriptions, and the auth, storage,
#     realtime, extensions, cron and vault schemas are outside a
#     --schema=public dump. A restore that passes this drill can still come up
#     unusable because no role named `authenticated` exists to receive the
#     GRANTs the dump replays.
#   * CREATE EXTENSION generally needs superuser, and extensions living outside
#     the dumped schemas are not in the dump at all. The target must already
#     carry them. --pre-restore exists for that; the drill does not guess.
#   * Large objects, sequence ownership outside the dumped schemas, and event
#     triggers (which are database-scoped, not schema-scoped) are not compared.
#   * Row counts are exact and cost a sequential scan per table. On a large
#     production instance that is not free; --no-row-counts skips it.
#   * Counts are of rows visible to the connecting role. Connect as the table
#     owner or a superuser, or RLS silently deflates both sides.
#   * Nothing here validates that the restored database serves traffic. It
#     compares catalogs and cardinalities.
#
# Measured against the production public schema (107 tables, 448 functions, 572
# indexes, 340 policies) on supabase/postgres:15.8.1.060, local NVMe:
#
#   rows       pg_dump   restore   recovery window
#   175,050      0.3s      4.8s       16.5s
#   1,075,050    0.9s      9.5s       20.6s
#
# 10.5s of every recovery window is the container coming up; the rest scales
# with index builds and row volume.
#
# Restoring that same dump into a stock supabase/postgres:15.8.1.060 with no
# --pre-restore loses three policies referencing auth.session_meets_aal_requirement()
# and one GRANT to supabase_realtime_admin, and psql still exits 0.
set -euo pipefail

SOURCE_CONTAINER=""
SOURCE_FILE=""
SOURCE_DB="postgres"
SOURCE_USER="postgres"
SOURCE_PASSWORD=""
TARGET_IMAGE="${RESTORE_DRILL_IMAGE:-}"
TARGET_PASSWORD="postgres"
SCHEMAS=()
PRE_RESTORE=()
SCHEMA_ONLY=0
ROW_COUNTS=1
KEEP=0
SELF_TEST=0
OUT_DIR=""
ALLOWED_RESTORE_ERRORS=0

# Names the drill must never remove even if handed one.
PROTECTED='^(harmony-|supabase-|hme2e-|hmfed-)'

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//;$d'
  cat <<'USAGE'
Options
  --from-container NAME   dump from a running container via docker exec
  --from-file PATH        use a dump file already on disk
  --db NAME               source database            (default postgres)
  --user NAME             source role                (default postgres)
  --password PW           source password, if the socket is not trusted
  --schema NAME           schema to dump and compare (repeatable, default public)
  --schema-only           pass --schema-only to pg_dump
  --no-row-counts         skip the per-table count comparison
  --image REF             image for the throwaway instances
                          (default: the source container's own image)
  --pre-restore FILE      SQL to apply to a fresh instance before restoring
                          (repeatable; extensions, roles, non-public schemas)
  --allow-restore-errors N  tolerate up to N errors during restore (default 0)
  --self-test             after a passing drill, damage the restored copy and
                          require the comparison to report the damage
  --out DIR               keep dump and census artifacts in DIR
  --keep                  leave the throwaway containers running
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from-container) SOURCE_CONTAINER="$2"; shift 2 ;;
    --from-file) SOURCE_FILE="$2"; shift 2 ;;
    --db) SOURCE_DB="$2"; shift 2 ;;
    --user) SOURCE_USER="$2"; shift 2 ;;
    --password) SOURCE_PASSWORD="$2"; shift 2 ;;
    --schema) SCHEMAS+=("$2"); shift 2 ;;
    --schema-only) SCHEMA_ONLY=1; shift ;;
    --no-row-counts) ROW_COUNTS=0; shift ;;
    --image) TARGET_IMAGE="$2"; shift 2 ;;
    --pre-restore) PRE_RESTORE+=("$2"); shift 2 ;;
    --allow-restore-errors) ALLOWED_RESTORE_ERRORS="$2"; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ "${#SCHEMAS[@]}" -gt 0 ] || SCHEMAS=(public)

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
err()  { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m ok \033[0m %s\n' "$*"; }

if [ -n "$SOURCE_CONTAINER" ] && [ -n "$SOURCE_FILE" ]; then
  err "--from-container and --from-file are exclusive"; exit 2
fi
if [ -z "$SOURCE_CONTAINER" ] && [ -z "$SOURCE_FILE" ]; then
  err "one of --from-container or --from-file is required"; usage >&2; exit 2
fi
if [ -n "$SOURCE_FILE" ] && [ ! -r "$SOURCE_FILE" ]; then
  err "cannot read $SOURCE_FILE"; exit 2
fi
for f in ${PRE_RESTORE[@]+"${PRE_RESTORE[@]}"}; do
  [ -r "$f" ] || { err "cannot read --pre-restore $f"; exit 2; }
done
command -v docker >/dev/null || { err "docker not on PATH"; exit 2; }

if [ -n "$SOURCE_CONTAINER" ]; then
  docker inspect "$SOURCE_CONTAINER" >/dev/null 2>&1 ||
    { err "no such container: $SOURCE_CONTAINER"; exit 2; }
  [ -z "$TARGET_IMAGE" ] &&
    TARGET_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$SOURCE_CONTAINER")"
fi
[ -n "$TARGET_IMAGE" ] || TARGET_IMAGE="supabase/postgres:15.8.1.060"

STAMP="$$-$(date +%s)"
C_STAGE="rdrill-stage-$STAMP"
C_TARGET="rdrill-target-$STAMP"
OWNED=()

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rdrill.XXXXXX")"

cleanup() {
  local rc=$?
  if [ "$KEEP" = "1" ]; then
    [ "${#OWNED[@]}" -gt 0 ] && log "kept: ${OWNED[*]}"
    log "artifacts in $WORK"
  else
    for c in ${OWNED[@]+"${OWNED[@]}"}; do
      # A protected name can only get here through a bug. Refuse regardless.
      [[ "$c" =~ $PROTECTED ]] && continue
      docker rm -f "$c" >/dev/null 2>&1 || true
    done
    if [ -n "$OUT_DIR" ]; then
      mkdir -p "$OUT_DIR" && cp -a "$WORK/." "$OUT_DIR/" 2>/dev/null || true
      log "artifacts copied to $OUT_DIR"
    fi
    rm -rf "$WORK"
  fi
  return $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

now_ms() { date +%s%3N; }
fmt_ms() { printf '%d.%01ds' $(( $1 / 1000 )) $(( ($1 % 1000) / 100 )); }

PHASE_NAMES=()
PHASE_MS=()
record() { PHASE_NAMES+=("$1"); PHASE_MS+=("$2"); }

# ---------------------------------------------------------------- containers

start_pg() {
  local name="$1"
  [[ "$name" =~ $PROTECTED ]] && { err "refusing to create $name"; exit 2; }
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -e POSTGRES_PASSWORD="$TARGET_PASSWORD" \
    "$TARGET_IMAGE" >/dev/null
  OWNED+=("$name")
}

# The Supabase image reports ready, runs its own init scripts, then restarts.
# Require several consecutive successful queries so the restart is not read as
# readiness.
wait_pg() {
  local name="$1" hits=0
  for _ in $(seq 1 150); do
    if docker exec "$name" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
      hits=$((hits + 1)); [ "$hits" -ge 5 ] && return 0
    else hits=0; fi
    sleep 2
  done
  err "$name never stabilised"; docker logs "$name" 2>&1 | tail -20; return 1
}

# psql against a drill-owned container.
tpsql() { local c="$1"; shift; docker exec -i "$c" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }

# psql against the source, which may need a password and a non-default role.
spsql() {
  local c="$1"; shift
  if [ -n "$SOURCE_PASSWORD" ]; then
    docker exec -i -e PGPASSWORD="$SOURCE_PASSWORD" "$c" \
      psql -X -U "$SOURCE_USER" -d "$SOURCE_DB" -v ON_ERROR_STOP=1 "$@"
  else
    docker exec -i "$c" psql -X -U "$SOURCE_USER" -d "$SOURCE_DB" -v ON_ERROR_STOP=1 "$@"
  fi
}

# ---------------------------------------------------------------- census

# One line per catalog object as "kind<TAB>qualified name". Function names carry
# their identity arguments so overloads stay distinct. Internal triggers are
# excluded: their names embed an OID that differs between two instances holding
# the same schema.
cat > "$WORK/census.sql" <<'SQL'
WITH s AS (SELECT oid, nspname FROM pg_namespace WHERE nspname = ANY(:'schemas'::text[]))
SELECT 'table',      s.nspname||'.'||c.relname FROM pg_class c JOIN s ON s.oid = c.relnamespace WHERE c.relkind IN ('r','p')
UNION ALL
SELECT 'view',       s.nspname||'.'||c.relname FROM pg_class c JOIN s ON s.oid = c.relnamespace WHERE c.relkind = 'v'
UNION ALL
SELECT 'matview',    s.nspname||'.'||c.relname FROM pg_class c JOIN s ON s.oid = c.relnamespace WHERE c.relkind = 'm'
UNION ALL
SELECT 'sequence',   s.nspname||'.'||c.relname FROM pg_class c JOIN s ON s.oid = c.relnamespace WHERE c.relkind = 'S'
UNION ALL
SELECT 'index',      s.nspname||'.'||c.relname FROM pg_class c JOIN s ON s.oid = c.relnamespace WHERE c.relkind IN ('i','I')
UNION ALL
SELECT 'function',   s.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'
  FROM pg_proc p JOIN s ON s.oid = p.pronamespace
UNION ALL
SELECT 'constraint', s.nspname||'.'||COALESCE(cl.relname, '-')||'.'||k.conname
  FROM pg_constraint k JOIN s ON s.oid = k.connamespace LEFT JOIN pg_class cl ON cl.oid = k.conrelid
UNION ALL
SELECT 'policy',     s.nspname||'.'||cl.relname||'.'||pol.polname
  FROM pg_policy pol JOIN pg_class cl ON cl.oid = pol.polrelid JOIN s ON s.oid = cl.relnamespace
UNION ALL
SELECT 'trigger',    s.nspname||'.'||cl.relname||'.'||t.tgname
  FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN s ON s.oid = cl.relnamespace
  WHERE NOT t.tgisinternal
UNION ALL
SELECT 'enum',       s.nspname||'.'||ty.typname||'.'||e.enumlabel
  FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid JOIN s ON s.oid = ty.typnamespace
ORDER BY 1, 2;
SQL

# Exact counts. query_to_xml runs count(*) per relation inside one statement, so
# the whole census is a single round trip. Partitions are skipped; their rows are
# counted through the partitioned parent.
cat > "$WORK/rowcount.sql" <<'SQL'
SELECT n.nspname||'.'||c.relname,
       (xpath('/row/cnt/text()',
              query_to_xml(format('SELECT count(*) AS cnt FROM %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p')
  AND NOT c.relispartition
  AND n.nspname = ANY(:'schemas'::text[])
ORDER BY 1;
SQL

SCHEMA_ARRAY="{$(IFS=,; echo "${SCHEMAS[*]}")}"

census() { # census <psql-fn> <container> <outfile-prefix>
  local fn="$1" c="$2" out="$3"
  "$fn" "$c" -tA -F$'\t' -v schemas="$SCHEMA_ARRAY" -f - < "$WORK/census.sql" > "$out.objects"
  if [ "$ROW_COUNTS" = "1" ]; then
    "$fn" "$c" -tA -F$'\t' -v schemas="$SCHEMA_ARRAY" -f - < "$WORK/rowcount.sql" > "$out.rows"
  else
    : > "$out.rows"
  fi
}

# ---------------------------------------------------------------- restore

reset_schemas() { # drop the dumped schemas so the restore lands on bare ground
  local c="$1" s
  for s in "${SCHEMAS[@]}"; do
    tpsql "$c" -q -c "DROP SCHEMA IF EXISTS \"$s\" CASCADE" >/dev/null 2>&1
  done
}

ensure_schemas() { # the dump recreates a schema only if it dumped one
  local c="$1" dump="$2" s
  for s in "${SCHEMAS[@]}"; do
    grep -qiE "^CREATE SCHEMA (IF NOT EXISTS )?\"?$s\"?;" "$dump" ||
      tpsql "$c" -q -c "CREATE SCHEMA IF NOT EXISTS \"$s\"" >/dev/null
  done
}

# Applied twice, as postgres and as supabase_admin: the Supabase image owns the
# realtime and storage schemas as supabase_admin and postgres is not superuser
# there, while some statements refuse to run as superuser's peer. Both passes
# are expected to report errors; what matters is that the union lands. Failures
# that matter surface as restore errors, so output goes to a log, not the
# terminal.
apply_pre_restore() {
  local c="$1" f
  for f in ${PRE_RESTORE[@]+"${PRE_RESTORE[@]}"}; do
    docker exec -i "$c" psql -X -U postgres -d postgres -q -f - \
      < "$f" >> "$WORK/prereq.log" 2>&1 || true
    docker exec -i "$c" psql -X -U supabase_admin -h 127.0.0.1 -d postgres -q -f - \
      < "$f" >> "$WORK/prereq.log" 2>&1 || true
  done
}

# psql prefixes a diagnostic with "psql:<source>:<line>: ". Two spaces follow the
# severity. Anchoring matters: a looser pattern also matches the word ERROR
# inside restored data or a function body echoed back in a HINT.
ERR_RE='^(psql:.*:[0-9]+: )?ERROR:  '

# Restore with errors surfaced rather than swallowed. ON_ERROR_STOP is
# deliberately off: the point is to see every error the dump produces, not the
# first.
load_dump() { # load_dump <container> <dumpfile> <logfile>
  local c="$1" dump="$2" logf="$3"
  docker exec -i "$c" psql -X -U postgres -d postgres --set ON_ERROR_STOP=off \
    -f - < "$dump" > "$logf" 2>&1 || true
  grep -cE "$ERR_RE" "$logf" || true
}

report_errors() { # report_errors <label> <logfile> <count>
  local label="$1" logf="$2" n="$3"
  [ "$n" -eq 0 ] && return 0
  err "$label produced $n error(s)"
  grep -E "$ERR_RE" "$logf" | sed 's/^/      /' | head -20 >&2
  [ "$n" -gt 20 ] && printf '      ... %d more\n' "$((n - 20))" >&2
  return 1
}

# ---------------------------------------------------------------- phases

log "target image $TARGET_IMAGE"
log "schemas: ${SCHEMAS[*]}"
T_ALL0=$(now_ms)

if [ -n "$SOURCE_FILE" ]; then
  log "staging $SOURCE_FILE into $C_STAGE"
  t0=$(now_ms)
  start_pg "$C_STAGE"; wait_pg "$C_STAGE"
  apply_pre_restore "$C_STAGE"
  reset_schemas "$C_STAGE"
  ensure_schemas "$C_STAGE" "$SOURCE_FILE"
  stage_errors=$(load_dump "$C_STAGE" "$SOURCE_FILE" "$WORK/stage.log")
  record "stage source file" $(( $(now_ms) - t0 ))
  if ! report_errors "staging the source file" "$WORK/stage.log" "$stage_errors"; then
    err "the source file does not load cleanly; nothing downstream is meaningful"
    exit 1
  fi
  ok "source file loaded with 0 errors"
  SRC_CONTAINER="$C_STAGE"
  SRC_PSQL=tpsql
else
  SRC_CONTAINER="$SOURCE_CONTAINER"
  SRC_PSQL=spsql
fi

log "pg_dump from $SRC_CONTAINER"
t0=$(now_ms)
DUMP="$WORK/source.sql"
PGDUMP_ARGS=(--no-owner)
for s in "${SCHEMAS[@]}"; do PGDUMP_ARGS+=("--schema=$s"); done
[ "$SCHEMA_ONLY" = "1" ] && PGDUMP_ARGS+=(--schema-only)
if [ "$SRC_PSQL" = "tpsql" ]; then
  docker exec -i "$SRC_CONTAINER" pg_dump -U postgres -d postgres "${PGDUMP_ARGS[@]}" > "$DUMP"
elif [ -n "$SOURCE_PASSWORD" ]; then
  docker exec -i -e PGPASSWORD="$SOURCE_PASSWORD" "$SRC_CONTAINER" \
    pg_dump -U "$SOURCE_USER" -d "$SOURCE_DB" "${PGDUMP_ARGS[@]}" > "$DUMP"
else
  docker exec -i "$SRC_CONTAINER" \
    pg_dump -U "$SOURCE_USER" -d "$SOURCE_DB" "${PGDUMP_ARGS[@]}" > "$DUMP"
fi
record "pg_dump" $(( $(now_ms) - t0 ))
DUMP_BYTES=$(wc -c < "$DUMP")
note "$(printf '%s bytes, %s lines' "$DUMP_BYTES" "$(wc -l < "$DUMP")")"
[ "$DUMP_BYTES" -gt 0 ] || { err "pg_dump produced an empty file"; exit 1; }
grep -q 'PostgreSQL database dump complete' "$DUMP" ||
  { err "dump is truncated: no completion marker"; exit 1; }
if ! grep -q '^COPY ' "$DUMP"; then
  note "dump carries no COPY blocks: schema only, row counts prove nothing"
fi

log "starting restore target $C_TARGET"
t0=$(now_ms)
start_pg "$C_TARGET"; wait_pg "$C_TARGET"
record "start target" $(( $(now_ms) - t0 ))

t0=$(now_ms)
apply_pre_restore "$C_TARGET"
reset_schemas "$C_TARGET"
ensure_schemas "$C_TARGET" "$DUMP"
record "prerequisites" $(( $(now_ms) - t0 ))

log "restoring into $C_TARGET"
t0=$(now_ms)
restore_errors=$(load_dump "$C_TARGET" "$DUMP" "$WORK/restore.log")
record "restore" $(( $(now_ms) - t0 ))
if [ "$restore_errors" -gt "$ALLOWED_RESTORE_ERRORS" ]; then
  report_errors "restore" "$WORK/restore.log" "$restore_errors" || true
  RESTORE_CLEAN=0
else
  ok "restore produced $restore_errors error(s)"
  RESTORE_CLEAN=1
fi

# ---------------------------------------------------------------- verify

compare() { # compare <label> -> 0 when identical
  local label="$1" bad=0 kind s r
  census "$SRC_PSQL" "$SRC_CONTAINER" "$WORK/src"
  census tpsql "$C_TARGET" "$WORK/dst"

  printf '\n    %-12s %8s %8s %8s\n' "object" "source" "restored" "delta"
  printf '    %-12s %8s %8s %8s\n' "------------" "--------" "--------" "--------"
  for kind in table view matview sequence index function constraint policy trigger enum; do
    s=$(grep -cE "^$kind"$'\t' "$WORK/src.objects" || true)
    r=$(grep -cE "^$kind"$'\t' "$WORK/dst.objects" || true)
    printf '    %-12s %8s %8s %8s\n' "$kind" "$s" "$r" "$((r - s))"
    [ "$s" -ne "$r" ] && bad=1
  done
  printf '\n'

  comm -23 <(sort "$WORK/src.objects") <(sort "$WORK/dst.objects") > "$WORK/only-source"
  comm -13 <(sort "$WORK/src.objects") <(sort "$WORK/dst.objects") > "$WORK/only-restored"
  if [ -s "$WORK/only-source" ]; then
    bad=1
    err "present in source, missing from restore ($(wc -l < "$WORK/only-source")):"
    sed 's/^/      - /' "$WORK/only-source" | head -40 >&2
  fi
  if [ -s "$WORK/only-restored" ]; then
    bad=1
    err "present in restore, absent from source ($(wc -l < "$WORK/only-restored")):"
    sed 's/^/      + /' "$WORK/only-restored" | head -40 >&2
  fi

  if [ "$ROW_COUNTS" = "1" ]; then
    local total
    total=$(awk -F'\t' '{n += $2} END {print n + 0}' "$WORK/src.rows")
    if ! diff -u "$WORK/src.rows" "$WORK/dst.rows" > "$WORK/rows.diff"; then
      bad=1
      err "row counts differ:"
      grep -E '^[-+][^-+]' "$WORK/rows.diff" | sed 's/^/      /' | head -40 >&2
    elif [ "$total" -eq 0 ]; then
      note "row counts match, but every table is empty: this dump carries no data"
    else
      ok "row counts match on $(wc -l < "$WORK/src.rows") tables, $total rows total"
    fi
  fi

  [ "$bad" -eq 0 ] && ok "$label: source and restore agree on every object"
  return "$bad"
}

log "verifying restore against source"
t0=$(now_ms)
VERIFY_OK=1
compare "restore" || VERIFY_OK=0
record "verify" $(( $(now_ms) - t0 ))

# ---------------------------------------------------------------- self test

SELFTEST_OK=1
if [ "$SELF_TEST" = "1" ]; then
  log "self test: damaging the restored copy, expecting the comparison to notice"
  # DROP without CASCADE: a function a policy or trigger depends on refuses,
  # and dropping it with CASCADE would remove that dependant too and muddy the
  # expected difference. Walk candidates until one drops alone.
  victim_fn=""
  while read -r sig; do
    [ -z "$sig" ] && continue
    if tpsql "$C_TARGET" -q -c "DROP FUNCTION $sig" >/dev/null 2>&1; then
      victim_fn="$sig"; break
    fi
  done < <(grep -E "^function"$'\t' "$WORK/dst.objects" | cut -f2 | head -40)
  [ -n "$victim_fn" ] && note "dropped function $victim_fn"

  victim_tbl=""
  if [ "$ROW_COUNTS" = "1" ]; then
    while IFS=$'\t' read -r t n; do
      [ "${n:-0}" -gt 0 ] || continue
      if tpsql "$C_TARGET" -q -c \
        "DELETE FROM $t WHERE ctid IN (SELECT ctid FROM $t LIMIT 1)" >/dev/null 2>&1; then
        victim_tbl="$t"; break
      fi
    done < "$WORK/dst.rows"
    [ -n "$victim_tbl" ] && note "deleted 1 row from $victim_tbl"
  fi

  if [ -z "$victim_fn" ] && [ -z "$victim_tbl" ]; then
    err "self test could not damage anything; verification is unproven"
    SELFTEST_OK=0
  elif compare "self test" > "$WORK/selftest.out" 2>&1; then
    err "self test: the comparison reported no difference after damage"
    SELFTEST_OK=0
  else
    log "self test: comparison output after damage"
    sed 's/^/  /' "$WORK/selftest.out"
    ok "self test: verification reports the damage"
  fi
fi

# ---------------------------------------------------------------- report

T_ALL=$(( $(now_ms) - T_ALL0 ))
printf '\n'
log "phase timings"
recovery=0
for i in "${!PHASE_NAMES[@]}"; do
  printf '    %-20s %10s\n' "${PHASE_NAMES[$i]}" "$(fmt_ms "${PHASE_MS[$i]}")"
  case "${PHASE_NAMES[$i]}" in
    "start target"|prerequisites|restore) recovery=$(( recovery + PHASE_MS[i] )) ;;
  esac
done
printf '    %-20s %10s\n' "--------------------" "----------"
printf '    %-20s %10s\n' "recovery window" "$(fmt_ms "$recovery")"
printf '    %-20s %10s\n' "drill total" "$(fmt_ms "$T_ALL")"
note "recovery window = fresh instance + prerequisites + restore; it excludes"
note "taking the dump, which happens before the outage, and excludes verify."

if [ "$RESTORE_CLEAN" = "1" ] && [ "$VERIFY_OK" = "1" ] && [ "$SELFTEST_OK" = "1" ]; then
  printf '\n'; ok "restore drill passed"
  exit 0
fi
printf '\n'; err "restore drill failed"
exit 1
