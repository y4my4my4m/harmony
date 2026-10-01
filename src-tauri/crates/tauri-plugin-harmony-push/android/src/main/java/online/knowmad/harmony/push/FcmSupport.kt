package online.knowmad.harmony.push

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/**
 * FCM availability. "no_config": the build carries no google-services.json, so FirebaseApp
 * never initialized. "no_play_services": the device cannot deliver FCM.
 */
object FcmSupport {
  const val AVAILABLE = "available"
  const val NO_CONFIG = "no_config"
  const val NO_PLAY_SERVICES = "no_play_services"

  fun state(context: Context): String {
    val configured = try {
      FirebaseApp.getApps(context).isNotEmpty()
    } catch (e: Throwable) {
      false
    }
    if (!configured) return NO_CONFIG
    val gms = try {
      GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context)
    } catch (e: Throwable) {
      ConnectionResult.SERVICE_MISSING
    }
    return if (gms == ConnectionResult.SUCCESS) AVAILABLE else NO_PLAY_SERVICES
  }

  /**
   * Fetches the registration token. Auto-init is off in the manifest, so this is the first
   * contact with FCM; enabling it here keeps the token refreshed from then on.
   *
   * firebase-messaging 25.1 deprecates tokens in favour of opt-in FID registration. The
   * backend targets message.token of FCM HTTP v1, which takes a registration token.
   */
  @Suppress("DEPRECATION")
  fun token(context: Context, callback: (token: String?, error: String?) -> Unit) {
    val state = state(context)
    if (state != AVAILABLE) {
      callback(null, state)
      return
    }
    try {
      val messaging = FirebaseMessaging.getInstance()
      messaging.isAutoInitEnabled = true
      messaging.token.addOnCompleteListener { task ->
        val token = if (task.isSuccessful) task.result else null
        if (token.isNullOrEmpty()) {
          callback(null, task.exception?.message ?: "token unavailable")
        } else {
          PushState.setFcmToken(context, token)
          callback(token, null)
        }
      }
    } catch (e: Throwable) {
      callback(null, e.message ?: e.javaClass.simpleName)
    }
  }
}
