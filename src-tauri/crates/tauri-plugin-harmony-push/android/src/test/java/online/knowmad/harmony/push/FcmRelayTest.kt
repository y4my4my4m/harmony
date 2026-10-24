package online.knowmad.harmony.push

import android.app.Application
import android.app.NotificationManager
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.unifiedpush.android.connector.data.PublicKeySet
import org.unifiedpush.android.connector.keys.KeyManager

/**
 * Messages through the push relay: the relay hands FCM the ciphertext an instance's web-push
 * sender produced, base64url in "wp". The fixture unifiedpush-vector.json holds such
 * ciphertexts and the device keys they were encrypted to.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class FcmRelayTest {
  private lateinit var app: Application
  private lateinit var nm: NotificationManager
  private lateinit var vector: JSONObject
  private lateinit var keys: KeyManager

  private fun b64url(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  private fun relayed(standardBase64: String): Map<String, String> = mapOf(
    FcmRelay.FIELD to Base64.encodeToString(Base64.decode(standardBase64, Base64.DEFAULT), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),
  )

  @Before
  fun setUp() {
    app = ApplicationProvider.getApplicationContext()
    nm = app.getSystemService(NotificationManager::class.java)
    vector = JSONObject(javaClass.classLoader!!.getResource("unifiedpush-vector.json").readText())
    keys = UnifiedPushConnectorTest.FixtureKeyManager(
      b64url(vector.getString("publicKey")),
      b64url(vector.getString("privateKey")),
      b64url(vector.getString("auth")),
    )
    PushState.foreground = false
    Notifier.cancelAll(app)
  }

  @After
  fun tearDown() {
    Notifier.cancelAll(app)
  }

  @Test
  fun aRelayedMessageIsDecryptedShownAndCancelledByTheRelayedReadMessage() {
    assertTrue(FcmRelay.isRelayed(relayed(vector.getString("notification"))))
    val outcome = FcmRelay.handle(app, relayed(vector.getString("notification")), System.currentTimeMillis(), keys)
    assertEquals(PushInbox.Outcome.SHOWN, outcome)
    val posted = nm.activeNotifications.single()
    assertEquals("ch:c-1", posted.tag)
    val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted.notification)!!
    assertEquals("are you there? 👋", style.messages.single().text.toString())

    assertEquals(PushInbox.Outcome.DISMISSED, FcmRelay.handle(app, relayed(vector.getString("dismissal")), System.currentTimeMillis(), keys))
    assertTrue(nm.activeNotifications.isEmpty())
  }

  @Test
  fun plaintextOrAForeignCiphertextIsDropped() {
    val forged = vector.getJSONObject("expectedNotification").toString().toByteArray()
    val plain = mapOf(FcmRelay.FIELD to Base64.encodeToString(forged, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
    assertEquals(PushInbox.Outcome.IGNORED, FcmRelay.handle(app, plain, 0L, keys))
    assertEquals(PushInbox.Outcome.IGNORED, FcmRelay.handle(app, mapOf(FcmRelay.FIELD to "%%%"), 0L, keys))

    val noKeys = object : KeyManager by keys {
      override fun decrypt(instance: String, sealed: ByteArray): ByteArray? = null
    }
    assertEquals(PushInbox.Outcome.IGNORED, FcmRelay.handle(app, relayed(vector.getString("notification")), 0L, noKeys))
    assertTrue(nm.activeNotifications.isEmpty())
  }

  @Test
  fun aDirectFcmMessageIsNotRelayed() {
    assertTrue(!FcmRelay.isRelayed(mapOf("kind" to "notification", "title" to "x")))
  }

  @Test
  fun keysAreGeneratedOnceUnderTheirOwnInstance() {
    val generated = mutableListOf<String>()
    val manager = object : KeyManager {
      var held = false
      override fun decrypt(instance: String, sealed: ByteArray): ByteArray? = null
      override fun generate(instance: String) { generated += instance; held = true }
      override fun getPublicKeySet(instance: String): PublicKeySet? = if (held) PublicKeySet("pub-$instance", "auth-$instance") else null
      override fun exists(instance: String): Boolean = held
      override fun delete(instance: String) {}
    }
    val first = FcmRelay.keys(app, manager)
    val second = FcmRelay.keys(app, manager)
    assertEquals(listOf(FcmRelay.KEY_INSTANCE), generated)
    assertEquals(FcmRelay.Keys("pub-harmony-fcm-relay", "auth-harmony-fcm-relay"), first)
    assertEquals(first, second)
  }
}
