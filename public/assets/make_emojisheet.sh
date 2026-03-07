#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./make_emojisheet.sh [input_dir] [output_png] [cols] [cell_size] [padding]
#
# Example:
#   ./make_emojisheet.sh ./svg emoji_sheet.png 20 48 1

INPUT_DIR="${1:-.}"
OUTPUT_PNG="${2:-emoji_sheet.png}"
COLS="${3:-20}"
CELL_SIZE="${4:-48}"
PADDING="${5:-1}"

if ! command -v magick >/dev/null 2>&1; then
  echo "Error: ImageMagick is required. Install it so the 'magick' command is available."
  exit 1
fi

if [[ ! -d "$INPUT_DIR" ]]; then
  echo "Error: input directory not found: $INPUT_DIR"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mapfile -d '' SVGS < <(find "$INPUT_DIR" -maxdepth 1 -type f -iname '*.svg' -print0 | sort -z)

if [[ ${#SVGS[@]} -eq 0 ]]; then
  echo "Error: no SVG files found in $INPUT_DIR"
  exit 1
fi

echo "Found ${#SVGS[@]} SVG files"

i=0
for svg in "${SVGS[@]}"; do
  out_png="$TMP_DIR/$(printf '%05d.png' "$i")"

  magick \
    -background none \
    "$svg" \
    -resize "${CELL_SIZE}x${CELL_SIZE}" \
    -gravity center \
    -extent "${CELL_SIZE}x${CELL_SIZE}" \
    "$out_png"

  i=$((i + 1))
done

echo "Building grid..."

magick montage \
  "$TMP_DIR"/*.png \
  -background none \
  -tile "${COLS}x" \
  -geometry "${CELL_SIZE}x${CELL_SIZE}+${PADDING}+${PADDING}" \
  "$TMP_DIR/sheet.png"

echo "Scaling final image to 960x192..."

magick "$TMP_DIR/sheet.png" \
  -resize 960x192! \
  "$OUTPUT_PNG"

echo "Wrote $OUTPUT_PNG"
