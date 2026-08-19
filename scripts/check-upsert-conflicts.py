#!/usr/bin/env python3
# Every supabase upsert names an ON CONFLICT target. Postgres infers a unique index from
# that target and raises 42P10 when none matches, so an upsert whose columns carry no
# UNIQUE in init/ fails at runtime and nowhere earlier - the schema loads, the types check,
# and the call site compiles.
#
# Inference matches a full index only. A partial index (WHERE col IS NOT NULL) does not
# satisfy ON CONFLICT (col) unless the statement repeats the predicate, which PostgREST
# does not emit; partial indexes are therefore not counted as cover.
#
#   check-upsert-conflicts.py           report and exit non-zero on a gap
#   check-upsert-conflicts.py --list    print every pair, including the covered ones
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIRS = ('src', 'federation-backend/src', 'bot-gateway/src')
# .from() and .upsert() are usually chained on one expression; 2000 chars spans the
# longest current call and stops a match leaking in from a neighbouring function.
LOOKBEHIND = 2000


def upsert_sites():
    for d in SOURCE_DIRS:
        for path in sorted(glob.glob(os.path.join(ROOT, d, '**', '*.ts'), recursive=True)):
            text = open(path, encoding='utf-8', errors='replace').read()
            for m in re.finditer(r"onConflict:\s*'([^']+)'", text):
                window = text[max(0, m.start() - LOOKBEHIND):m.start()]
                tables = re.findall(r"\.from\(\s*'([A-Za-z_]+)'\s*\)", window)
                if not tables:
                    continue
                cols = tuple(c.strip() for c in m.group(1).split(','))
                yield (tables[-1], cols, os.path.relpath(path, ROOT),
                       text[:m.start()].count('\n') + 1)


def unique_sets():
    """table -> [frozenset(cols)] for every full UNIQUE or PRIMARY KEY in init/."""
    sql = ''
    for path in sorted(glob.glob(os.path.join(ROOT, 'db_schema/init/*.sql'))):
        sql += open(path, encoding='utf-8', errors='replace').read() + '\n'

    out = {}

    def add(table, cols):
        out.setdefault(table, []).append(frozenset(cols))

    # WHERE marks a partial index; it cannot be inferred.
    for m in re.finditer(
            r'CREATE\s+UNIQUE\s+INDEX[^;]*?\bON\s+(?:public\.)?(\w+)\s*\(([^)]*)\)([^;]*);',
            sql, re.I | re.S):
        if re.search(r'\bWHERE\b', m.group(3), re.I):
            continue
        add(m.group(1), [c.strip().split()[0] for c in m.group(2).split(',') if c.strip()])

    for tm in re.finditer(r'CREATE TABLE[^(]*?(?:public\.)?(\w+)\s*\((.*?)\n\);', sql, re.S | re.I):
        table, body = tm.group(1), tm.group(2)
        for m in re.finditer(r'(?:CONSTRAINT\s+\w+\s+)?(?:UNIQUE|PRIMARY KEY)\s*\(([^)]*)\)', body, re.I):
            add(table, [c.strip().split()[0] for c in m.group(1).split(',') if c.strip()])
        for line in body.split('\n'):
            s = line.strip().rstrip(',')
            if not s or s.upper().startswith(('CONSTRAINT', 'UNIQUE', 'PRIMARY KEY', '--')):
                continue
            if re.search(r'\b(UNIQUE|PRIMARY KEY)\b', s, re.I):
                add(table, [s.split()[0]])

    for m in re.finditer(
            r'ALTER TABLE\s+(?:ONLY\s+)?(?:public\.)?(\w+)[^;]*?ADD CONSTRAINT\s+\w+\s+UNIQUE\s*\(([^)]*)\)',
            sql, re.I | re.S):
        add(m.group(1), [c.strip() for c in m.group(2).split(',') if c.strip()])

    return out


def main():
    show_all = '--list' in sys.argv
    have = unique_sets()
    sites = sorted(set(upsert_sites()))
    gaps = []

    for table, cols, path, line in sites:
        covered = frozenset(cols) in have.get(table, [])
        if show_all:
            print(f"{'ok  ' if covered else 'MISS'} {table}({','.join(cols)})  {path}:{line}")
        if not covered:
            gaps.append((table, cols, path, line))

    if not gaps:
        print(f"{len(sites)} upserts, every ON CONFLICT target has a full unique in init/")
        return 0

    print(f"\n{len(gaps)} of {len(sites)} upserts infer a unique index init/ does not declare:\n")
    for table, cols, path, line in gaps:
        declared = '; '.join('(' + ','.join(sorted(h)) + ')' for h in have.get(table, [])) or 'none'
        print(f"  {table}({','.join(cols)})  {path}:{line}")
        print(f"      init/ declares: {declared}")
    print("\nEach raises 42P10 at runtime.")
    return 1


if __name__ == '__main__':
    sys.exit(main())
