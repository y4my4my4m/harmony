package online.knowmad.harmony.push

import android.content.Context
import android.util.Log
import app.tauri.plugin.JSObject
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import java.util.concurrent.Executors

/**
 * UnifiedPush connector callbacks. The connector decrypts RFC 8291 Web Push with keys it
 * generated on this device; the server encrypted to the p256dh and auth sent with the
 * endpoint. A message it could not decrypt is not from the server and is dropped: an
 * endpoint URL alone lets anyone post to it.
 */
object UnifiedPushEvents {
  private const val TAG = "HarmonyPush"
  private val background = Executors.newSingleThreadExecutor()

  fun onNewEndpoint(context: Context, endpoint: PushEndpoint) {
    val keys = endpoint.pubKeySet
    if (keys == null) {
      PushState.setUnifiedPushFailure(context, "NO_KEYS")
      PushState.emit("unifiedpush", JSObject().apply { put("event", "failed") })
      return
    }
    PushState.setUnifiedPushEndpoint(
      context,
      PushState.UnifiedPushEndpoint(endpoint.url, keys.pubKey, keys.auth, endpoint.temporary),
    )
    PushState.emit("unifiedpush", JSObject().apply { put("event", "endpoint") })
  }

  /** Runs on the main thread: posts at once from cached images, then fetches the rest. */
  fun onMessage(context: Context, message: PushMessage): PushInbox.Outcome {
    if (!message.decrypted) {
      Log.w(TAG, "UnifiedPush message was not encrypted to this device, dropped")
      return PushInbox.Outcome.IGNORED
    }
    val data = try {
      PushPayload.jsonToMap(JSONObject(String(message.content, Charsets.UTF_8)))
    } catch (e: Exception) {
      Log.w(TAG, "UnifiedPush message is not a Harmony payload")
      return PushInbox.Outcome.IGNORED
    }
    val outcome = PushInbox.handle(context, data, System.currentTimeMillis(), fetchImages = false)
    if (outcome == PushInbox.Outcome.SHOWN) {
      val key = PushPayload.fromMap(data)?.contextKey
      val app = context.applicationContext
      if (key != null) background.execute { Notifier.refreshImages(app, key) }
    }
    return outcome
  }

  fun onRegistrationFailed(context: Context, reason: FailedReason) {
    PushState.setUnifiedPushFailure(context, reason.name)
    PushState.emit("unifiedpush", JSObject().apply {
      put("event", "failed")
      put("reason", reason.name)
    })
  }

  fun onUnregistered(context: Context) {
    PushState.clearUnifiedPush(context)
    PushState.emit("unifiedpush", JSObject().apply { put("event", "unregistered") })
  }
}
