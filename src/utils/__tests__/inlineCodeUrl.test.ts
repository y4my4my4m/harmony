import { describe, it, expect } from 'vitest'
import { parseContentToMessageParts } from '@/utils/unifiedContentProcessing'

describe('URL inside inline code', () => {
  it('stays text for the code renderer', async () => {
    const parts = await parseContentToMessageParts('remplace ca par `https://har.mony.lol/invite/C2GZ1T3F` stp')
    expect(parts.some((p: { type: string }) => p.type === 'url')).toBe(false)
  })
  it('still links a bare URL', async () => {
    const parts = await parseContentToMessageParts('see https://har.mony.lol/invite/C2GZ1T3F')
    expect(parts.some((p: { type: string }) => p.type === 'url')).toBe(true)
  })
})
