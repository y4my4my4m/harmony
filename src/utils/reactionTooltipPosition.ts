import { stylePoint, styleRect } from '@/utils/appZoom'

/** Anchor reaction tooltips above the hovered chip, centered on it. CSS px. */
export function getReactionTooltipAnchor(event: MouseEvent): { x: number; y: number } {
  const el = event.currentTarget
  if (!(el instanceof HTMLElement)) {
    return stylePoint(event)
  }
  const rect = styleRect(el)
  return {
    x: rect.left + rect.width / 2,
    y: rect.top,
  }
}
