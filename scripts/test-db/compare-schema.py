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


def load(path: str) -> "OrderedDict[str, str]":
    out: "OrderedDict[str, str]" = OrderedDict()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3:
                out[f"{parts[0]}\t{parts[1]}"] = parts[2]
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

    print(f"{RED}init/ and migrations/ disagree.{OFF}\n")
    section("absent from init/ - a migration adds it, init never got the edit", absent, limit)
    section("only in init/ - migrations drop it, or init is ahead", extra, limit)
    section("definition differs between a fresh init and a migrated schema", changed, limit)
    print(f"{DIM}Bodies are digested, so these are real differences, not reworded comments.{OFF}")
    print(f"{DIM}Inspect with: normalize-schema.py <dump.sql> --verbose{OFF}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
