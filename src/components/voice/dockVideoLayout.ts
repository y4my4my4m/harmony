/**
 * Tile geometry for the video strip above the voice dock.
 *
 * Tiles share one row height and take the width of their video's aspect ratio
 * at that height, so a tile frames its video with no bars. The height is the
 * largest that fits every tile in the container width, clamped to
 * [minHeight, maxHeight]; at minHeight the row scrolls. A tile wider than the
 * container or narrower than minTileWidth is clamped and letterboxes on the
 * clamped axis only. All lengths in CSS px.
 */

export interface DockVideoLayoutInput {
  /** Content width of the row; 0 or less when unmeasured. */
  containerWidth: number;
  /** Width / height per tile; null, zero or non-finite falls back to FALLBACK_ASPECT. */
  aspects: ReadonlyArray<number | null | undefined>;
  maxHeight: number;
  minHeight: number;
  gap: number;
  minTileWidth: number;
}

export interface DockVideoLayout {
  height: number;
  widths: number[];
}

/** Aspect of a tile before its video reports dimensions, and of unwatched streams. */
export const FALLBACK_ASPECT = 16 / 9;

export const normalizeAspect = (aspect: number | null | undefined): number =>
  typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0 ? aspect : FALLBACK_ASPECT;

/** Aspect of a video element, or null before metadata. */
export const videoAspect = (width: number, height: number): number | null =>
  width > 0 && height > 0 ? width / height : null;

export function layoutDockVideoTiles(input: DockVideoLayoutInput): DockVideoLayout {
  const { containerWidth, maxHeight, gap, minTileWidth } = input;
  const minHeight = Math.min(input.minHeight, maxHeight);
  const aspects = input.aspects.map(normalizeAspect);
  if (aspects.length === 0) return { height: 0, widths: [] };

  let height = maxHeight;
  if (containerWidth > 0) {
    const sum = aspects.reduce((acc, a) => acc + a, 0);
    const available = containerWidth - gap * (aspects.length - 1);
    height = Math.min(maxHeight, Math.max(minHeight, available / sum));
  }
  height = Math.floor(height);

  const maxTileWidth = containerWidth > 0 ? containerWidth : Infinity;
  const widths = aspects.map(a =>
    Math.floor(Math.min(maxTileWidth, Math.max(minTileWidth, height * a)))
  );

  return { height, widths };
}
