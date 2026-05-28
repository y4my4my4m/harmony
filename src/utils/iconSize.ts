/**
 * Resolve an icon `size` prop to a positive pixel number.
 *
 * Mirrors the behavior of `src/components/common/Icon.vue` so the lucide
 * wrapper components (`Bell.vue`, `DeclineIcon.vue`, etc.) accept the same
 * inputs as the generic `Icon`:
 *
 *   - A `number`        → used directly.
 *   - A numeric string  → parsed via `parseInt`.
 *   - A symbolic string → looked up in `xs|sm|md|lg|xl`.
 *   - Anything else     → falls back to `fallback`.
 *
 * Previously the wrappers used `Number(size)` blindly. `Number("sm")` is
 * `NaN`, which broke icon rendering whenever a caller passed a symbolic
 * size - a real possibility given the wrappers' props were typed
 * `number | string`. See BUGS.md for the report.
 */
export function resolveIconSize(
  size: number | string | undefined | null,
  fallback = 20,
): number {
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
    return size
  }
  if (typeof size === 'string' && size.length > 0) {
    const num = parseInt(size, 10)
    if (!Number.isNaN(num) && num > 0) return num
    const symbolic: Record<string, number> = {
      xs: 12,
      sm: 16,
      md: 20,
      lg: 24,
      xl: 28,
      small: 16,
      medium: 20,
      large: 24,
    }
    if (size in symbolic) return symbolic[size]
  }
  return fallback
}
