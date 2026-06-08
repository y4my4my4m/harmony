/** Masonry picker layout — keep in sync with GifPickerContent masonry-wall props. */
export const GIF_MASONRY_COLUMN_WIDTH = 150
export const GIF_MASONRY_GAP = 10

/** Same column count formula as @yeger/vue-masonry-wall-core. */
export function masonryColumnCount(
  containerWidth: number,
  columnWidth = GIF_MASONRY_COLUMN_WIDTH,
  gap = GIF_MASONRY_GAP,
): number {
  if (containerWidth <= 0) return 2
  return Math.max(1, Math.floor((containerWidth + gap) / (columnWidth + gap)))
}

/**
 * Break an ad out of a single masonry column to span the full wall width.
 * `columnIndex` comes from masonry-wall's slot prop.
 */
export function masonryAdBreakoutStyle(
  columnIndex: number,
  columnCount: number,
  gap = GIF_MASONRY_GAP,
): Record<string, string> {
  if (columnCount <= 1) return { width: '100%' }
  return {
    width: `calc(${columnCount} * 100% + ${(columnCount - 1) * gap}px)`,
    marginLeft: `calc(-${columnIndex} * (100% + ${gap}px))`,
  }
}
