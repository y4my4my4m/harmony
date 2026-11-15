import { reactive, ref } from 'vue'
import { reportService } from '@/services/ReportService'

// Pending reports in the instance queue (instance staff: get_pending_reports_count, every report)
// and in each server's queue (its report moderators: get_reports_with_details with p_server_id).
const instancePending = ref(0)
const serverPending = reactive(new Map<string, number>())

export async function refreshInstancePendingReports(): Promise<void> {
  instancePending.value = await reportService.getPendingReportsCount()
}

export async function refreshServerPendingReports(serverId: string): Promise<void> {
  const { total } = await reportService.getReports({ status: 'pending', limit: 1, serverId })
  serverPending.set(serverId, total)
}

/** The count a 'report_created' notification changed. */
export function refreshPendingReportsFor(data: unknown): Promise<void> {
  const { scope, report_server_id: serverId } = (data ?? {}) as { scope?: unknown; report_server_id?: unknown }
  return scope === 'server' && typeof serverId === 'string'
    ? refreshServerPendingReports(serverId)
    : refreshInstancePendingReports()
}

export function useReportQueueCounts() {
  return { instancePending, serverPending }
}

/** "99+" past 99. */
export function badgeCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}
