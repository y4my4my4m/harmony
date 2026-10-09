/**
 * Role writes refused by RLS: PostgREST answers an update or delete the policy
 * filters out with zero rows and no error, which the service reports as a failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import { roleService } from '@/services/RoleService'

/** Chainable PostgREST stub; every terminal await resolves to `rows`. */
function stubRows(rows: unknown[]) {
  ;(supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') return (ok: any, bad: any) => Promise.resolve({ data: rows, error: null }).then(ok, bad)
        return () => chain
      },
    })
    return chain
  })
}

describe('RoleService writes', () => {
  beforeEach(() => {
    ;(supabase.from as unknown as ReturnType<typeof vi.fn>).mockReset()
  })

  it('reports a reorder the policy refused', async () => {
    stubRows([])
    expect(await roleService.reorderRoles('s1', [{ id: 'r1', position: 2 }])).toBe(false)
    stubRows([{ id: 'r1' }])
    expect(await roleService.reorderRoles('s1', [{ id: 'r1', position: 2 }])).toBe(true)
  })

  it('reports a delete the policy refused', async () => {
    vi.spyOn(roleService, 'getRole').mockResolvedValue({ id: 'r1', server_id: 's1', is_default: false } as any)
    stubRows([])
    expect(await roleService.deleteRole('r1')).toBe(false)
    stubRows([{ id: 'r1' }])
    expect(await roleService.deleteRole('r1')).toBe(true)
  })
})
