#!/usr/bin/env python3
"""Builds the public RPC surface manifest.

PostgREST exposes every function in `public` as an HTTP endpoint, so the file
this produces is the client-reachable surface. Committing it makes adding an
endpoint a reviewed act with a visible diff, instead of something that appears
silently.

Reads the catalog rows produced by surface-query.sql on stdin, classifies each
function by what reaches it, and writes the manifest to stdout.

Callers are resolved from this repository only, so the result is deterministic
in CI: the frontend under src/, plus the federation-backend and bot-gateway
workers, which call RPCs directly rather than only queueing jobs. A function
marked `unreferenced` means nothing in this repo calls it, which is not the
same as unreachable.
"""
import os
import re
import sys

SRC_EXTENSIONS = (".ts", ".tsx", ".js", ".vue")


# The workers call RPCs directly; scanning only src/ would mark their
# endpoints unreferenced and make them look droppable.
CALLER_ROOTS = ("src", "federation-backend/src", "bot-gateway/src")


def frontend_rpc_names(root: str) -> set[str]:
    names: set[str] = set()
    for sub in CALLER_ROOTS:
        names |= _scan(os.path.join(root, sub))
    return names


def _scan(start: str) -> set[str]:
    names: set[str] = set()
    for base, dirs, files in os.walk(start):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "dist", ".git")]
        for fname in files:
            if not fname.endswith(SRC_EXTENSIONS):
                continue
            path = os.path.join(base, fname)
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    # Any quoted string, not just rpc('literal'): computed
                    # names exist. postReactions.ts picks between add_ and
                    # remove_post_emoji_reaction with a ternary before calling
                    # rpc(), and the narrow form classified a live endpoint as
                    # an internal helper.
                    names |= set(re.findall(r"""['"`]([a-z0-9_]{4,})['"`]""", fh.read()))
            except OSError:
                continue
    return names


def main() -> None:
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    rpc = frontend_rpc_names(root)

    rows = []
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line or line.count("|") < 6:
            continue
        name, args, returns, security, config, grants, bound = line.split("|", 6)
        if name in rpc:
            reached = "client"
        elif bound:
            reached = bound
        else:
            reached = "unreferenced"
        # proconfig entries arrive joined by spaces, and a search_path value may
        # itself contain ", " - `public, extensions, pg_temp`. Reading to the
        # next `key=` rather than the next space keeps the whole value; \S+
        # truncated it to `public,`.
        search_path = ""
        m = re.search(r"search_path=(.*?)(?=\s+\w+=|$)", config)
        if m:
            search_path = m.group(1).strip()
        rows.append((name, args, returns, security, search_path, grants, reached))

    print("# Public RPC surface — generated, do not edit by hand.")
    print("# Regenerate: scripts/generate-surface.sh")
    print("#")
    print("# PostgREST publishes every function below as an HTTP endpoint.")
    print("# `definer` bypasses RLS. `unreferenced` means nothing in this repo")
    print("# calls it, not that it is unreachable.")
    print("#")
    print("# name\targs\treturns\tsecurity\tsearch_path\tgrants\treached_by")
    for r in sorted(rows):
        print("\t".join(r))

    total = len(rows)
    definer = sum(1 for r in rows if r[3] == "definer")
    unref = sum(1 for r in rows if r[6] == "unreferenced")
    anon = sum(1 for r in rows if "anon" in r[5])
    print(f"#", file=sys.stderr)
    print(f"# functions: {total}", file=sys.stderr)
    print(f"# security definer: {definer}", file=sys.stderr)
    print(f"# granted to anon: {anon}", file=sys.stderr)
    print(f"# unreferenced in this repo: {unref}", file=sys.stderr)


if __name__ == "__main__":
    main()
