// Channel and category names as typed. Whitespace becomes '-'; '-' and '_' are separators.
// A trailing separator survives while typing so the next word can follow; leading and
// trailing '-' go on submit.

/** Text channel name while typing: lowercase a-z, 0-9, '-' and '_'. */
export function formatChannelNameInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
}

/** Text channel name as created. */
export function finalizeChannelName(raw: string): string {
  return formatChannelNameInput(raw).replace(/-+$/, '')
}

/** Category name while typing: letters keep their case. */
export function formatCategoryNameInput(raw: string): string {
  return raw
    .replace(/\s/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
}

/** Category name as created. */
export function finalizeCategoryName(raw: string): string {
  return formatCategoryNameInput(raw).replace(/-+$/, '')
}
