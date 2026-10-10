import { ref } from 'vue'
import { VoiceSettingsService, normalizeSoundboardVolume } from '@/services/VoiceSettingsService'

/** The listener's soundboard volume (percent 0-100) and mute, persisted in voice settings. */
export function useSoundboardSettings() {
  const settings = VoiceSettingsService.getAll()
  const soundboardVolume = ref(normalizeSoundboardVolume(settings.soundboardVolume))
  const soundboardMuted = ref(settings.soundboardMuted === true)

  const updateSoundboardVolume = () => {
    soundboardVolume.value = normalizeSoundboardVolume(soundboardVolume.value)
    VoiceSettingsService.update('soundboardVolume', soundboardVolume.value)
  }

  const updateSoundboardMuted = () => {
    VoiceSettingsService.update('soundboardMuted', soundboardMuted.value)
  }

  return { soundboardVolume, soundboardMuted, updateSoundboardVolume, updateSoundboardMuted }
}
