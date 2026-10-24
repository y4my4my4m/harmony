package online.knowmad.harmony.push

import android.content.Context
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import org.unifiedpush.android.connector.keys.DefaultKeyManager
import org.unifiedpush.android.connector.keys.KeyManager

/**
 * Push through a relay (federation-backend routes/pushRelay.ts): an instance without this
 * build's Firebase project holds an ordinary UnifiedPush subscription whose endpoint is the
 * relay with this device's FCM token, and encrypts Web Push (RFC 8291) to the keys below. The
 * relay forwards the ciphertext unread as the FCM data field "wp", base64url.
 *
 * The keys are the UnifiedPush connector's, under their own instance name so a distributor
 * registration never replaces them. A relayed message that does not decrypt is dropped: the
 * relay URL alone lets anyone with a VAPID key post to it.
 */
object FcmRelay {
  const val KEY_INSTANCE = "harmony-fcm-relay"
  const val FIELD = "wp"
  private const val TAG = "HarmonyPush"
  private const val B64URL = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING

  data class Keys(val p256dh: String, val auth: String)

  /** This device's Web Push keys for relayed messages, generated on first use. */
  fun keys(context: Context, manager: KeyManager = DefaultKeyManager(context)): Keys {
    if (!manager.exists(KEY_INSTANCE)) manager.generate(KEY_INSTANCE)
    val set = manager.getPublicKeySet(KEY_INSTANCE)
      ?: throw IllegalStateException("no Web Push keys for $KEY_INSTANCE")
    return Keys(set.pubKey, set.auth)
  }

  fun isRelayed(data: Map<String, String>): Boolean = data.containsKey(FIELD)

  fun handle(
    context: Context,
    data: Map<String, String>,
    sentAt: Long,
    manager: KeyManager = DefaultKeyManager(context),
  ): PushInbox.Outcome {
    val sealed = try {
      Base64.decode(data[FIELD], B64URL)
    } catch (e: IllegalArgumentException) {
      return PushInbox.Outcome.IGNORED
    }
    val clear = try {
      manager.decrypt(KEY_INSTANCE, sealed)
    } catch (e: Exception) {
      null
    }
    if (clear == null) {
      Log.w(TAG, "Relayed message was not encrypted to this device, dropped")
      return PushInbox.Outcome.IGNORED
    }
    val payload = try {
      PushPayload.jsonToMap(JSONObject(String(clear, Charsets.UTF_8)))
    } catch (e: Exception) {
      Log.w(TAG, "Relayed message is not a Harmony payload")
      return PushInbox.Outcome.IGNORED
    }
    return PushInbox.handle(context, payload, sentAt, fetchImages = true)
  }
}
