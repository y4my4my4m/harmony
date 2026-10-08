import { describe, expect, it } from 'vitest'
import { showsMinimizedAudioControls } from '../minimizedVoiceControls'

const placed = { atDefaultPosition: true, mobile: false, userPanelDocked: false }

describe('showsMinimizedAudioControls', () => {
  it('hides mic and deafen above the desktop user panel', () => {
    expect(showsMinimizedAudioControls(placed)).toBe(false)
  })

  it('shows them once the panel is moved', () => {
    expect(showsMinimizedAudioControls({ ...placed, atDefaultPosition: false })).toBe(true)
  })

  it('shows them on mobile, where no desktop user panel renders', () => {
    expect(showsMinimizedAudioControls({ ...placed, mobile: true })).toBe(true)
  })

  it('shows them while the user panel is docked into the server rail', () => {
    expect(showsMinimizedAudioControls({ ...placed, userPanelDocked: true })).toBe(true)
  })
})
