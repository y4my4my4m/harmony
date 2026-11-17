import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as relay from '../protocol.js'

// activities/sdk/protocol.ts is the client half; both must hold the same limits.
const sdkSource = readFileSync(fileURLToPath(new URL('../../../../activities/sdk/protocol.ts', import.meta.url)), 'utf8')

function sdkConstant(name: string): number {
  const match = new RegExp(`export const ${name} = ([^\\n]+)`).exec(sdkSource)
  if (!match) throw new Error(`${name} missing from activities/sdk/protocol.ts`)
  return Function(`return (${match[1]})`)() as number
}

describe('activity protocol parity', () => {
  it.each([
    'PROTOCOL_VERSION',
    'MESSAGE_MAX_BYTES',
    'STATE_MAX_BYTES',
    'STORE_VALUE_MAX_BYTES',
    'STORE_MAX_BYTES',
    'STORE_MAX_KEYS',
    'STORE_KEY_MAX_LENGTH',
    'MEMBER_STATE_MAX_BYTES',
    'RATE_MESSAGES_PER_SECOND',
    'RATE_MESSAGES_BURST',
    'RATE_BYTES_PER_SECOND',
    'RATE_BYTES_BURST',
    'RELAY_FRAME_MAX_BYTES',
  ] as const)('%s matches the SDK', (name) => {
    expect(relay[name]).toBe(sdkConstant(name))
  })
})
