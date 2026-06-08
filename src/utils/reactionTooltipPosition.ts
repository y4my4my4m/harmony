/** Anchor reaction tooltips above the hovered chip, centered on it. */
export function getReactionTooltipAnchor(event: MouseEvent): { x: number; y: number } {
  const el = event.currentTarget
  if (!(el instanceof HTMLElement)) {
    return { x: event.clientX, y: event.clientY }
  }
  const rect = el.getBoundingClientRect()
  return {
    x: rect.left + rect.width / 2,
    y: rect.top,
  }
}
