// driveAvailable: the schema has Drive. driveEnabled: instance_config.drive_enabled, carried by
// get_my_drive_usage as 'enabled' since 1.9.4. One call answers both and is kept for the
// session, unless it failed for another reason than a missing function.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import { driveAvailable, driveEnabled, resetDriveAvailability } from '@/services/drive/driveService'

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  resetDriveAvailability()
  rpc.mockReset()
})

describe('driveEnabled', () => {
  it('is on when the server sends no flag', async () => {
    rpc.mockResolvedValue({ data: { used_bytes: 0 }, error: null })
    expect(await driveEnabled()).toBe(true)
    expect(await driveAvailable()).toBe(true)
  })

  it('is off when the instance turned Drive off; the schema is still there', async () => {
    rpc.mockResolvedValue({ data: { enabled: false, used_bytes: 0 }, error: null })
    expect(await driveEnabled()).toBe(false)
    expect(await driveAvailable()).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_my_drive_usage')
  })

  it('is off without Drive functions, and asks once', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'missing' } })
    expect(await driveAvailable()).toBe(false)
    expect(await driveEnabled()).toBe(false)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('keeps no answer from another failure: the next caller asks again', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '28000', message: 'signed out' } })
    expect(await driveEnabled()).toBe(true)
    rpc.mockResolvedValueOnce({ data: { enabled: false }, error: null })
    expect(await driveEnabled()).toBe(false)
    expect(await driveEnabled()).toBe(false)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('answers concurrent callers with one call', async () => {
    rpc.mockResolvedValue({ data: { enabled: true }, error: null })
    const answers = await Promise.all([driveEnabled(), driveAvailable(), driveEnabled()])
    expect(answers).toEqual([true, true, true])
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
