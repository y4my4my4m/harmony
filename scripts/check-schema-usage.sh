#!/usr/bin/env bash
# Every table and column the application reaches through the Supabase client
# must exist in a schema built from init/.
#
# check-rpc-coverage.sh asks this of functions. Nothing asked it of relations,
# so init/ carried a public.federated_voice_calls with channel_id/participants/
# sfu_url while federation-backend selected caller_federated_id/livekit_url/
# room_name from it. PostgREST answers 42703 at runtime; TypeScript cannot see
# the database, so the type check passed and a fresh install was broken.
#
# Names come from `.from('t')` chains: select lists including embeds, insert and
# update and upsert keys, onConflict, filter and order and match arguments.
# String constants and template literals are resolved when every hole resolves.
# What cannot be read statically -- a chain built across variables, a payload
# passed as an object, a column name interpolated at runtime -- is counted and
# reported, never silently dropped. ALLOW_DYNAMIC below carries the pairs that
# only a human can see, in the same spirit as check-rpc-coverage.sh.
#
#   check-schema-usage.sh              against a fresh init/ build (the CI gate)
#   check-schema-usage.sh --dump FILE  against a pg_dump of a live instance
#   check-schema-usage.sh --skipped    list every unparseable reference
#
# --dump restores the dump into a throwaway container and asks the same
# question of it. A fresh build having every column says nothing about the
# instance users are on. CI cannot run it - there is no dump in CI - so it is an
# operator check, run before and after converging an instance.
#
# REUSE_CONTAINER=1 skips the build when $CONTAINER_NAME already answers.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
CONTAINER="${CONTAINER_NAME:-harmony-usagecheck}"
KEEP="${KEEP_CONTAINER:-0}"
REUSE="${REUSE_CONTAINER:-0}"
DUMP=""
SHOW_SKIPPED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dump) DUMP="${2:-}"; shift 2 ;;
    --skipped) SHOW_SKIPPED=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

# Pairs no parser can see: a table name passed as a parameter, a column name
# assembled at runtime. Each is `table.column`, or `table` for existence alone.
# federation-backend/src/queue/handlers/*.ts share an updateFederationStatus(id,
# table, status) that writes federation_status through .from(table); the seven
# tables are its literal call sites.
ALLOW_DYNAMIC="
follows.federation_status follows.id
messages.federation_status messages.id
post_interactions.federation_status post_interactions.id
posts.federation_status posts.id
reactions.federation_status reactions.id
reports.federation_status reports.id
user_blocks.federation_status user_blocks.id
"

if [ -n "$DUMP" ]; then
  [ -r "$DUMP" ] || { err "cannot read dump: $DUMP"; exit 2; }
  TARGET="$DUMP"
else
  TARGET="a fresh init/ build"
fi
cleanup() { [ "$KEEP" = "1" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

running=0
if [ "$REUSE" = "1" ] &&
   docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1; then
  running=1
  log "reusing $CONTAINER"
fi

if [ "$running" = "0" ]; then
  log "starting $IMAGE"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null

  # The unix socket accepts connections before TCP does. A restore started too
  # early reports success against an empty database.
  ok=0
  for _ in $(seq 1 120); do
    if docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1; then
      ok=$((ok + 1)); [ "$ok" -ge 5 ] && break
    else ok=0; fi
    sleep 2
  done
  [ "$ok" -ge 5 ] || { err "postgres never stabilised"; docker logs "$CONTAINER" 2>&1 | tail -20 >&2; exit 1; }

  if [ -n "$DUMP" ]; then
    log "restoring $DUMP"
    docker cp "$DUMP" "$CONTAINER:/dump.sql" >/dev/null
    docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -q -f /dump.sql >/dev/null 2>&1 || true
  else
    log "building a schema from init/"
    docker exec "$CONTAINER" rm -rf /db_schema
    docker cp "$ROOT/db_schema" "$CONTAINER:/db_schema" >/dev/null
    docker cp "$ROOT/scripts/test-db/supabase-compat.sql" "$CONTAINER:/compat.sql" >/dev/null
    docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -q -f /compat.sql >/dev/null 2>&1 || true
    docker exec -w /db_schema/init "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f init.sql >/dev/null
  fi
fi

# relkind r,p,v,m,f: tables, partitioned tables, views, matviews, foreign
# tables. information_schema omits matviews and hides what the role cannot see.
FACTS="${TMPDIR:-/tmp}/harmony-schema-facts-$CONTAINER.tsv"
docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAF$'\t' -c "
  SELECT 'c', c.relname, a.attname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
     AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'r', c.relname, c.relkind::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
  UNION ALL
  SELECT 'f', con.conname, cl.relname || ' ' || fcl.relname || ' ' ||
         (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
            FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum)
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class fcl ON fcl.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = con.connamespace
   WHERE con.contype = 'f' AND n.nspname = 'public'
" > "$FACTS"

grep -q '^r' "$FACTS" || { err "no relations found in $TARGET"; exit 2; }

log "reading table and column use from the application"
python3 - "$ROOT" "$FACTS" "$TARGET" "$SHOW_SKIPPED" "$ALLOW_DYNAMIC" <<'PY'
import os, re, sys

ROOT, FACTS, TARGET, SHOW_SKIPPED, ALLOW = sys.argv[1:6]
SUBS = ('src', 'federation-backend/src', 'bot-gateway/src')

FILTERS = {
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'likeAllOf', 'likeAnyOf',
    'ilikeAllOf', 'ilikeAnyOf', 'is', 'in', 'contains', 'containedBy', 'overlaps',
    'rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent', 'textSearch',
    'order', 'filter', 'not',
}
WRITERS = {'insert', 'update', 'upsert'}
KNOWN = {
    'select', 'delete', 'match', 'or', 'single', 'maybeSingle', 'limit', 'range',
    'throwOnError', 'csv', 'geojson', 'explain', 'rollback', 'returns', 'then',
    'catch', 'finally', 'abortSignal', 'setHeader', 'overrideTypes', 'headers',
} | FILTERS | WRITERS

COLNAME = re.compile(r'^[a-z_][a-z0-9_]*$')
IDENT = re.compile(r'[A-Za-z_$][A-Za-z_$0-9]*')


# ------------------------------------------------------------------ lexing

def lex(src):
    """JS/TS token stream: ('id'|'str'|'dyn'|'punc', text). 'dyn' keeps ${} raw."""
    toks, i, n, prev = [], 0, len(src), None
    while i < n:
        c = src[i]
        if c in ' \t\r\n':
            i += 1
            continue
        if src.startswith('//', i):
            i = src.find('\n', i)
            if i < 0:
                break
            continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c == '/':
            # A regex literal can only start where a value cannot precede it.
            ok = prev is None or (prev[0] == 'punc' and prev[1] not in ')]}') or \
                (prev[0] == 'id' and prev[1] in ('return', 'typeof', 'case', 'in', 'of', 'new'))
            if ok:
                j, cls = i + 1, False
                while j < n:
                    d = src[j]
                    if d == '\\':
                        j += 2
                        continue
                    if d == '[':
                        cls = True
                    elif d == ']':
                        cls = False
                    elif d == '\n':
                        j = -1
                        break
                    elif d == '/' and not cls:
                        break
                    j += 1
                if 0 < j < n:
                    i = j + 1
                    while i < n and src[i].isalpha():
                        i += 1
                    prev = ('punc', 'regex')
                    toks.append(prev)
                    continue
            prev = ('punc', '/')
            toks.append(prev)
            i += 1
            continue
        if c in '"\'':
            j, buf = i + 1, []
            while j < n and src[j] not in (c, '\n'):
                if src[j] == '\\':
                    buf.append(src[j + 1] if j + 1 < n else '')
                    j += 2
                    continue
                buf.append(src[j])
                j += 1
            prev = ('str', ''.join(buf))
            toks.append(prev)
            i = j + 1
            continue
        if c == '`':
            j, dyn = i + 1, False
            while j < n and src[j] != '`':
                if src[j] == '\\':
                    j += 2
                    continue
                if src.startswith('${', j):
                    dyn = True
                    d, j = 1, j + 2
                    while j < n and d:
                        if src[j] == '{':
                            d += 1
                        elif src[j] == '}':
                            d -= 1
                        elif src[j] in '"\'`':
                            q, j = src[j], j + 1
                            while j < n and src[j] != q:
                                j += 2 if src[j] == '\\' else 1
                        j += 1
                    continue
                j += 1
            prev = ('dyn' if dyn else 'str', src[i + 1:j])
            toks.append(prev)
            i = j + 1
            continue
        m = IDENT.match(src, i)
        if m:
            prev = ('id', m.group())
            toks.append(prev)
            i = m.end()
            continue
        if src.startswith('?.', i):
            prev = ('punc', '.')
            toks.append(prev)
            i += 2
            continue
        prev = ('punc', c)
        toks.append(prev)
        i += 1
    return toks


def scripts_of(path, text):
    return re.findall(r'<script[^>]*>(.*?)</script>', text, re.S) if path.endswith('.vue') else [text]


def match_close(toks, i):
    """toks[i] opens a bracket; index of its match, or -1."""
    pairs, stack = {'(': ')', '[': ']', '{': '}'}, []
    while i < len(toks):
        k, v = toks[i]
        if k == 'punc' and v in pairs:
            stack.append(pairs[v])
        elif k == 'punc' and v in ')]}':
            if not stack or stack.pop() != v:
                return -1
            if not stack:
                return i
        i += 1
    return -1


def split_top(s, seps=','):
    """Split a PostgREST clause on separators outside quotes and parentheses."""
    out, depth, cur, q = [], 0, [], None
    for ch in s:
        if q:
            cur.append(ch)
            if ch == q:
                q = None
            continue
        if ch in '"\'':
            q = ch
        elif ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        if ch in seps and depth == 0:
            out.append(''.join(cur))
            cur = []
            continue
        cur.append(ch)
    out.append(''.join(cur))
    return [x.strip() for x in out if x.strip()]


def arg_slices(args):
    """A call's token list split on top-level commas."""
    out, depth, cur = [], 0, []
    for t in args:
        if t[0] == 'punc' and t[1] in '([{':
            depth += 1
        elif t[0] == 'punc' and t[1] in ')]}':
            depth -= 1
        elif t == ('punc', ',') and depth == 0:
            out.append(cur)
            cur = []
            continue
        cur.append(t)
    out.append(cur)
    return [a for a in out if a]


# --------------------------------------------------------------- constants

def const_table(toks):
    """IDENT = <value> up to the statement's semicolon. Ambiguous names dropped."""
    tbl, dup, n = {}, set(), len(toks)
    for i in range(n - 2):
        if toks[i][0] != 'id' or toks[i + 1] != ('punc', '='):
            continue
        if i and toks[i - 1] == ('punc', '.'):
            continue
        if toks[i + 2] in (('punc', '='), ('punc', '>')):   # ==, =>
            continue
        depth, j, end = 0, i + 2, -1
        while j < n and j < i + 200:
            k, v = toks[j]
            if k == 'punc' and v in '([{':
                depth += 1
            elif k == 'punc' and v in ')]}':
                depth -= 1
                if depth < 0:
                    break
            elif k == 'punc' and v == ';' and depth == 0:
                end = j
                break
            j += 1
        if end < 0:
            # Semicolons are optional; a lone string followed by the next
            # statement is still a complete value.
            nxt = toks[i + 3] if i + 3 < n else ('id', 'eof')
            if toks[i + 2][0] not in ('str', 'dyn') or \
                    not (nxt[0] == 'id' or nxt in (('punc', '}'), ('punc', ')'))):
                continue
            end = i + 3
        name, val = toks[i][1], tuple(toks[i + 2:end])
        if name in tbl and tbl[name] != val:
            dup.add(name)
        tbl[name] = val
    for name in dup:
        tbl.pop(name, None)
    return tbl


TMPL_HOLE = re.compile(r'\$\{([^{}]*)\}')


def strings_of(arg, consts, seen=()):
    """Every literal value a call argument can take: 'lit', `tmpl`, a string
    constant, a member of one, or a conditional over any of those. [] if unknown."""
    arg = list(arg)
    if len(arg) == 1 and arg[0][0] == 'str':
        return [arg[0][1]]
    if len(arg) == 1 and arg[0][0] == 'dyn':
        out, pos = [], 0
        for m in TMPL_HOLE.finditer(arg[0][1]):
            out.append(arg[0][1][pos:m.start()])
            vals = name_values(m.group(1), consts, seen)
            if len(vals) != 1:
                return []
            out.append(vals[0])
            pos = m.end()
        out.append(arg[0][1][pos:])
        return [''.join(out)]
    if arg and all(t[0] in ('id', 'punc') for t in arg) and \
            all(t[0] == 'id' or t == ('punc', '.') for t in arg):
        return name_values(''.join(t[1] for t in arg), consts, seen)
    branches = split_branches(arg)
    if branches:
        vals = []
        for b in branches:
            v = strings_of(b, consts, seen)
            if not v:
                return []
            vals.extend(v)
        return vals
    return []


def split_branches(arg):
    """The two arms of a top-level conditional, or [] if there is none."""
    depth, q, arms, cur = 0, None, [], []
    for t in arg:
        if t[0] == 'punc' and t[1] in '([{':
            depth += 1
        elif t[0] == 'punc' and t[1] in ')]}':
            depth -= 1
        if depth == 0 and t in (('punc', '?'), ('punc', ':')):
            arms.append(cur)
            cur = []
            continue
        cur.append(t)
    arms.append(cur)
    return arms[1:] if len(arms) == 3 else []


def name_values(name, consts, seen=()):
    """Resolve an identifier, or Class.MEMBER by its member, to its literals."""
    name = name.split('.')[-1].strip()
    if not IDENT.fullmatch(name) or name in seen or name not in consts:
        return []
    return strings_of(consts[name], consts, tuple(seen) + (name,))


# -------------------------------------------------------------- collection

class Collector:
    def __init__(self):
        self.cols = {}        # table -> {column: file}
        self.tables = {}      # table -> file
        self.embeds = []      # (parent, rel, hint, file, inner, alias)
        self.aliases = {}     # select alias -> relation
        self.skips = []

    def col(self, table, name, where):
        self.tables.setdefault(table, where)
        self.cols.setdefault(table, {}).setdefault(name, where)

    def table(self, t, where):
        self.tables.setdefault(t, where)

    def skip(self, kind, where, detail=''):
        self.skips.append((kind, where, ' '.join(str(detail).split())[:70]))


def parse_select(expr, tables, where, C):
    for item in split_top(expr):
        p = item.find('(')
        if p < 0:
            name = item.split(':', 1)[-1] if ':' in item else item
            name = name.split('::')[0].split('->')[0].strip()
            if name in ('*', '', 'count'):
                continue
            if not COLNAME.match(name):
                C.skip('select-item', where, item)
                continue
            for t in tables:
                C.col(t, name, where)
            continue
        head, inner = item[:p].strip(), item[p + 1:item.rfind(')')]
        if not inner.strip() and '.' in head:
            # col.aggregate(): the aggregate applies to the column left of the dot
            base = head.split(':')[-1].split('.')[0].strip()
            if COLNAME.match(base):
                for t in tables:
                    C.col(t, base, where)
            else:
                C.skip('select-item', where, item)
            continue
        alias = ''
        if ':' in head:
            alias, head = [x.strip() for x in head.split(':', 1)]
        head = head.lstrip('.')                       # ...spread(embed)
        rel, _, hint = head.partition('!')
        rel, hint = rel.strip(), hint.strip()
        if not COLNAME.match(rel):
            C.skip('select-embed', where, item)
            continue
        if alias and COLNAME.match(alias):
            C.aliases.setdefault(alias, rel)
        for t in tables:
            C.embeds.append((t, rel, hint, where, inner, alias))


def filter_column(raw, tables, where, C, meth):
    s = raw.strip().split('->')[0].split('::')[0].strip()
    if not s:
        return
    if '.' in s:
        head, _, tail = s.rpartition('.')
        if COLNAME.match(head) and COLNAME.match(tail):
            for t in tables:
                C.embeds.append((t, head, '', where, tail, ''))
        else:
            C.skip('filter-path', where, '%s(%s)' % (meth, raw))
        return
    if not COLNAME.match(s):
        C.skip('filter-name', where, '%s(%s)' % (meth, raw))
        return
    for t in tables:
        C.col(t, s, where)


def parse_or(expr, tables, where, C):
    """PostgREST or(): comma-joined `col.op.value`, nestable as and()/or().
    The column precedes the first dot, so interpolation in the value or the
    operator does not hide it."""
    for item in split_top(expr):
        m = re.match(r'^(?:not\.)?(?:and|or)\((.*)\)$', item, re.S)
        if m:
            parse_or(m.group(1), tables, where, C)
            continue
        col = item.split('.', 1)[0].split('->')[0].strip()
        if not col:
            continue
        if '${' in col:
            C.skip('or-filter', where, item)
            continue
        filter_column(col, tables, where, C, 'or')


def object_keys(toks):
    """Keys of the row object, or of each row in an array of them. Nested
    objects hold JSON, not columns, so only the outermost object counts. A key
    follows '{' or ',' only, which keeps the arms of a conditional out."""
    keys, stack, prev, spread = [], [], None, False
    for i, t in enumerate(toks):
        k, v = t
        if k == 'punc' and v in '([{':
            stack.append(v)
            prev = t
            continue
        if k == 'punc' and v in ')]}':
            if stack:
                stack.pop()
            prev = t
            continue
        if stack in (['{'], ['[', '{']) and prev in (('punc', '{'), ('punc', ','), None):
            nxt = toks[i + 1] if i + 1 < len(toks) else ('punc', '}')
            if k in ('id', 'str') and nxt == ('punc', ':'):
                keys.append((v, True))
            elif k == 'id' and nxt in (('punc', ','), ('punc', '}')):
                keys.append((v, True))          # { col } shorthand
            elif k == 'dyn':
                keys.append((v, False))
            elif t == ('punc', '.') and i + 1 < len(toks) and toks[i + 1] == ('punc', '.'):
                spread = True
        prev = t
    return keys, spread


def opt_value(arg, name):
    """Token slice of `name:` inside an options object literal."""
    for i in range(len(arg) - 2):
        if arg[i][0] in ('id', 'str') and arg[i][1] == name and arg[i + 1] == ('punc', ':'):
            return [arg[i + 2]]
    return None


def handle(meth, args, tables, where, C, consts):
    parts = arg_slices(args)

    if meth == 'select':
        if not parts:
            return
        vals = strings_of(parts[0], consts)
        if not vals:
            C.skip('select-dynamic', where, ''.join(t[1] for t in parts[0]))
        for v in vals:
            parse_select(v, tables, where, C)
        return

    if meth in WRITERS:
        if not parts:
            return
        payload = parts[0]
        if payload[0] in (('punc', '{'), ('punc', '[')):
            keys, spread = object_keys(payload)
            for key, literal in keys:
                if not literal:
                    C.skip('write-key-dynamic', where, '%s: %s' % (meth, key))
                elif COLNAME.match(key):
                    for t in tables:
                        C.col(t, key, where)
                else:
                    C.skip('write-key', where, '%s: %s' % (meth, key))
            if spread:
                C.skip('write-spread', where, '%s into %s' % (meth, '/'.join(tables)))
        else:
            C.skip('write-payload', where, '%s(%s) into %s'
                   % (meth, ''.join(t[1] for t in payload), '/'.join(tables)))
        if len(parts) > 1:
            v = opt_value(parts[1], 'onConflict')
            if v is not None:
                vals = strings_of(v, consts)
                if not vals:
                    C.skip('onconflict-dynamic', where, meth)
                for s in vals:
                    for c in split_top(s):
                        filter_column(c, tables, where, C, 'onConflict')
        return

    if meth == 'match':
        if not parts:
            return
        if parts[0][0] == ('punc', '{'):
            keys, _ = object_keys(parts[0])
            for key, literal in keys:
                if literal:
                    filter_column(key, tables, where, C, 'match')
                else:
                    C.skip('match-key-dynamic', where, key)
        else:
            C.skip('match-payload', where, ''.join(t[1] for t in parts[0]))
        return

    if meth in FILTERS or meth == 'or':
        if not parts:
            return
        vals = strings_of(parts[0], consts)
        if not vals and meth == 'or' and len(parts[0]) == 1 and parts[0][0][0] == 'dyn':
            parse_or(parts[0][0][1], tables, where, C)
            return
        if not vals:
            C.skip('or-filter' if meth == 'or' else 'filter-dynamic', where,
                   '%s(%s)' % (meth, ''.join(t[1] for t in parts[0])))
            return
        # A second argument naming a referenced table moves the column there.
        ref = None
        if len(parts) > 1:
            for opt in ('referencedTable', 'foreignTable'):
                v = opt_value(parts[1], opt)
                if v is not None and v[0][0] == 'str':
                    ref = v[0][1]
        target = (ref,) if ref else tables
        for v in vals:
            if meth == 'or':
                parse_or(v, target, where, C)
            else:
                filter_column(v, target, where, C, meth)
        return

    if meth not in KNOWN:
        C.skip('unknown-method', where, '%s on %s' % (meth, '/'.join(tables)))


def chain(toks, j, tables, where, C, consts):
    n = len(toks)
    while j + 1 < n and toks[j] == ('punc', '.') and toks[j + 1][0] == 'id':
        meth, k = toks[j + 1][1], j + 2
        if k < n and toks[k] == ('punc', '<'):          # .returns<T>()
            d = 0
            while k < n:
                if toks[k] == ('punc', '<'):
                    d += 1
                elif toks[k] == ('punc', '>'):
                    d -= 1
                    if d == 0:
                        k += 1
                        break
                k += 1
        if k >= n or toks[k] != ('punc', '('):
            break
        close = match_close(toks, k)
        if close < 0:
            break
        handle(meth, toks[k + 1:close], tables, where, C, consts)
        j = close + 1
    return j


def walk(toks, where, C, consts):
    i, n = 0, len(toks)
    while i < n - 2:
        if not (toks[i] == ('punc', '.') and toks[i + 1] == ('id', 'from')
                and toks[i + 2] == ('punc', '(')):
            i += 1
            continue
        prev = toks[i - 1] if i else None
        # Array.from, Buffer.from, supabase.storage.from: not PostgREST.
        if prev and prev[0] == 'id' and (prev[1] == 'storage' or prev[1][:1].isupper()):
            i += 1
            continue
        close = match_close(toks, i + 2)
        if close < 0:
            i += 1
            continue
        arg = toks[i + 3:close]
        names = strings_of(arg, consts) if arg else []
        if not names:
            C.skip('from-dynamic', where, ''.join(t[1] for t in arg))
            i = close + 1
            continue
        good = [x for x in names if COLNAME.match(x)]
        for bad in [x for x in names if not COLNAME.match(x)]:
            C.skip('from-name', where, bad)
        if not good:
            i = close + 1
            continue
        for t in good:
            C.table(t, where)
        i = chain(toks, close + 1, tuple(good), where, C, consts)
    return


def collect():
    C, chunks = Collector(), []
    for sub in SUBS:
        for dp, dns, fs in os.walk(os.path.join(ROOT, sub)):
            dns[:] = [d for d in dns if d not in ('node_modules', 'dist', '.git')]
            for fn in sorted(fs):
                if not fn.endswith(('.ts', '.tsx', '.vue', '.js', '.mjs')):
                    continue
                p = os.path.join(dp, fn)
                with open(p, encoding='utf8', errors='ignore') as fh:
                    text = fh.read()
                toks = [t for c in scripts_of(p, text) for t in lex(c)]
                chunks.append((os.path.relpath(p, ROOT), toks, '.from(' in text))

    # Select lists are often module constants; imports resolve by name across
    # the tree, a local definition winning over a shared one.
    shared, dup = {}, set()
    for _, toks, _ in chunks:
        for name, val in const_table(toks).items():
            if name in shared and shared[name] != val:
                dup.add(name)
            shared[name] = val
    for name in dup:
        shared.pop(name, None)

    files = 0
    for rel, toks, has in chunks:
        if not has:
            continue
        files += 1
        consts = dict(shared)
        consts.update(const_table(toks))
        walk(toks, rel, C, consts)
    return C, files


# ------------------------------------------------------------- comparison

def load_facts():
    """cols: relation -> columns. rels: relation -> relkind. fks: constraint ->
    (child, parent). bycol: (relation, fk column) -> relation it reaches, only
    where that is unambiguous."""
    cols, rels, fks, seen = {}, {}, {}, {}
    with open(FACTS, encoding='utf8') as fh:
        for line in fh:
            f = line.rstrip('\n').split('\t')
            if len(f) < 3:
                continue
            if f[0] == 'c':
                cols.setdefault(f[1], set()).add(f[2])
            elif f[0] == 'r':
                rels[f[1]] = f[2]
            elif f[0] == 'f':
                child, parent, childcols = f[2].split(' ')
                fks[f[1]] = (child, parent)
                for c in childcols.split(','):
                    seen.setdefault((child, c), set()).add(parent)
                    seen.setdefault((parent, c), set()).add(child)
    bycol = {k: v.pop() for k, v in seen.items() if len(v) == 1}
    return cols, rels, fks, bycol


def main():
    C, files = collect()
    cols, rels, fks, bycol = load_facts()

    for pair in ALLOW.split():
        t, _, c = pair.partition('.')
        if c:
            C.col(t, c, 'ALLOW_DYNAMIC')
        else:
            C.table(t, 'ALLOW_DYNAMIC')

    missing_t, missing_c, unresolved = [], [], []

    def resolve(parent, rel, hint):
        """PostgREST resolves an embed by relation name, by foreign key
        constraint name, or by foreign key column name. A select alias is
        resolved back to the name it stood for."""
        seen = set()
        for name in (rel, C.aliases.get(rel, '')):
            if not name or name in seen:
                continue
            seen.add(name)
            if name in rels:
                return name
            if name in fks:
                child, parent_t = fks[name]
                return parent_t if child == parent else child
            if (parent, name) in bycol:
                return bycol[(parent, name)]
        if hint in fks:
            child, parent_t = fks[hint]
            return parent_t if child == parent else child
        return None

    # An embed's columns belong to the relation it resolves to, which is only
    # known once the schema is in hand.
    for parent, rel, hint, where, inner, alias in C.embeds:
        target = resolve(parent, rel, hint)
        if target is None:
            unresolved.append((parent, rel, where))
            continue
        C.table(target, where)
        parse_select(inner, (target,), where, C)
        if hint and hint not in ('inner', 'left') and hint not in fks and \
                hint not in cols.get(target, ()) and hint not in cols.get(parent, ()):
            unresolved.append((parent, '%s!%s' % (rel, hint), where))

    for t, where in sorted(C.tables.items()):
        if t not in rels:
            missing_t.append((t, where))
    for t, columns in sorted(C.cols.items()):
        if t not in rels:
            continue
        for c, where in sorted(columns.items()):
            if c not in cols.get(t, ()):
                missing_c.append(('%s.%s' % (t, c), where))

    n_cols = sum(len(v) for v in C.cols.values())
    cyan, red, reset = '\033[36m', '\033[31m', '\033[0m'
    print('%s==>%s %d tables and %d columns from %d files, %d embeds resolved'
          % (cyan, reset, len(C.tables), n_cols, files, len(C.embeds)))

    if C.skips:
        kinds = {}
        for kind, _, _ in C.skips:
            kinds[kind] = kinds.get(kind, 0) + 1
        print('%s==>%s %d references are not statically readable and are NOT checked:'
              % (cyan, reset, len(C.skips)))
        for kind, count in sorted(kinds.items(), key=lambda x: -x[1]):
            print('    %-20s %d' % (kind, count))
        if SHOW_SKIPPED == '1':
            for kind, where, detail in sorted(C.skips):
                print('    %-20s %s  %s' % (kind, where, detail))
        else:
            print('    (--skipped lists them)')

    sys.stdout.flush()
    fail = 0
    if missing_t:
        print('%sFAIL%s %d tables the application uses are missing from %s:'
              % (red, reset, len(missing_t), TARGET), file=sys.stderr)
        for t, where in missing_t:
            print('    %-40s %s' % (t, where), file=sys.stderr)
        fail = 1
    if missing_c:
        print('%sFAIL%s %d columns the application uses are missing from %s:'
              % (red, reset, len(missing_c), TARGET), file=sys.stderr)
        for c, where in missing_c:
            print('    %-40s %s' % (c, where), file=sys.stderr)
        fail = 1
    if unresolved:
        seen, rows = set(), []
        for parent, rel, where in unresolved:
            if (parent, rel) in seen:
                continue
            seen.add((parent, rel))
            rows.append(('%s -> %s' % (parent, rel), where))
        print('%sFAIL%s %d embedded relations do not resolve against %s:'
              % (red, reset, len(rows), TARGET), file=sys.stderr)
        for r, where in rows:
            print('    %-40s %s' % (r, where), file=sys.stderr)
        fail = 1

    if fail:
        sys.exit(1)
    print('%s==>%s every table and column the application uses exists in %s'
          % (cyan, reset, TARGET))


main()
PY
