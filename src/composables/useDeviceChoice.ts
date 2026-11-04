import { computed, ref, type ComputedRef, type Ref, type WritableComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * State and options of a media device <select>.
 *
 * 'none': no device of the kind; the select reads None and is disabled.
 * 'unnamed': devices present, none named. Chromium lists one entry per kind with an empty id and
 * label until a capture permission is granted; the select offers Default (the empty id, which
 * every consumer reads as the system device) and the page offers to ask for access.
 * 'named': the devices by name.
 */
export type DeviceListState = 'none' | 'unnamed' | 'named'

export interface DeviceOption {
  value: string
  label: string
}

interface DeviceLike {
  deviceId: string
  label: string
}

export function deviceListState(devices: readonly DeviceLike[]): DeviceListState {
  if (devices.length === 0) return 'none'
  return devices.some((device) => device.label) ? 'named' : 'unnamed'
}

export interface DeviceOptionNames {
  none: string
  system: string
  /** Name of the nth (1-based) device that has no label of its own. */
  numbered: (n: number) => string
  /** First option before the devices, e.g. "No camera" (''); replaces Default when unnamed. */
  leading?: DeviceOption
}

export function deviceOptions(devices: readonly DeviceLike[], names: DeviceOptionNames): DeviceOption[] {
  const state = deviceListState(devices)
  if (state === 'none') return [{ value: '', label: names.none }]
  if (state === 'unnamed') return [names.leading ?? { value: '', label: names.system }]
  // Chromium's "default" entry has an empty label in CEF and the headless shell.
  const listed = devices.map((device, index) => ({
    value: device.deviceId,
    label: device.label || (device.deviceId === 'default' ? names.system : names.numbered(index + 1)),
  }))
  return names.leading ? [names.leading, ...listed] : listed
}

export interface DeviceChoice {
  state: ComputedRef<DeviceListState>
  options: ComputedRef<DeviceOption[]>
  /** The select's model: the stored choice when listed, else the first option. */
  value: WritableComputedRef<string>
}

export function useDeviceChoice(
  devices: Ref<readonly DeviceLike[]>,
  selected: Ref<string>,
  names: () => DeviceOptionNames,
): DeviceChoice {
  const state = computed(() => deviceListState(devices.value))
  const options = computed(() => deviceOptions(devices.value, names()))
  const value = computed({
    get: () => (options.value.some((option) => option.value === selected.value) ? selected.value : options.value[0].value),
    set: (next: string) => {
      selected.value = next
    },
  })
  return { state, options, value }
}

export type DeviceAccess = 'idle' | 'asking' | 'blocked' | 'failed'

/**
 * Asks for microphone or camera access so the devices of that kind are named, then calls
 * `refresh` to read them. The capture's tracks are stopped at once.
 */
export function useDeviceAccess(refresh: () => Promise<void>) {
  const { t } = useI18n()
  const microphone = ref<DeviceAccess>('idle')
  const camera = ref<DeviceAccess>('idle')

  async function allow(kind: 'audio' | 'video'): Promise<void> {
    const access = kind === 'audio' ? microphone : camera
    if (access.value === 'asking') return
    access.value = 'asking'
    try {
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: true } : { video: true })
      stream.getTracks().forEach((track) => track.stop())
      access.value = 'idle'
    } catch (error) {
      const name = (error as { name?: string } | null)?.name
      access.value = name === 'NotAllowedError' || name === 'SecurityError' ? 'blocked' : 'failed'
    }
    await refresh()
  }

  function problem(kind: 'audio' | 'video'): string | null {
    const access = (kind === 'audio' ? microphone : camera).value
    if (access === 'blocked') return t(kind === 'audio' ? 'settings.voice.microphoneBlocked' : 'settings.voice.cameraBlocked')
    if (access === 'failed') return t('settings.voice.deviceOpenFailed')
    return null
  }

  return { microphone, camera, allow, problem }
}

/** Option names of the three device selects, in the current locale. */
export function useDeviceOptionNames() {
  const { t } = useI18n()
  const base = () => ({ none: t('settings.voice.deviceNone'), system: t('settings.voice.deviceDefault') })
  return {
    input: (): DeviceOptionNames => ({ ...base(), numbered: (n) => `${t('settings.voice.microphone')} ${n}` }),
    output: (): DeviceOptionNames => ({ ...base(), numbered: (n) => `${t('settings.voice.outputDevice')} ${n}` }),
    camera: (): DeviceOptionNames => ({
      ...base(),
      numbered: (n) => `${t('settings.voice.videoDevice')} ${n}`,
      leading: { value: '', label: t('settings.voice.noCamera') },
    }),
  }
}
