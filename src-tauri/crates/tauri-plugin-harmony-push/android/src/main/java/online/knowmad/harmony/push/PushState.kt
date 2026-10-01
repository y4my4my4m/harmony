package online.knowmad.harmony.push

import android.content.Context
import app.tauri.plugin.JSObject
import java.lang.ref.WeakReference

/**
 * State shared by the plugin, which lives with the activity, and the push services, which
 * also run in a process started only to receive a message.
 */
object PushState {
  private const val PREFS = "harmony_push_state"
  private const val KEY_FCM_TOKEN = "fcm_token"
  private const val KEY_UP_ENDPOINT = "up_endpoint"
  private const val KEY_UP_P256DH = "up_p256dh"
  private const val KEY_UP_AUTH = "up_auth"
  private const val KEY_UP_TEMPORARY = "up_temporary"
  private const val KEY_UP_FAILURE = "up_failure"

  /** The activity is visible; the webview then shows notifications itself. */
  @Volatile
  var foreground: Boolean = false

  @Volatile
  private var plugin: WeakReference<PushPlugin>? = null

  fun attach(instance: PushPlugin) {
    plugin = WeakReference(instance)
  }

  fun detach(instance: PushPlugin) {
    if (plugin?.get() === instance) plugin = null
  }

  /** Forwards an event to the webview when one is running. */
  fun emit(event: String, payload: JSObject = JSObject()) {
    plugin?.get()?.trigger(event, payload)
  }

  fun fcmToken(context: Context): String? = prefs(context).getString(KEY_FCM_TOKEN, null)

  fun setFcmToken(context: Context, token: String) {
    prefs(context).edit().putString(KEY_FCM_TOKEN, token).apply()
  }

  data class UnifiedPushEndpoint(val url: String, val p256dh: String, val auth: String, val temporary: Boolean)

  fun unifiedPushEndpoint(context: Context): UnifiedPushEndpoint? {
    val p = prefs(context)
    val url = p.getString(KEY_UP_ENDPOINT, null) ?: return null
    val p256dh = p.getString(KEY_UP_P256DH, null) ?: return null
    val auth = p.getString(KEY_UP_AUTH, null) ?: return null
    return UnifiedPushEndpoint(url, p256dh, auth, p.getBoolean(KEY_UP_TEMPORARY, false))
  }

  fun setUnifiedPushEndpoint(context: Context, endpoint: UnifiedPushEndpoint) {
    prefs(context).edit()
      .putString(KEY_UP_ENDPOINT, endpoint.url)
      .putString(KEY_UP_P256DH, endpoint.p256dh)
      .putString(KEY_UP_AUTH, endpoint.auth)
      .putBoolean(KEY_UP_TEMPORARY, endpoint.temporary)
      .remove(KEY_UP_FAILURE)
      .commit()
  }

  fun unifiedPushFailure(context: Context): String? = prefs(context).getString(KEY_UP_FAILURE, null)

  fun setUnifiedPushFailure(context: Context, reason: String) {
    prefs(context).edit().putString(KEY_UP_FAILURE, reason).commit()
  }

  fun clearUnifiedPush(context: Context) {
    prefs(context).edit()
      .remove(KEY_UP_ENDPOINT)
      .remove(KEY_UP_P256DH)
      .remove(KEY_UP_AUTH)
      .remove(KEY_UP_TEMPORARY)
      .commit()
  }

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
