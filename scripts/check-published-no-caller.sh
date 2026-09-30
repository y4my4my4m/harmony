#!/usr/bin/env bash
# Fails when the set of published-but-uncalled functions changes.
#
# PostgREST exposes every function in public as an HTTP endpoint. One that nothing in this
# repository reaches - no RPC call site, no trigger, no policy, no view, no cron entry, no
# other function - is an endpoint whose only caller is outside the repository, or nobody.
#
# The counterpart gates read the other direction: check-rpc-coverage asserts the schema has
# what the application calls. Nothing asserted the reverse, so the schema could accumulate
# functions indefinitely without a gate noticing.
#
# The census is db_schema/PUBLISHED-NO-CALLER.tsv. A NEW entry fails: adding a function that
# nothing calls becomes a reviewed decision. A REMOVED entry fails too, since the census is
# then stale.
#
#   check-published-no-caller.sh           compare against the census
#   check-published-no-caller.sh --write   rewrite the census from REACHABILITY.tsv
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRAPH="$ROOT/db_schema/REACHABILITY.tsv"
CENSUS="$ROOT/db_schema/PUBLISHED-NO-CALLER.tsv"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

[ -r "$GRAPH" ] || { err "no $GRAPH; run scripts/generate-reachability.sh"; exit 1; }

# Column 5 is the entry kind. `http anon` and `service key` both mean the only way in is HTTP.
current=$(awk -F'\t' '!/^#/ && NF > 4 && ($5 == "http anon" || $5 == "service key") \
                      { print $1 "\t" $5 "\t" $4 }' "$GRAPH" | LC_ALL=C sort)

if [ "${1:-}" = "--write" ]; then
	{
		sed -n '1,/^# name\t/p' "$CENSUS"
		printf '%s\n' "$current"
	} > "$CENSUS.tmp"
	mv "$CENSUS.tmp" "$CENSUS"
	log "wrote $(printf '%s\n' "$current" | wc -l | tr -d ' ') entries to $CENSUS"
	exit 0
fi

[ -r "$CENSUS" ] || { err "no $CENSUS; run with --write"; exit 1; }
recorded=$(grep -v '^#' "$CENSUS" | grep -v '^[[:space:]]*$' | LC_ALL=C sort)

added=$(comm -23 <(printf '%s\n' "$current") <(printf '%s\n' "$recorded") || true)
gone=$(comm -13 <(printf '%s\n' "$current") <(printf '%s\n' "$recorded") || true)

fail=0
if [ -n "$added" ]; then
	err "published with no caller, and not in the census:"
	printf '%s\n' "$added" | sed 's/^/      /' >&2
	printf '  Either give it a caller, revoke its grants, or record it with --write.\n' >&2
	fail=1
fi
if [ -n "$gone" ]; then
	err "in the census but no longer published with no caller:"
	printf '%s\n' "$gone" | sed 's/^/      /' >&2
	printf '  Refresh with --write.\n' >&2
	fail=1
fi

[ "$fail" -eq 0 ] || exit 1
log "$(printf '%s\n' "$current" | wc -l | tr -d ' ') published functions have no caller, all recorded"
