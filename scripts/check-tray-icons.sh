#!/usr/bin/env bash
# Fails when the Tauri desktop icons drift from the transparent PWA artwork.
#
# src-tauri/tauri.conf.json lists icons/32x32.png as the first .png in
# bundle.icon; tauri-codegen embeds that first .png as default_window_icon() on
# Unix (tauri-codegen-2.7.6/src/context.rs). src-tauri/src/lib.rs passes
# app.default_window_icon() to both the window and the StatusNotifierItem tray,
# so these three files are what the Linux tray shows. The released deb ships
# white-background PNGs, so regenerate them from the transparent PWA art:
#
#   magick public/img/app_icon_square.webp -filter Lanczos -resize 32x32! \
#     -strip -define png:color-type=6 PNG32:src-tauri/icons/32x32.png
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICONS="$ROOT/src-tauri/icons"
CONF="$ROOT/src-tauri/tauri.conf.json"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

command -v node >/dev/null || { err "node not found"; exit 1; }
if command -v magick >/dev/null; then
  identify() { magick identify "$@"; }
elif command -v identify >/dev/null; then
  identify() { command identify "$@"; }
else
  err "ImageMagick (magick/identify) not found"
  exit 1
fi

fail=0

first_png=$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.bundle.icon.find((i)=>i.endsWith(".png"))||"")' "$CONF")
if [ "$first_png" != "icons/32x32.png" ]; then
  err "bundle.icon first .png is '$first_png', expected icons/32x32.png (the embedded default_window_icon)"
  fail=1
fi

check() { # file expected_size
  local got size channels opaque
  got=$(identify -format '%wx%h|%[channels]|%[opaque]' "$ICONS/$1" 2>/dev/null) || { err "$1: unreadable"; fail=1; return; }
  IFS='|' read -r size channels opaque <<<"$got"
  if [ "$size" != "$2" ] || [[ "$channels" != *a* ]] || [ "$opaque" != "False" ]; then
    err "$1: expected $2 with alpha, got '$got' (want '${2}|*a*|False')"
    fail=1
  fi
}

check 32x32.png 32x32
check 128x128.png 128x128
check 128x128@2x.png 256x256

[ "$fail" -eq 0 ] || exit 1
log "tray icons are 32/128/256 RGBA with transparency; first embedded PNG is 32x32"
