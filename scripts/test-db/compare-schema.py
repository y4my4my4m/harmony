#!/usr/bin/env python3
"""Compares two normalized schema inventories and reports differing objects.

Exit 0 when identical, 1 when they differ.

Usage: compare-schema.py <baseline.txt> <migrated.txt> [--show N]
"""
import sys
from collections import OrderedDict

RED = "\033[31m"
DIM = "\033[2m"
OFF = "\033[0m"


def load(path: str) -> "OrderedDict[str, tuple[str, ...]]":
    """Object key -> its digest fields.

    Functions carry two: attributes then body. Everything else carries one.
    """
    out: "OrderedDict[str, tuple[str, ...]]" = OrderedDict()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3:
                out[f"{parts[0]}\t{parts[1]}"] = tuple(parts[2:])
    return out


def section(title: str, names: list[str], limit: int) -> None:
    if not names:
        return
    print(f"{RED}{title}{OFF} ({len(names)}):")
    for n in names[:limit]:
        kind, name = n.split("\t", 1)
        print(f"    {kind:9} {name}")
    if len(names) > limit:
        print(f"    {DIM}... and {len(names) - limit} more{OFF}")
    print()


def main() -> int:
    base, migrated = load(sys.argv[1]), load(sys.argv[2])
    limit = 40
    if "--show" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--show") + 1])

    absent = [k for k in migrated if k not in base]
    extra = [k for k in base if k not in migrated]
    changed = [k for k in base if k in migrated and base[k] != migrated[k]]

    if not (absent or extra or changed):
        return 0

    # A function's attributes and body are digested apart, so the report can say
    # which of the two moved. An attribute-only difference is almost always the
    # SET search_path split and is one systematic fix, not a reconciliation.
    def split(k: str) -> tuple[bool, bool] | None:
        b, m = base[k], migrated[k]
        if not (k.startswith("function\t") and len(b) == 2 and len(m) == 2):
            return None
        return b[0] != m[0], b[1] != m[1]

    body_diff = [k for k in changed if (s := split(k)) and s[1]]
    attrs_only = [k for k in changed if split(k) == (True, False)]
    other = [k for k in changed if split(k) is None]

    print(f"{RED}init/ and migrations/ disagree.{OFF}\n")
    section("absent from init/ - a migration adds it, init never got the edit", absent, limit)
    section("only in init/ - migrations drop it, or init is ahead", extra, limit)
    section("function body differs - the two builds run different code", body_diff, limit)
    section("function attributes only (SET search_path, LANGUAGE, volatility) - body is identical",
            attrs_only, limit)
    section("policies, triggers, indexes, grants and ALTERs", other, limit)
    print(f"{DIM}Comments are stripped before digesting, so none of these are reworded comments.{OFF}")
    print(f"{DIM}Inspect with: normalize-schema.py <dump.sql> --verbose{OFF}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
