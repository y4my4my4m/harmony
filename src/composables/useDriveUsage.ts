import { computed, ref } from 'vue'
import { driveAvailable, getDriveUsage, type DriveUsage } from '@/services/drive/driveService'

/** Drive usage of the signed-in account, shared by the composer and Drive. */
const usage = ref<DriveUsage | null>(null)
let inflight: Promise<void> | null = null
let fetchedAt = 0

/** Usage older than this is fetched again on refresh(), ms. */
const STALE_MS = 30_000

async function load(): Promise<void> {
  if (!(await driveAvailable())) return
  usage.value = await getDriveUsage()
  fetchedAt = Date.now()
}

export function refreshDriveUsage(force = false): Promise<void> {
  if (!force && Date.now() - fetchedAt < STALE_MS) return Promise.resolve()
  inflight ??= load().catch(() => {}).finally(() => { inflight = null })
  return inflight
}

export function resetDriveUsage(): void {
  usage.value = null
  fetchedAt = 0
}

export function useDriveUsage() {
  const full = computed(() => !!usage.value && usage.value.used_bytes >= usage.value.quota_bytes)
  const fraction = computed(() =>
    usage.value && usage.value.quota_bytes > 0 ? Math.min(1, usage.value.used_bytes / usage.value.quota_bytes) : 0)
  return { usage, full, fraction, refresh: refreshDriveUsage }
}
