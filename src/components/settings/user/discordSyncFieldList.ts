import type { SyncField } from '@/services/discordMigrationService'

export const ACCOUNT_SYNC_FIELDS: SyncField[] = ['avatar', 'display_name', 'banner', 'accent_color']
export const SERVER_SYNC_FIELDS: SyncField[] = ['server_nickname', 'server_avatar', 'server_banner']
export const ALL_SYNC_FIELDS: SyncField[] = [...ACCOUNT_SYNC_FIELDS, ...SERVER_SYNC_FIELDS]

/** Every field is ticked until the member has saved a choice of their own. */
export function initialSyncFields(link: { syncChosen: boolean; syncFields: SyncField[] } | null | undefined): SyncField[] {
  return link?.syncChosen ? [...link.syncFields] : [...ALL_SYNC_FIELDS]
}
