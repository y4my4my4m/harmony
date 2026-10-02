#!/usr/bin/env bash
# Names a CI build output:
#
#   bash scripts/name-artifact.sh <Windows|macOS|Android> <release|debug> <file>
#
# renames <file> in place to
#
#   Harmony_<Platform>_V<version>_<kind>-<ref>-<sha7>.<ext>
#
# <kind>     `dev` for a release-profile build, `debug` for a debug one.
# <version>  src-tauri/tauri.conf.json `version`.
# <ref>      GITHUB_REF_NAME, each run of characters outside [A-Za-z0-9.-]
#            replaced by one `-`, cut to 40 characters.
# <sha7>     first 7 characters of GITHUB_SHA.
#
# Tagged releases drop the suffix: Harmony_<Platform>_V<version>.<ext>.
# Runs from the repository root. Prints the new path and appends `path=<new
# path>` to GITHUB_OUTPUT when that is set. Bash 3.2 and BSD userland (macOS
# runners) compatible.
set -euo pipefail

usage() {
  echo "usage: $0 <Windows|macOS|Android> <release|debug> <file>" >&2
  exit 2
}

[ $# -eq 3 ] || usage
platform=$1
profile=$2
file=$3

case $platform in
  Windows | macOS | Android) ;;
  *) usage ;;
esac
case $profile in
  release) kind=dev ;;
  debug) kind=debug ;;
  *) usage ;;
esac
if [ ! -f "$file" ]; then
  echo "$0: no build output at $file" >&2
  exit 1
fi
if [ -z "${GITHUB_REF_NAME:-}" ] || [ -z "${GITHUB_SHA:-}" ]; then
  echo "$0: GITHUB_REF_NAME and GITHUB_SHA must be set" >&2
  exit 1
fi

version=$(node -p "require('./src-tauri/tauri.conf.json').version")
if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "$0: src-tauri/tauri.conf.json version is not x.y.z: $version" >&2
  exit 1
fi

ref=$(printf '%s' "$GITHUB_REF_NAME" | sed -e 's/[^A-Za-z0-9.-][^A-Za-z0-9.-]*/-/g' -e 's/--*/-/g')
ref=${ref:0:40}
ref=${ref#-}
ref=${ref%-}

name="Harmony_${platform}_V${version}_${kind}-${ref}-${GITHUB_SHA:0:7}.${file##*.}"
dest="$(dirname "$file")/$name"
[ "$file" -ef "$dest" ] || mv -- "$file" "$dest"

printf '%s\n' "$dest"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'path=%s\n' "$dest" >>"$GITHUB_OUTPUT"
fi
