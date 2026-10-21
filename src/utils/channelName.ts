// Text channel names as typed: whitespace becomes '-'; '-' and '_' are separators. A trailing
// separator survives while typing so the next word can follow; leading and trailing '-' go on
// submit. Category names keep spaces and letter case, as the default "Text Channels" does.

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

/** Category name while typing: a run of whitespace becomes one space; no leading space. */
export function formatCategoryNameInput(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/^ /, '')
}

/** Category name as created or renamed. */
export function finalizeCategoryName(raw: string): string {
  return formatCategoryNameInput(raw).trim()
}

export type CategoryNameProblem = 'required' | 'tooShort' | 'tooLong'

/** The rule both category dialogs apply to a finalized name; the database caps it at 100. */
export function categoryNameProblem(name: string): CategoryNameProblem | null {
  if (!name) return 'required'
  if (name.length < 2) return 'tooShort'
  if (name.length > 100) return 'tooLong'
  return null
}
