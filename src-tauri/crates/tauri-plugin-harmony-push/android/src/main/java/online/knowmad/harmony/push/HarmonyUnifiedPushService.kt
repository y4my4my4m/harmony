package online.knowmad.harmony.push

import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/** Bound by the UnifiedPush connector when the distributor delivers an event. */
class HarmonyUnifiedPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    UnifiedPushEvents.onNewEndpoint(this, endpoint)
  }

  override fun onMessage(message: PushMessage, instance: String) {
    UnifiedPushEvents.onMessage(this, message)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    UnifiedPushEvents.onRegistrationFailed(this, reason)
  }

  override fun onUnregistered(instance: String) {
    UnifiedPushEvents.onUnregistered(this)
  }
}
