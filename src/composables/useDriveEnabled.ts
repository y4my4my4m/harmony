import { ref, type Ref } from 'vue'
import { driveEnabled } from '@/services/drive/driveService'

/** instance_config.drive_enabled; true until the server answers otherwise. */
const on = ref(true)

/** Whether Drive is turned on for the instance, for showing its entry points. */
export function useDriveEnabled(): Ref<boolean> {
  void driveEnabled().then((value) => { on.value = value })
  return on
}
