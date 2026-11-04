import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { deviceListState, deviceOptions, useDeviceChoice, type DeviceOptionNames } from '../useDeviceChoice'

const names: DeviceOptionNames = { none: 'None', system: 'Default', numbered: (n) => `Microphone ${n}` }
const camera: DeviceOptionNames = { ...names, numbered: (n) => `Camera ${n}`, leading: { value: '', label: 'No camera' } }

// Chromium without a capture permission: one entry per kind, id and label empty.
const unnamed = [{ deviceId: '', label: '' }]

describe('deviceListState', () => {
  it('tells no devices, unnamed devices and named devices apart', () => {
    expect(deviceListState([])).toBe('none')
    expect(deviceListState(unnamed)).toBe('unnamed')
    expect(deviceListState([{ deviceId: 'abc', label: '' }])).toBe('unnamed')
    expect(deviceListState([{ deviceId: 'default', label: '' }, { deviceId: 'abc', label: 'Desk mic' }])).toBe('named')
  })
})

describe('deviceOptions', () => {
  it('reads None with no device and Default when unnamed', () => {
    expect(deviceOptions([], names)).toEqual([{ value: '', label: 'None' }])
    expect(deviceOptions(unnamed, names)).toEqual([{ value: '', label: 'Default' }])
  })

  it('names the unlabelled default entry Default and numbers other unlabelled entries', () => {
    expect(deviceOptions([
      { deviceId: 'default', label: '' },
      { deviceId: 'a', label: 'Desk mic' },
      { deviceId: 'b', label: '' },
    ], names)).toEqual([
      { value: 'default', label: 'Default' },
      { value: 'a', label: 'Desk mic' },
      { value: 'b', label: 'Microphone 3' },
    ])
  })

  it('keeps the leading camera option, which stands in for Default when unnamed', () => {
    expect(deviceOptions([], camera)).toEqual([{ value: '', label: 'None' }])
    expect(deviceOptions(unnamed, camera)).toEqual([{ value: '', label: 'No camera' }])
    expect(deviceOptions([{ deviceId: 'w', label: 'Webcam' }], camera)).toEqual([
      { value: '', label: 'No camera' },
      { value: 'w', label: 'Webcam' },
    ])
  })
})

describe('useDeviceChoice', () => {
  it('shows the first option for a choice the list does not hold, and writes through', () => {
    const devices = ref([{ deviceId: 'a', label: 'Desk mic' }, { deviceId: 'b', label: 'Headset mic' }])
    const selected = ref('gone')
    const { value, state } = useDeviceChoice(devices, selected, () => names)
    expect(state.value).toBe('named')
    expect(value.value).toBe('a')
    value.value = 'b'
    expect(selected.value).toBe('b')
    devices.value = []
    expect(state.value).toBe('none')
    expect(value.value).toBe('')
    expect(selected.value).toBe('b')
  })
})
