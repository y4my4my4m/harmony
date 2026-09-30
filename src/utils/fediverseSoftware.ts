// NodeInfo `software.name` is lowercase; these are the projects' own spellings.
const SOFTWARE_NAMES: Record<string, string> = {
  akkoma: 'Akkoma',
  bookwyrm: 'BookWyrm',
  calckey: 'Calckey',
  firefish: 'Firefish',
  friendica: 'Friendica',
  funkwhale: 'Funkwhale',
  gotosocial: 'GoToSocial',
  harmony: 'Harmony',
  hubzilla: 'Hubzilla',
  iceshrimp: 'Iceshrimp',
  kbin: 'kbin',
  lemmy: 'Lemmy',
  mastodon: 'Mastodon',
  mbin: 'Mbin',
  misskey: 'Misskey',
  mitra: 'Mitra',
  peertube: 'PeerTube',
  pixelfed: 'Pixelfed',
  pleroma: 'Pleroma',
  sharkey: 'Sharkey',
  snac: 'snac',
  wordpress: 'WordPress',
  writefreely: 'WriteFreely',
}

/** Display name for a NodeInfo software id; unknown ids are returned as given. */
export function softwareDisplayName(software?: string | null): string {
  const raw = (software || '').trim()
  if (!raw) return ''
  const key = raw.toLowerCase().replace(/[^a-z]/g, '')
  return SOFTWARE_NAMES[key] ?? raw
}

/** Single-letter monogram for an instance without an icon. */
export function instanceMonogram(domain?: string | null): string {
  const first = (domain || '').replace(/^www\./i, '').match(/[a-z0-9]/i)
  return first ? first[0].toUpperCase() : '?'
}
