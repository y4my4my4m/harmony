/** matrixManagedApi.ts: RPC names and arguments, answers, and the error each failure reads as. */
import { beforeEach, describe, expect, it } from 'vitest'
import { BridgeUnavailableError, forgetIssuedSetupCodes, lastIssuedSetupCode } from '../../discord-bridge/bridgeApi'
import { installBackend, rpcCalls } from '../../discord-bridge/__tests__/bridgeTestKit'
import {
  createMatrixBridge,
  createMatrixSetupCode,
  deleteMatrixBridge,
  fetchMatrixBridgeState,
  matrixManagedErrorKey,
  pairMatrixRoom,
  unpairMatrixRoom,
} from '../matrixManagedApi'
import { InvalidMatrixBridgeResponse } from '../matrixBridgeApi'
import { BRIDGE_ID, rawPair, rawState } from './matrixTestKit'

const answers: Record<string, unknown> = {}
beforeEach(() => {
  forgetIssuedSetupCodes()
  for (const key of Object.keys(answers)) delete answers[key]
  installBackend({}, (name) => {
    if (answers[name] instanceof Error) throw answers[name]
    return answers[name] ?? null
  })
})
const failure = (code: string, message = 'refused') => Object.assign(new Error(message), { code })

describe('matrixManagedApi', () => {
  it('reads the state, and no bridge as null', async () => {
    expect(await fetchMatrixBridgeState('s1')).toBeNull()
    answers.matrix_bridge_state = rawState()
    expect((await fetchMatrixBridgeState('s1'))?.id).toBe(BRIDGE_ID)
    expect(rpcCalls('matrix_bridge_state')).toEqual([{ p_server_id: 's1' }, { p_server_id: 's1' }])
    answers.matrix_bridge_state = { id: 'x' }
    await expect(fetchMatrixBridgeState('s1')).rejects.toBeInstanceOf(InvalidMatrixBridgeResponse)
  })

  it('tells an instance without the functions from a failure', async () => {
    answers.matrix_bridge_state = failure('PGRST202')
    await expect(fetchMatrixBridgeState('s1')).rejects.toBeInstanceOf(BridgeUnavailableError)
    answers.matrix_bridge_state = failure('42501')
    await expect(fetchMatrixBridgeState('s1')).rejects.toMatchObject({ code: '42501' })
  })

  it('creates, pairs, unpairs and deletes', async () => {
    answers.matrix_bridge_create = rawState()
    answers.matrix_bridge_pair = rawState({ pairs: [rawPair()] })
    answers.matrix_bridge_unpair = rawState()
    expect((await createMatrixBridge('s1', 'self')).id).toBe(BRIDGE_ID)
    expect((await pairMatrixRoom(BRIDGE_ID, 'c1', '#a:b', 'to_matrix', 'relay')).pairs).toHaveLength(1)
    expect((await unpairMatrixRoom(BRIDGE_ID, 'c1')).pairs).toEqual([])
    await deleteMatrixBridge(BRIDGE_ID)
    expect(rpcCalls('matrix_bridge_create')).toEqual([{ p_server_id: 's1', p_mode: 'self' }])
    expect(rpcCalls('matrix_bridge_pair')).toEqual([
      { p_bridge_id: BRIDGE_ID, p_channel_id: 'c1', p_room: '#a:b', p_direction: 'to_matrix', p_sender_mode: 'relay' },
    ])
    expect(rpcCalls('matrix_bridge_unpair')).toEqual([{ p_bridge_id: BRIDGE_ID, p_channel_id: 'c1' }])
    expect(rpcCalls('matrix_bridge_delete')).toEqual([{ p_bridge_id: BRIDGE_ID }])
    answers.matrix_bridge_pair = null
    await expect(pairMatrixRoom(BRIDGE_ID, 'c1', '#a:b', 'both', 'ghost')).rejects.toBeInstanceOf(InvalidMatrixBridgeResponse)
  })

  it('remembers the code it issued', async () => {
    answers.matrix_bridge_setup_code = { code: 'MX-AAAA-BBBB-CCCC', expires_at: '2026-11-25T12:30:00Z' }
    expect((await createMatrixSetupCode(BRIDGE_ID)).code).toBe('MX-AAAA-BBBB-CCCC')
    expect(lastIssuedSetupCode(BRIDGE_ID)?.code).toBe('MX-AAAA-BBBB-CCCC')
    answers.matrix_bridge_setup_code = { expires_at: '2026-11-25T12:30:00Z' }
    await expect(createMatrixSetupCode(BRIDGE_ID)).rejects.toBeInstanceOf(InvalidMatrixBridgeResponse)
  })

  it.each([
    [failure('23505', 'The Matrix room is paired with another channel'), 'taken'],
    [failure('P0002'), 'matrixBridge.errors.gone'],
    [failure('42501'), 'discordBridge.errors.permission'],
    [new BridgeUnavailableError(), 'matrixBridge.errors.unavailable'],
    [failure('22023'), 'fallback'],
    [new Error('network'), 'fallback'],
  ])('reads %s as %s', (error, key) => {
    expect(matrixManagedErrorKey(error, 'fallback', 'taken')).toBe(key)
  })
})
