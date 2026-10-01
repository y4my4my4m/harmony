package online.knowmad.harmony.push

import app.tauri.plugin.JSObject
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Receives FCM data messages, also in a process started only for the message. */
class HarmonyFirebaseService : FirebaseMessagingService() {
  @Suppress("OVERRIDE_DEPRECATION")
  override fun onNewToken(token: String) {
    PushState.setFcmToken(this, token)
    PushState.emit("fcm-token", JSObject().apply { put("token", token) })
  }

  // Runs off the main thread with 10 to 20 s to finish by Android version, so avatars
  // are fetched inline.
  override fun onMessageReceived(message: RemoteMessage) {
    if (message.data.isEmpty()) return
    PushInbox.handle(this, message.data, message.sentTime, fetchImages = true)
  }
}
