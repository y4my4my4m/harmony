import { computed, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef } from 'vue'
import { adminService, type InstanceStats } from '@/services/AdminService'

/** The flags of a federated_instances row that the instance counts read. */
export interface InstanceFlags {
  is_blocked?: boolean | null
  is_trusted?: boolean | null
  last_seen_at?: string | null
  created_at?: string | null
}

/** The flags of a profiles row that the account counts read. */
export interface UserFlags {
  is_local?: boolean | null
  is_suspended?: boolean | null
}

type UserCounts = Pick<InstanceStats['users'], 'total' | 'local' | 'federated' | 'suspended'>

/** Change of the account counts, the detail of an `admin:users-changed` event. */
export type UsersDelta = Partial<UserCounts>

const DAY_MS = 86_400_000

/** Moves each count by whether one row matched its test before and after a change (null: absent). */
function applyRowChange<R, K extends string>(
  counts: Record<K, number>,
  tests: Record<K, (row: R) => boolean>,
  before: R | null,
  after: R | null,
): void {
  for (const key of Object.keys(tests) as K[]) {
    counts[key] += (after && tests[key](after) ? 1 : 0) - (before && tests[key](before) ? 1 : 0)
  }
}

/** Applies one federated_instances row going from `before` to `after` to the instance counts. */
export function applyInstanceChange(
  counts: InstanceStats['instances'],
  before: InstanceFlags | null,
  after: InstanceFlags | null,
  nowMs: number,
): void {
  const within = (at: string | null | undefined, ms: number) => !!at && nowMs - new Date(at).getTime() <= ms
  applyRowChange<InstanceFlags, keyof InstanceStats['instances']>(counts, {
    total: () => true,
    blocked: (f) => f.is_blocked === true,
    trusted: (f) => f.is_trusted === true,
    active7d: (f) => within(f.last_seen_at, 7 * DAY_MS),
    new24h: (f) => within(f.created_at, DAY_MS),
  }, before, after)
}

/** Applies one profiles row going from `before` to `after` to the account counts. */
export function applyUserChange(counts: UserCounts, before: UserFlags | null, after: UserFlags | null): void {
  applyRowChange<UserFlags, keyof UserCounts>(counts, {
    total: () => true,
    local: (f) => f.is_local === true,
    federated: (f) => f.is_local !== true,
    suspended: (f) => f.is_suspended === true,
  }, before, after)
}

// One snapshot for every admin module: a change made on one tab shows on the others.
const stats = shallowRef<InstanceStats | null>(null)
const loading = ref(false)
const failed = ref(false)
const fetchedAt = ref(0)

async function load(refresh = false): Promise<void> {
  loading.value = true
  try {
    stats.value = await adminService.getAdminInstanceStats(refresh)
    fetchedAt.value = Date.now()
    failed.value = false
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

/** Edits the held snapshot in place, for a change this client made since it was read. */
function adjust(edit: (s: InstanceStats) => void): void {
  if (!stats.value) return
  edit(stats.value)
  triggerRef(stats)
}

function applyUsersDelta(delta: UsersDelta): void {
  adjust((s) => {
    for (const key of Object.keys(delta) as (keyof UserCounts)[]) s.users[key] += delta[key] ?? 0
  })
}

// Account changes made outside the Users tab (reports, signup review) carry their UsersDelta.
if (typeof window !== 'undefined') {
  window.addEventListener('admin:users-changed', (event) => {
    const delta = (event as CustomEvent<UsersDelta | null>).detail
    if (delta) applyUsersDelta(delta)
  })
}

/** The shared statistics snapshot, and its age in seconds, ticking every 15 s while mounted. */
export function useInstanceStats() {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 15_000) })
  onBeforeUnmount(() => clearInterval(timer))

  const ageSeconds = computed(() => {
    const age = stats.value?.ageSeconds
    if (age == null) return null
    return age + Math.max(0, (now.value - fetchedAt.value) / 1000)
  })

  return { stats, loading, failed, ageSeconds, load, adjust }
}
