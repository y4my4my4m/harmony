#!/usr/bin/env bash
# Regenerates db_schema/REACHABILITY.tsv, the entry-point graph of the public
# schema.
#
# The backend is Postgres functions. SURFACE.tsv says which exist; this says how
# execution enters each one - an RPC from application code, a trigger firing, an
# RLS policy evaluating, a view or default or check or index expanding, a cron
# job, or another function already reachable by one of those. A function with no
# entry point is dead; a function with no entry point that anon may still
# EXECUTE is an unauthenticated HTTP endpoint nothing calls.
#
# The graph is built from a fresh init/ build in a throwaway container, so it
# describes what a new install exposes, not what one instance has accumulated.
#
#   generate-reachability.sh           write db_schema/REACHABILITY.tsv
#   generate-reachability.sh --check   write it and fail if it changed
set -euo pipefail

IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
CONTAINER="${CONTAINER_NAME:-harmony-reachability}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/db_schema/REACHABILITY.tsv"
WORK="$(mktemp -d)"
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

log "starting $IMAGE as $CONTAINER"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null

# The unix socket accepts connections before TCP does, and compat runs over TCP
# as supabase_admin. Wait on the connection that is actually used.
ok=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 5 ] && break
  else ok=0; fi
  sleep 2
done
[ "$ok" -ge 5 ] || { err "postgres never stabilised"; docker logs "$CONTAINER" 2>&1 | tail -20 >&2; exit 1; }

log "building schema from init/"
docker exec "$CONTAINER" rm -rf /db_schema
docker cp "$ROOT/db_schema" "$CONTAINER:/db_schema" >/dev/null
docker cp "$ROOT/scripts/test-db/supabase-compat.sql" "$CONTAINER:/compat.sql" >/dev/null
# compat creates realtime.messages. Without it 98_enable_rls.sql skips the
# policies on that table and can_subscribe_to_topic, whose only entry point is
# one of them, reads as unreachable.
docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -q -v ON_ERROR_STOP=1 -f /compat.sql >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -tAc \
  "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='realtime' AND c.relname='messages'" | grep -q 1 || {
  err "realtime.messages missing after compat; realtime policies would be absent"
  exit 1
}
docker exec -w /db_schema/init "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f init.sql >/dev/null

cat > "$WORK/reach-query.sql" <<'SQL'
-- Emits the raw edges of the reachability graph, one record per line, tagged by
-- kind and separated by '|'.
--
--   FN     oid | name | args | returns | security | volatility | proconfig | grants
--   TRG    function oid | table | trigger name | timing and events
--   POL    function oid | table | policy name | command
--   DEP    function oid | kind | object
--   EDGE   caller oid | callee oid
--
-- Declarative references come from pg_depend, which records what a view, a
-- default, a check, an index or a policy expression actually compiled against.
-- Call edges cannot: a plpgsql body is an opaque string to the catalog and is
-- never parsed at CREATE, so those are matched out of prosrc by name.
\pset tuples_only on
\pset format unaligned
\pset footer off

SELECT 'FN|' || p.oid
       || '|' || p.proname
       || '|' || replace(pg_get_function_identity_arguments(p.oid), '|', '/')
       || '|' || replace(pg_get_function_result(p.oid), '|', '/')
       || '|' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END
       || '|' || CASE p.provolatile WHEN 'i' THEN 'immutable'
                                    WHEN 's' THEN 'stable' ELSE 'volatile' END
       || '|' || coalesce(array_to_string(p.proconfig, ' '), '')
       || '|' || concat_ws('+',
                    CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'anon' END,
                    CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'authenticated' END,
                    CASE WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') THEN 'service_role' END)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prokind = 'f'
 ORDER BY p.proname, p.oid;

-- tgtype bits, from src/include/catalog/pg_trigger.h:
-- 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE, 64 INSTEAD OF.
SELECT 'TRG|' || t.tgfoid
       || '|' || n.nspname || '.' || c.relname
       || '|' || t.tgname
       || '|' || concat_ws(' ',
                    CASE WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF'
                         WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' ELSE 'AFTER' END,
                    concat_ws('/',
                       CASE WHEN (t.tgtype & 4) <> 0 THEN 'INSERT' END,
                       CASE WHEN (t.tgtype & 8) <> 0 THEN 'DELETE' END,
                       CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' END,
                       CASE WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE' END),
                    CASE WHEN (t.tgtype & 1) = 0 THEN 'STATEMENT' END)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal
 ORDER BY 1;

-- Policy predicates are matched textually as well as through pg_depend: the
-- dependency is exact, the text match also catches a name reached through a
-- default argument or an operator the dependency records against something
-- other than the function.
SELECT DISTINCT 'POL|' || p.oid
       || '|' || n.nspname || '.' || c.relname
       || '|' || pol.polname
       || '|' || CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                                 WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                                 ELSE 'ALL' END
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.prokind = 'f'
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' '
       || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
       ~ ('(^|[^a-zA-Z0-9_.])(public\.)?' || p.proname || '[[:space:]]*\(')
 ORDER BY 1;

SELECT DISTINCT 'POL|' || d.refobjid
       || '|' || n.nspname || '.' || c.relname
       || '|' || pol.polname
       || '|' || CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                                 WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                                 ELSE 'ALL' END
  FROM pg_depend d
  JOIN pg_policy pol ON pol.oid = d.objid AND d.classid = 'pg_policy'::regclass
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = d.refobjid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE d.refclassid = 'pg_proc'::regclass
 ORDER BY 1;

SELECT DISTINCT 'DEP|' || d.refobjid
       || '|' || CASE v.relkind WHEN 'm' THEN 'matview' WHEN 'v' THEN 'view' ELSE 'rule' END
       || '|' || vn.nspname || '.' || v.relname
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
  JOIN pg_class v ON v.oid = r.ev_class
  JOIN pg_namespace vn ON vn.oid = v.relnamespace
  JOIN pg_proc p ON p.oid = d.refobjid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE d.refclassid = 'pg_proc'::regclass
 ORDER BY 1;

-- A generated column stores its expression in pg_attrdef like a default does;
-- attgenerated tells them apart.
SELECT DISTINCT 'DEP|' || d.refobjid
       || '|' || CASE WHEN a.attgenerated <> '' THEN 'generated' ELSE 'default' END
       || '|' || tn.nspname || '.' || t.relname || '.' || a.attname
  FROM pg_depend d
  JOIN pg_attrdef ad ON ad.oid = d.objid AND d.classid = 'pg_attrdef'::regclass
  JOIN pg_class t ON t.oid = ad.adrelid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
  JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
  JOIN pg_proc p ON p.oid = d.refobjid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE d.refclassid = 'pg_proc'::regclass
 ORDER BY 1;

SELECT DISTINCT 'DEP|' || d.refobjid
       || '|' || CASE con.contype WHEN 'c' THEN 'check' ELSE 'constraint' END
       || '|' || coalesce(cn.nspname || '.' || cc.relname || ' ', '') || con.conname
  FROM pg_depend d
  JOIN pg_constraint con ON con.oid = d.objid AND d.classid = 'pg_constraint'::regclass
  LEFT JOIN pg_class cc ON cc.oid = con.conrelid
  LEFT JOIN pg_namespace cn ON cn.oid = cc.relnamespace
  JOIN pg_proc p ON p.oid = d.refobjid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE d.refclassid = 'pg_proc'::regclass
 ORDER BY 1;

SELECT DISTINCT 'DEP|' || d.refobjid
       || '|index|' || ci.relname || ' on ' || tn.nspname || '.' || t.relname
  FROM pg_depend d
  JOIN pg_class ci ON ci.oid = d.objid AND d.classid = 'pg_class'::regclass AND ci.relkind = 'i'
  JOIN pg_index i ON i.indexrelid = ci.oid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
  JOIN pg_proc p ON p.oid = d.refobjid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE d.refclassid = 'pg_proc'::regclass
 ORDER BY 1;

-- The same three, matched textually. pg_depend is authoritative about what
-- compiled against a function; these catch a reference the dependency records
-- against something else, and they are what makes "no view, default or index
-- reaches a function" a measurement rather than an assumption about classids.
SELECT DISTINCT 'DEP|' || p.oid
       || '|' || CASE v.relkind WHEN 'm' THEN 'matview' ELSE 'view' END
       || '|' || vn.nspname || '.' || v.relname
  FROM pg_class v
  JOIN pg_namespace vn ON vn.oid = v.relnamespace
  JOIN pg_proc p ON p.prokind = 'f'
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE v.relkind IN ('v', 'm')
   AND pg_get_viewdef(v.oid) ~ ('(^|[^a-zA-Z0-9_.])(public\.)?' || p.proname || '[[:space:]]*\(')
 ORDER BY 1;

SELECT DISTINCT 'DEP|' || p.oid
       || '|' || CASE WHEN a.attgenerated <> '' THEN 'generated' ELSE 'default' END
       || '|' || tn.nspname || '.' || t.relname || '.' || a.attname
  FROM pg_attrdef ad
  JOIN pg_class t ON t.oid = ad.adrelid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
  JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
  JOIN pg_proc p ON p.prokind = 'f'
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE pg_get_expr(ad.adbin, ad.adrelid)
       ~ ('(^|[^a-zA-Z0-9_.])(public\.)?' || p.proname || '[[:space:]]*\(')
 ORDER BY 1;

SELECT DISTINCT 'DEP|' || p.oid
       || '|index|' || ci.relname || ' on ' || tn.nspname || '.' || t.relname
  FROM pg_index i
  JOIN pg_class ci ON ci.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
  JOIN pg_proc p ON p.prokind = 'f'
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE coalesce(pg_get_expr(i.indexprs, i.indrelid), '') || ' '
       || coalesce(pg_get_expr(i.indpred, i.indrelid), '')
       ~ ('(^|[^a-zA-Z0-9_.])(public\.)?' || p.proname || '[[:space:]]*\(')
 ORDER BY 1;

-- A WHEN clause runs before the handler and can name a different function.
SELECT DISTINCT 'DEP|' || d.refobjid
       || '|trigger-when|' || tn.nspname || '.' || tc.relname || ' ' || t.tgname
  FROM pg_depend d
  JOIN pg_trigger t ON t.oid = d.objid AND d.classid = 'pg_trigger'::regclass
  JOIN pg_class tc ON tc.oid = t.tgrelid
  JOIN pg_namespace tn ON tn.oid = tc.relnamespace
  JOIN pg_proc p ON p.oid = d.refobjid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE d.refclassid = 'pg_proc'::regclass
   AND t.tgfoid <> d.refobjid
 ORDER BY 1;

-- Anything else that compiled against a public function: operators, casts,
-- aggregates, event triggers, transforms. Empty in a stock build; a silent
-- omission here would read as dead code.
SELECT DISTINCT 'DEP|' || d.refobjid
       || '|' || d.classid::regclass::text || '|' || d.objid
  FROM pg_depend d
  JOIN pg_proc p ON p.oid = d.refobjid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace AND pn.nspname = 'public'
 WHERE d.refclassid = 'pg_proc'::regclass
   AND d.classid NOT IN ('pg_rewrite'::regclass, 'pg_attrdef'::regclass,
                         'pg_constraint'::regclass, 'pg_class'::regclass,
                         'pg_trigger'::regclass, 'pg_policy'::regclass,
                         'pg_proc'::regclass, 'pg_type'::regclass,
                         'pg_namespace'::regclass, 'pg_language'::regclass,
                         'pg_extension'::regclass)
 ORDER BY 1;

-- Call edges. prosrc is text to the catalog, so a name followed by an open
-- paren is the only available signal; it also catches names inside EXECUTE
-- strings, which is correct - those are calls too. A leading dot excludes
-- schema-qualified references to something else, `public.` is allowed through.
SELECT 'EDGE|' || c.oid || '|' || e.oid
  FROM pg_proc c
  JOIN pg_namespace cn ON cn.oid = c.pronamespace
  JOIN pg_proc e ON e.prokind = 'f' AND e.proname <> c.proname
  JOIN pg_namespace en ON en.oid = e.pronamespace AND en.nspname = 'public'
 WHERE c.prokind = 'f'
   AND cn.nspname IN ('public', 'auth', 'storage', 'realtime', 'cron', 'graphql_public')
   AND strpos(c.prosrc, e.proname) > 0
   AND c.prosrc ~ ('(^|[^a-zA-Z0-9_.])(public\.)?' || e.proname || '[[:space:]]*\(')
 ORDER BY 1;

-- Callers outside public are named so a cross-schema edge is not silently
-- attributed to a public function of the same name.
SELECT 'XFN|' || p.oid || '|' || n.nspname || '.' || p.proname
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('auth', 'storage', 'realtime', 'cron', 'graphql_public')
   AND p.prokind = 'f'
 ORDER BY 1;
SQL

log "querying the catalog"
docker cp "$WORK/reach-query.sql" "$CONTAINER:/reach-query.sql" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /reach-query.sql > "$WORK/catalog.txt"
grep -c '^FN|' "$WORK/catalog.txt" >/dev/null || { err "catalog query produced no functions"; exit 1; }

log "resolving reachability"
python3 - "$ROOT" "$WORK/catalog.txt" <<'PY' > "$WORK/REACHABILITY.tsv"
"""Turns the catalog records into db_schema/REACHABILITY.tsv.

Roots are the ways execution enters the database from outside a function body:
an RPC from application code, a trigger, an RLS policy, a view or default or
check or index expression, a cron schedule. Everything else is reached only by
being called, so the answer is a traversal from those roots across the call
graph. Dead code calling dead code stays dead; a helper called only from a live
trigger handler is live.

The result is grouped by subsystem, which is derived from the function name.
Names here are domain-prefixed, so the rules below are stable, but they are a
reading aid and nothing depends on them being right.
"""
import os
import re
import sys
from collections import defaultdict

ROOT = sys.argv[1]
CATALOG = sys.argv[2]

# The workers call RPCs directly; scanning only src/ marks their endpoints
# uncalled and makes them look droppable.
CALLER_ROOTS = ("src", "federation-backend/src", "bot-gateway/src")
SRC_EXTENSIONS = (".ts", ".tsx", ".js", ".mjs", ".vue")

# First match wins. Ordered from the most specific domain to the least, so a
# broadcast trigger for a key request lands in Realtime rather than Encryption.
SUBSYSTEMS = [
    ("Realtime broadcast", r"^broadcast_|subscribe_to_topic"),
    ("Federation and ActivityPub", r"federat|activitypub|^ap_|_ap_|_to_ap$|remote|_instance\b|by_instance|webfinger"),
    ("Encryption, devices and keys", r"encryption|prekey|megolm|e2ee|device|signing_key|key_pair|key_request|key_generation|key_consistency|public_keys|recovery|_mfa|session_share|epoch|room_member"),
    ("Voice and LiveKit", r"voice|livekit|_call|latency"),
    ("Funding and supporters", r"supporter|donation|funding|gif_ads"),
    ("Notifications and push", r"notification|push|endpoint|announcement"),
    ("Moderation and administration", r"moderat|report|_ban|ban_|kick|suspend|admin|blocked|block_|_block|muted|mute_|_mute|protected_role|sensitive"),
    ("Bots and bridges", r"bot|discord_bridge|pairing"),
    ("Emoji and reactions", r"emoji|reaction"),
    ("Servers, channels and roles", r"server|channel|categor|role|permission|invite|member|folder|slug|group_icon|group_name"),
    ("Messaging and conversations", r"message|conversation|thread|_dm_|_dm$|^dm_|pin_|_pinned|unread|slowmode|typing"),
    ("Posts, timeline and trending", r"post|timeline|follow|reblog|feed|hashtag|trending"),
    ("Search and indexing", r"search|index_"),
    ("Presence, sessions and status", r"session|presence|status|heartbeat|viewing|view_context"),
    ("Metrics and maintenance", r"metric|slow_query|recorded_at|db_size|db_connection|cleanup|purge|maintenance|aggregate"),
    ("Instance configuration", r"instance_config|instance_domain|config"),
    ("Text, embeds and formatting", r"sanitize|slugify|extract_|normalize_|jsonb_text|embed|link_preview|url|handle|mention"),
    ("Profiles and accounts", r"profile|user|account"),
]


def subsystem(name):
    for label, pattern in SUBSYSTEMS:
        if re.search(pattern, name):
            return label
    return "Uncategorised"


class Fn:
    __slots__ = ("oid", "name", "args", "returns", "security", "volatility",
                 "config", "grants")

    def __init__(self, oid, name, args, returns, security, volatility, config, grants):
        self.oid, self.name, self.args = oid, name, args
        self.returns, self.security, self.volatility = returns, security, volatility
        self.config, self.grants = config, set(grants.split("+")) - {""}

    @property
    def is_trigger(self):
        return self.returns == "trigger"


def read_catalog(path):
    fns, xfns = {}, {}
    triggers, policies, deps, edges = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(set)
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.rstrip("\n")
        if not line or "|" not in line:
            continue
        tag, rest = line.split("|", 1)
        if tag == "FN":
            f = rest.split("|", 7)
            fns[f[0]] = Fn(*f)
        elif tag == "XFN":
            oid, name = rest.split("|", 1)
            xfns[oid] = name
        elif tag == "TRG":
            oid, table, tgname, events = rest.split("|", 3)
            triggers[oid].append((table, tgname, events))
        elif tag == "POL":
            oid, table, polname, cmd = rest.split("|", 3)
            policies[oid].append((table, polname, cmd))
        elif tag == "DEP":
            oid, kind, obj = rest.split("|", 2)
            deps[oid].append((kind, obj))
        elif tag == "EDGE":
            caller, callee = rest.split("|", 1)
            edges[caller].add(callee)
    return fns, xfns, triggers, policies, deps, edges


def scan_callers():
    """Where application code names each function.

    Two strengths. A literal inside rpc() is a call. A bare quoted string is
    only evidence: postReactions.ts picks between add_ and
    remove_post_emoji_reaction with a ternary and passes the result to rpc(),
    so the narrow form alone would classify a live endpoint as an internal
    helper. Both count as reachable - a false 'dead' drops a live endpoint,
    a false 'live' costs a line in this file.
    """
    strong, weak = defaultdict(set), defaultdict(set)
    rpc_call = re.compile(r"""rpc\(\s*['"`]([a-z0-9_]{4,})['"`]""")
    quoted = re.compile(r"""['"`]([a-z0-9_]{4,})['"`]""")
    for sub in CALLER_ROOTS:
        start = os.path.join(ROOT, sub)
        for base, dirs, files in os.walk(start):
            dirs[:] = [d for d in dirs if d not in ("node_modules", "dist", ".git")]
            for fname in sorted(files):
                if not fname.endswith(SRC_EXTENSIONS):
                    continue
                path = os.path.join(base, fname)
                rel = os.path.relpath(path, ROOT)
                try:
                    text = open(path, encoding="utf-8", errors="replace").read()
                except OSError:
                    continue
                for m in rpc_call.finditer(text):
                    strong[m.group(1)].add(rel)
                for m in quoted.finditer(text):
                    weak[m.group(1)].add(rel)
    return strong, weak


CRON_SCHEDULE = re.compile(
    r"cron\.schedule\(\s*(?:'([^']*)'|\$\$(.*?)\$\$)\s*,\s*'([^']*)'\s*,\s*"
    r"(?:'((?:[^']|'')*)'|\$\$(.*?)\$\$)",
    re.S,
)


def scan_cron():
    """Cron jobs as init/ declares them.

    Read from the file, not from cron.job: 99_cron_jobs.sql schedules nothing
    when pg_cron is absent, and whether the extension loads in a throwaway
    container is not a property of the schema.
    """
    jobs = []
    d = os.path.join(ROOT, "db_schema", "init")
    for fname in sorted(os.listdir(d)):
        if not fname.endswith(".sql"):
            continue
        text = open(os.path.join(d, fname), encoding="utf-8", errors="replace").read()
        for m in CRON_SCHEDULE.finditer(text):
            name = m.group(1) or m.group(2) or ""
            command = m.group(4) or m.group(5) or ""
            jobs.append((name.strip(), m.group(3).strip(), " ".join(command.split())))
    return sorted(set(jobs))


def main():
    fns, xfns, triggers, policies, deps, edges = read_catalog(CATALOG)
    strong, weak = scan_callers()
    cron_jobs = scan_cron()

    by_name = defaultdict(list)
    for f in fns.values():
        by_name[f.name].append(f)

    callers = defaultdict(set)
    for caller, callees in edges.items():
        for callee in callees:
            callers[callee].add(caller)

    # Direct entry points, keyed by oid. Each is (kind, detail).
    direct = defaultdict(list)
    for oid, rows in triggers.items():
        if oid not in fns:
            continue
        for table, tgname, events in sorted(rows):
            direct[oid].append(("trigger", "%s %s (%s)" % (table, events, tgname)))
    for oid, rows in policies.items():
        for table, polname, cmd in sorted(set(rows)):
            direct[oid].append(("policy", "%s %s on %s" % (table, cmd, polname)))
    for oid, rows in deps.items():
        for kind, obj in sorted(set(rows)):
            direct[oid].append((kind, obj))
    for name, schedule, command in cron_jobs:
        for f in fns.values():
            if re.search(r"(^|[^\w.])(public\.)?" + re.escape(f.name) + r"\s*\(", command):
                direct[f.oid].append(("cron", "%s (%s)" % (schedule, name or "unnamed")))
    for fname, files in strong.items():
        for f in by_name.get(fname, []):
            direct[f.oid].append(("rpc", ", ".join(sorted(files))))
    for fname, files in weak.items():
        if fname in strong:
            continue
        for f in by_name.get(fname, []):
            direct[f.oid].append(("named-in-client", ", ".join(sorted(files))))

    # Traverse from the roots. A function inherits the entry kinds of everything
    # that calls it, so a helper under a trigger handler comes out trigger-reached.
    KIND_GROUP = {
        "rpc": "client", "named-in-client": "client",
        "trigger": "trigger", "trigger-when": "trigger",
        "policy": "policy", "cron": "cron",
        "view": "declarative", "matview": "declarative", "rule": "declarative",
        "default": "declarative", "generated": "declarative",
        "check": "declarative", "constraint": "declarative", "index": "declarative",
    }
    reached = defaultdict(set)   # oid -> set of entry groups
    queue = []
    for oid, entries in direct.items():
        groups = {KIND_GROUP.get(k, "other") for k, _ in entries}
        reached[oid] |= groups
        queue.append((oid, groups))
    # A function in auth, storage or realtime is driven by its own service, so a
    # public function called from one is entered through it.
    for oid in xfns:
        if oid in edges:
            reached[oid].add("other-schema")
            queue.append((oid, {"other-schema"}))

    while queue:
        oid, groups = queue.pop(0)
        for callee in sorted(edges.get(oid, ())):
            if not groups - reached[callee]:
                continue
            reached[callee] |= groups
            queue.append((callee, reached[callee]))

    def label(f):
        if len(by_name[f.name]) > 1:
            return "%s(%s)" % (f.name, f.args)
        return f.name

    def clip(items, limit=3):
        items = list(items)
        shown = ", ".join(items[:limit])
        if len(items) > limit:
            shown += ", +%d" % (len(items) - limit)
        return shown

    def detail(f):
        parts = []
        by_kind = defaultdict(list)
        for kind, obj in direct.get(f.oid, []):
            by_kind[kind].append(obj)
        for kind in sorted(by_kind):
            objs = by_kind[kind]
            if kind in ("rpc", "named-in-client"):
                files = sorted({p for obj in objs for p in obj.split(", ")})
                parts.append(("rpc in %s" if kind == "rpc" else "named in %s") % clip(files))
            else:
                parts.append("%s %s" % (kind, clip(sorted(set(objs)))))
        if not parts:
            names = sorted({fns[c].name if c in fns else xfns.get(c, c)
                            for c in callers.get(f.oid, ())})
            if names:
                parts.append("called by %s" % clip(names))
        if not parts:
            parts.append("nothing references it")
        return "; ".join(parts)

    def classify(f):
        """Where a function sits when the call graph reaches it from nowhere.

        A trigger function is not an HTTP endpoint whatever its grants say:
        PostgREST does not route to one and SELECT of one raises 0A000. For the
        rest the widest role holding EXECUTE decides, since PostgREST publishes
        every function in public and checks nothing else.
        """
        if reached.get(f.oid):
            return "reachable"
        if f.is_trigger:
            return "dead"
        for role in ("anon", "authenticated", "service_role"):
            if role in f.grants:
                return "http-" + role
        return "dead"

    ENTERED = {"http-anon": "http anon", "http-authenticated": "http authenticated",
               "http-service_role": "service key", "dead": "nothing"}
    entered = {}
    for f in fns.values():
        groups = sorted(reached.get(f.oid, set()))
        entered[f.oid] = ", ".join(groups) if groups else ENTERED[classify(f)]

    ordered = sorted(fns.values(), key=lambda f: (f.name, f.args))

    out = []
    w = out.append
    w("# Function reachability \u2014 generated, do not edit by hand.")
    w("# Regenerate: scripts/generate-reachability.sh")
    w("#")
    w("# How execution enters every function in a schema built from db_schema/init/.")
    w("# entry is a comma-separated set of entry kinds. `http anon` and `service key`")
    w("# mean nothing reaches it and PostgREST publishes it anyway; `nothing` means dead.")
    w("#")
    w("# name\tsecurity\treturns\tgrants\tentry\tdetail")
    for f in ordered:
        w("\t".join([
            label(f),
            f.security,
            f.returns.replace("\t", " "),
            "+".join(sorted(f.grants)) or "-",
            entered.get(f.oid, "nothing"),
            (detail(f) or "-").replace("\t", " "),
        ]))
    print("\n".join(out))


main()
PY

if [ "$CHECK" = "1" ] && [ -f "$OUT" ]; then
  if ! diff -u "$OUT" "$WORK/REACHABILITY.tsv" > "$WORK/diff.txt"; then
    cp "$WORK/REACHABILITY.tsv" "$OUT"
    err "db_schema/REACHABILITY.tsv was out of date; regenerated"
    cat "$WORK/diff.txt" >&2
    exit 1
  fi
fi

cp "$WORK/REACHABILITY.tsv" "$OUT"
log "wrote $OUT"
