#!/usr/bin/env python3
"""Lists public functions no entry point can reach.

Entry points are the only ways execution enters the database: an RPC call from
the frontend or a worker, a trigger firing, an RLS policy evaluating, a cron
job, a view, or a column default. Everything else is reached only by being
called from something already reachable, so the answer is a graph traversal
from those roots.

A shallow "is it called anywhere" check is not enough: dead code calls dead
code, and a function called only by another unreachable function is itself
unreachable. Equally, a function called by no client but invoked from a live
trigger handler is reachable and must not be dropped.

Usage: find-unreachable.py <public-schema-dump.sql> <repo-root> [extra-roots.txt]

extra-roots.txt carries entry points absent from a --schema=public dump: cron
schedules, RLS policies on tables in other schemas, and column defaults. Without
it, a function reached only from a cron job or a realtime policy reads as dead.
"""
import os
import re
import sys

SRC_EXTENSIONS = (".ts", ".tsx", ".js", ".vue")
CALLER_ROOTS = ("src", "federation-backend/src", "bot-gateway/src")


def quoted_strings(root: str) -> set[str]:
    """Every quoted string in application code.

    Matching only `rpc('literal')` misses computed names, and those exist:
    postReactions.ts selects between add_ and remove_post_emoji_reaction with a
    ternary before passing it to rpc(). Treating any quoted occurrence of a
    function name as a possible call is deliberately over-inclusive - a false
    "reachable" costs nothing, a false "dead" drops a live endpoint.
    """
    found: set[str] = set()
    for sub in CALLER_ROOTS:
        for base, dirs, files in os.walk(os.path.join(root, sub)):
            dirs[:] = [d for d in dirs if d not in ("node_modules", "dist", ".git")]
            for fname in files:
                if fname.endswith(SRC_EXTENSIONS):
                    with open(os.path.join(base, fname), encoding="utf-8", errors="replace") as fh:
                        found |= set(re.findall(r"""['"`]([a-z0-9_]{4,})['"`]""", fh.read()))
    return found


FUNCTION_DEF = re.compile(
    r"CREATE (?:OR REPLACE )?FUNCTION [\w.]*\w+\(.*?AS (\$[\w]*\$).*?\1;", re.S
)


def strip_definitions(sql: str) -> str:
    """Removes function definitions and pg_dump metadata.

    What remains is call sites only. A function's own CREATE statement, its
    GRANT lines and pg_dump's "-- Name: foo(...)" headers all mention the name
    without calling it, and would make every function its own root.
    """
    out = FUNCTION_DEF.sub(" ", sql)
    out = re.sub(
        r"^\s*(GRANT|REVOKE|COMMENT ON|ALTER)\s+[^;]*FUNCTION[^;]*;",
        " ", out, flags=re.M | re.S | re.I,
    )
    out = re.sub(r"--[^\n]*", " ", out)
    return re.sub(r"/\*.*?\*/", " ", out, flags=re.S)


def repo_sql_roots(root: str) -> str:
    """Entry points declared in the repo: policies, triggers, cron, defaults.

    Read from db_schema/ rather than a built database so that entry points on
    objects a bare container cannot create - realtime.messages is owned by
    supabase_admin and needs a running Realtime service - are still counted.
    """
    chunks = []
    for sub in ("db_schema/init", "db_schema/migrations"):
        d = os.path.join(root, sub)
        if not os.path.isdir(d):
            continue
        for fname in sorted(os.listdir(d)):
            if fname.endswith(".sql"):
                with open(os.path.join(d, fname), encoding="utf-8", errors="replace") as fh:
                    chunks.append(strip_definitions(fh.read()))
    return "\n".join(chunks)


def function_bodies(sql: str) -> dict[str, str]:
    bodies: dict[str, str] = {}
    for m in re.finditer(
        r"CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(.*?AS (\$[\w]*\$)(.*?)\2;",
        sql,
        re.S,
    ):
        bodies[m.group(1)] = bodies.get(m.group(1), "") + m.group(3)
    return bodies


def main() -> None:
    sql = open(sys.argv[1], encoding="utf-8", errors="replace").read()
    root = sys.argv[2]

    bodies = function_bodies(sql)
    known = set(bodies)

    # Call sites only: everything that is not a function definition.
    outside = strip_definitions(sql)
    outside += "\n" + repo_sql_roots(root)

    if len(sys.argv) > 3:
        with open(sys.argv[3], encoding="utf-8", errors="replace") as fh:
            outside += "\n" + fh.read()

    roots = quoted_strings(root) & known
    roots |= {f for f in known if re.search(r"(?<![\w.])(?:public\.)?" + re.escape(f) + r"\s*\(", outside)}

    reachable, stack = set(roots), list(roots)
    while stack:
        body = bodies.get(stack.pop(), "")
        for callee in known:
            if callee not in reachable and re.search(
                r"(?<![\w.])(?:public\.)?" + re.escape(callee) + r"\s*\(", body
            ):
                reachable.add(callee)
                stack.append(callee)

    unreachable = sorted(known - reachable)
    print(f"# functions: {len(known)}", file=sys.stderr)
    print(f"# roots: {len(roots)}", file=sys.stderr)
    print(f"# reachable: {len(reachable)}", file=sys.stderr)
    print(f"# unreachable: {len(unreachable)}", file=sys.stderr)
    print("\n".join(unreachable))


if __name__ == "__main__":
    main()
