#!/usr/bin/env python3
"""Reduces a pg_dump --schema-only file to a sorted, comparable object inventory.

pg_dump emits objects in a dependency-influenced order, so two databases with
identical schemas produce textually different dumps. Comparing a normalized
inventory instead makes the diff order-independent and names the object that
differs.

Bodies are reduced to a digest: a drift report needs to say *which* object
disagrees, not print two 4KB function bodies side by side. Run with --verbose
to emit bodies for inspection.

SQL comments are stripped before digesting. They carry no schema meaning, and
leaving them in reports every reworded comment as drift.

Usage: normalize-schema.py <dump.sql> [--verbose]
"""
import hashlib
import re
import sys


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"--[^\n]*", " ", text)
    return text


# Longest first, so <> is not read as < then >.
_OPERATORS = ("<>", "!=", "<=", ">=", ":=", "||", "=")


def fold_operators(text: str) -> str:
    """Drop whitespace around operators, outside string literals.

    `ERRCODE = '42501'` and `ERRCODE='42501'` are the same statement. Folding
    them textually is only safe outside quotes: a literal may legitimately
    contain ` = `, and collapsing it there would make two different messages
    compare equal.
    """
    out: list[str] = []
    i, n, in_string = 0, len(text), False
    while i < n:
        ch = text[i]
        if ch == "'":
            # Doubled quotes escape within a literal; the toggle handles them.
            in_string = not in_string
            out.append(ch)
            i += 1
            continue
        if in_string:
            out.append(ch)
            i += 1
            continue
        for op in _OPERATORS:
            if text.startswith(op, i):
                while out and out[-1] == " ":
                    out.pop()
                out.append(op)
                i += len(op)
                while i < n and text[i] == " ":
                    i += 1
                break
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def squash(text: str) -> str:
    """Canonical form: comments gone, whitespace and operator spacing irrelevant.

    Collapsing runs of whitespace is not enough on its own - it leaves the space
    in `COALESCE( (SELECT` distinct from `COALESCE((SELECT`, so a rewrapped line
    reads as a changed body. Space adjacent to punctuation and to operators is
    dropped, and keywords are cased uniformly, leaving only differences that a
    parser would also see.
    """
    out = re.sub(r"\s+", " ", strip_comments(text)).strip()
    out = re.sub(r"\s*([(),;])\s*", r"\1", out)
    return fold_operators(out.lower())


def digest(text: str) -> str:
    return hashlib.sha1(squash(text).encode()).hexdigest()[:12]


def inventory(sql: str, verbose: bool) -> list[str]:
    out: list[str] = []

    def emit(kind: str, name: str, body: str) -> None:
        out.append(f"{kind}\t{name}\t{squash(body) if verbose else digest(body)}")

    for m in re.finditer(
        r"CREATE TABLE (?:IF NOT EXISTS )?([\w.]+)\s*\((.*?)\n\);", sql, re.S
    ):
        cols = sorted(squash(c) for c in m.group(2).split("\n") if squash(c))
        emit("table", m.group(1), " | ".join(cols))

    # Keyed by name and argument list so overloads stay distinct.
    #
    # Attributes and body are digested separately. Concatenated, a function
    # differing only in SET search_path is indistinguishable from one whose body
    # changed, and the drift report cannot say which kind of difference it found.
    for m in re.finditer(
        r"CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\((.*?)\)(.*?)AS (\$[\w]*\$)(.*?)\4;",
        sql,
        re.S,
    ):
        name = f"{m.group(1)}({squash(m.group(2))})"
        if verbose:
            out.append(f"function\t{name}\tattrs={squash(m.group(3))}")
            out.append(f"function\t{name}\tbody={squash(m.group(5))}")
        else:
            out.append(
                f"function\t{name}\t{digest(m.group(3))}\t{digest(m.group(5))}"
            )

    for m in re.finditer(r'CREATE POLICY "?([^"\n]+?)"? ON ([\w.]+)(.*?);', sql, re.S):
        emit("policy", f"{m.group(2)}.{m.group(1)}", m.group(3))

    for m in re.finditer(r"CREATE TRIGGER (\w+)(.*?);", sql, re.S):
        emit("trigger", m.group(1), m.group(2))

    for m in re.finditer(r"CREATE (?:UNIQUE )?INDEX (\w+) ON (.*?);", sql, re.S):
        emit("index", m.group(1), m.group(2))

    for m in re.finditer(r"CREATE (?:OR REPLACE )?VIEW ([\w.]+)(.*?);", sql, re.S):
        emit("view", m.group(1), m.group(2))

    # Grants and column defaults carry authorization and behavioural meaning.
    for m in re.finditer(r"(GRANT|REVOKE) (.*?);", sql, re.S):
        emit("grant", squash(f"{m.group(1)} {m.group(2)}")[:150], "")

    for m in re.finditer(r"ALTER TABLE (?:ONLY )?([\w.]+) (.*?);", sql, re.S):
        emit("alter", f"{m.group(1)} {squash(m.group(2))[:110]}", "")

    return sorted(set(out))


def main() -> None:
    verbose = "--verbose" in sys.argv
    path = next(a for a in sys.argv[1:] if not a.startswith("--"))
    with open(path, encoding="utf-8", errors="replace") as fh:
        print("\n".join(inventory(fh.read(), verbose)))


if __name__ == "__main__":
    main()
