import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import { reportService } from '@/services/ReportService'

// ReportService goes through the report RPCs; nothing writes the reports table.

const rpc = vi.mocked(supabase.rpc)
const from = vi.mocked(supabase.from)

beforeEach(() => {
  rpc.mockReset()
  from.mockReset()
})

describe('ReportService', () => {
  it('maps a moderator status change onto moderate_report', async () => {
    rpc.mockResolvedValue({ data: { status: 'resolved' }, error: null } as never)

    const ok = await reportService.updateReportStatus('r1', 'resolved', ' handled ', { showResolver: false })

    expect(ok).toBe(true)
    expect(rpc).toHaveBeenCalledWith('moderate_report', {
      p_report_id: 'r1',
      p_action: 'resolve',
      p_note: 'handled',
      p_reason: null,
      p_show_resolver: false,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('reports a refused action with the server message', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Permission denied: suspend_account requires an instance admin' } } as never)

    const result = await reportService.moderateReport('r1', 'suspend_account', { reason: 'spam' })

    expect(result).toEqual({ ok: false, message: 'Permission denied: suspend_account requires an instance admin' })
  })

  it('lists one server\'s reports and reads the total from the rows', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'r1', total_count: 7 }, { id: 'r2', total_count: 7 }], error: null } as never)

    const result = await reportService.getReports({ status: 'pending', serverId: 's1' })

    expect(rpc).toHaveBeenCalledWith('get_reports_with_details', {
      p_status: 'pending', p_limit: 50, p_offset: 0, p_server_id: 's1',
    })
    expect(result.total).toBe(7)
    expect(result.reports).toHaveLength(2)
  })

  it('creates reports through create_report with nulls for absent targets', async () => {
    rpc.mockResolvedValue({ data: 'new-id', error: null } as never)

    const result = await reportService.createReport({ report_type: 'user', reported_user_id: 'u1', reason: 'spam' })

    expect(result).toEqual({ ok: true, id: 'new-id' })
    expect(rpc).toHaveBeenCalledWith('create_report', {
      p_report_type: 'user',
      p_reported_user_id: 'u1',
      p_reported_post_id: null,
      p_reported_message_id: null,
      p_reported_server_id: null,
      p_reason: 'spam',
      p_category: null,
      p_comment: null,
      p_forward: false,
      p_evidence_text: null,
    })
  })
})
