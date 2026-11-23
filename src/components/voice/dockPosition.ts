/**
 * Position of the docked voice bar: style pixels (utils/appZoom) from the viewport's left and
 * bottom edges; `left` null when the bar is centred horizontally.
 *
 * Stored under voice-dock-position as `{ v: 2, left, bottom }`; the default position is stored as
 * no entry. An entry without `v` is the earlier form, where left 0 stood for centred.
 */
export interface DockPosition {
  left: number | null;
  bottom: number;
}

export const DEFAULT_DOCK_POSITION: Readonly<DockPosition> = { left: null, bottom: 80 };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function parseDockPosition(raw: string | null): DockPosition {
  if (!raw) return { ...DEFAULT_DOCK_POSITION };
  let parsed: { v?: unknown; left?: unknown; bottom?: unknown } | null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_DOCK_POSITION };
  }
  if (!parsed || !finite(parsed.bottom)) return { ...DEFAULT_DOCK_POSITION };
  if (parsed.v === 2) {
    if (parsed.left === null || finite(parsed.left)) return { left: parsed.left, bottom: parsed.bottom };
    return { ...DEFAULT_DOCK_POSITION };
  }
  if (!finite(parsed.left)) return { ...DEFAULT_DOCK_POSITION };
  return { left: parsed.left === 0 ? null : parsed.left, bottom: parsed.bottom };
}

/** The stored entry; null for the default position. */
export function serializeDockPosition(position: DockPosition): string | null {
  if (position.left === null && Math.abs(position.bottom - DEFAULT_DOCK_POSITION.bottom) < 1) return null;
  return JSON.stringify({ v: 2, left: position.left, bottom: position.bottom });
}
