/** Which share summary a file's details show, and the count of people and places. */
export type DriveShareSummary =
  | { kind: 'private' }
  | { kind: 'link' }
  | { kind: 'both'; others: number }
  | { kind: 'people'; others: number }

/** An expired link share leaves the file restricted; one alone reads as private. */
export function driveShareSummary(
  shares: ReadonlyArray<{ scope: string; expires_at: string | null }>,
  now: number = Date.now(),
): DriveShareSummary {
  const link = shares.some((s) => s.scope === 'link' && (!s.expires_at || Date.parse(s.expires_at) > now))
  const others = shares.filter((s) => s.scope !== 'link').length
  if (link && others) return { kind: 'both', others }
  if (link) return { kind: 'link' }
  if (others) return { kind: 'people', others }
  return { kind: 'private' }
}
