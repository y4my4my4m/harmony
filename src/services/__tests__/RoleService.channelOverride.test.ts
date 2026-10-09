/**
 * setChannelOverride with a managed set rewrites only those bits; the rest of a stored
 * override (voice bits, bits written by bots or the bridge) stays.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import { roleService, Permission, PERMISSION_BITS } from '@/services/RoleService'

const bit = (p: Permission) => BigInt(1) << BigInt(PERMISSION_BITS[p])

let existing: Record<string, unknown> | null
let written: Record<string, unknown> | null

function stubTable() {
  ;(supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select'
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'update' || prop === 'insert') {
          return (row: Record<string, unknown>) => { op = prop as any; written = row; return chain }
        }
        if (prop === 'delete') return () => { op = 'delete'; written = null; return chain }
        if (prop === 'maybeSingle') return () => Promise.resolve({ data: existing, error: null })
        if (prop === 'then') {
          return (ok: any, bad: any) => Promise.resolve({ data: op === 'select' ? existing : null, error: null }).then(ok, bad)
        }
        return () => chain
      },
    })
    return chain
  })
}

describe('RoleService.setChannelOverride', () => {
  beforeEach(() => {
    ;(supabase.from as unknown as ReturnType<typeof vi.fn>).mockReset()
    written = null
    stubTable()
  })

  it('keeps stored bits outside the managed set', async () => {
    const stored = bit(Permission.CONNECT) | bit(Permission.SEND_MESSAGES)
    existing = { id: 'o1', allow_permissions: stored.toString(), deny_permissions: bit(Permission.STREAM).toString() }

    const ok = await roleService.setChannelOverride('c1', 'role', 'r1',
      {}, { [Permission.VIEW_CHANNEL]: true },
      [Permission.VIEW_CHANNEL, Permission.SEND_MESSAGES])

    expect(ok).toBe(true)
    expect(BigInt(written!.allow_permissions as string)).toBe(bit(Permission.CONNECT))
    expect(BigInt(written!.deny_permissions as string)).toBe(bit(Permission.VIEW_CHANNEL) | bit(Permission.STREAM))
  })

  it('replaces the whole override without a managed set', async () => {
    existing = { id: 'o1', allow_permissions: bit(Permission.CONNECT).toString(), deny_permissions: '0' }
    await roleService.setChannelOverride('c1', 'role', 'r1', { [Permission.SPEAK]: true }, {})
    expect(BigInt(written!.allow_permissions as string)).toBe(bit(Permission.SPEAK))
  })
})
