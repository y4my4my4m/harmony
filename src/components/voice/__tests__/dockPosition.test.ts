import { describe, expect, it } from 'vitest'
import { DEFAULT_DOCK_POSITION, parseDockPosition, serializeDockPosition } from '../dockPosition'

describe('dock position storage', () => {
  it('reads no entry, garbage and partial entries as the default', () => {
    for (const raw of [null, '', 'not json', 'null', '{"left":5}', '{"v":2,"left":"x","bottom":40}', '{"left":null,"bottom":40}']) {
      expect(parseDockPosition(raw)).toEqual(DEFAULT_DOCK_POSITION)
    }
  })

  it('keeps the left edge apart from centred', () => {
    const edge = { left: 0, bottom: 240 }
    const centred = { left: null, bottom: 240 }
    expect(parseDockPosition(serializeDockPosition(edge))).toEqual(edge)
    expect(parseDockPosition(serializeDockPosition(centred))).toEqual(centred)
    expect(parseDockPosition(serializeDockPosition({ left: 312.5, bottom: 12 }))).toEqual({ left: 312.5, bottom: 12 })
  })

  it('stores the default position as no entry', () => {
    expect(serializeDockPosition({ ...DEFAULT_DOCK_POSITION })).toBeNull()
    expect(serializeDockPosition({ left: 0, bottom: DEFAULT_DOCK_POSITION.bottom })).not.toBeNull()
  })

  it('reads an entry of the earlier form, where left 0 was centred', () => {
    expect(parseDockPosition('{"left":0,"bottom":240}')).toEqual({ left: null, bottom: 240 })
    expect(parseDockPosition('{"left":150,"bottom":240}')).toEqual({ left: 150, bottom: 240 })
  })
})
