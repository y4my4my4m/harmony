// Third-party markup that renders <div role="button"> without tabindex or key
// handling (vue-easy-lightbox): makes those divs focusable, renames them, and
// activates them with Enter and Space.

/** Gives every [role=button] under `root` a tab stop and, through `rename`, a translated name. */
export function patchRoleButtons(root: ParentNode, rename?: (original: string) => string | undefined): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[role="button"]'))) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0')
    if (!rename) continue
    const original = el.getAttribute('data-a11y-original-label') ?? el.getAttribute('aria-label') ?? ''
    const name = rename(original)
    if (!name) continue
    el.setAttribute('data-a11y-original-label', original)
    if (el.getAttribute('aria-label') !== name) el.setAttribute('aria-label', name)
    if (!el.hasAttribute('title')) el.setAttribute('title', name)
  }
}

/** Keydown handler: Enter or Space on a non-native [role=button] inside `scope` clicks it. */
export function roleButtonKeyActivation(scope: () => Element | null | undefined) {
  return (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const target = event.target as HTMLElement | null
    const root = scope()
    if (!target || !root || !root.contains(target)) return
    if (target.getAttribute('role') !== 'button' || target.matches('button, a[href], input')) return
    event.preventDefault()
    target.click()
  }
}
