package online.knowmad.harmony.push

import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import com.google.crypto.tink.apps.fixed_webpush.WebPushHybridDecrypt
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.MessagingReceiver
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PublicKeySet
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.keys.KeyManager

/**
 * UnifiedPush through the real connector with a mock distributor: REGISTER goes out as a
 * broadcast, and the distributor's NEW_ENDPOINT, MESSAGE, REGISTRATION_FAILED and
 * UNREGISTERED intents come back into MessagingReceiver.
 *
 * The messages are the fixture unifiedpush-vector.json: what ntfy delivered after the
 * federation-backend web-push sender encrypted them to the fixture's device key. The key
 * manager decrypts them with the connector's WebPushHybridDecrypt, as DefaultKeyManager does
 * with keys held in the Android keystore, which Robolectric lacks.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class UnifiedPushConnectorTest {
  private lateinit var app: Application
  private lateinit var nm: NotificationManager
  private lateinit var vector: JSONObject
  private lateinit var keys: FixtureKeyManager
  private lateinit var receiver: MessagingReceiver

  private val distributor = "io.heckel.ntfy"

  private fun b64url(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  private fun b64(value: String): ByteArray = Base64.decode(value, Base64.DEFAULT)

  class FixtureKeyManager(private val publicKey: ByteArray, private val privateKey: ByteArray, private val auth: ByteArray) : KeyManager {
    override fun decrypt(instance: String, sealed: ByteArray): ByteArray? =
      WebPushHybridDecrypt.Builder()
        .withAuthSecret(auth)
        .withRecipientPublicKey(publicKey)
        .withRecipientPrivateKey(privateKey)
        .build()
        .decrypt(sealed, null)

    override fun generate(instance: String) {}

    override fun getPublicKeySet(instance: String): PublicKeySet = PublicKeySet(
      Base64.encodeToString(publicKey, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),
      Base64.encodeToString(auth, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),
    )

    override fun exists(instance: String): Boolean = true

    override fun delete(instance: String) {}
  }

  /** MessagingReceiverImpl with the fixture keys; it forwards to the same handlers as the app's PushService. */
  class FixtureReceiver(private val keys: KeyManager) : MessagingReceiver() {
    override fun getKeyManager(context: Context): KeyManager = keys
    override fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) =
      UnifiedPushEvents.onNewEndpoint(context, endpoint)
    override fun onMessage(context: Context, message: PushMessage, instance: String) {
      UnifiedPushEvents.onMessage(context, message)
    }
    override fun onRegistrationFailed(context: Context, reason: FailedReason, instance: String) =
      UnifiedPushEvents.onRegistrationFailed(context, reason)
    override fun onUnregistered(context: Context, instance: String) = UnifiedPushEvents.onUnregistered(context)
  }

  @Before
  fun setUp() {
    app = ApplicationProvider.getApplicationContext()
    nm = app.getSystemService(NotificationManager::class.java)
    vector = JSONObject(javaClass.classLoader!!.getResource("unifiedpush-vector.json").readText())
    keys = FixtureKeyManager(b64url(vector.getString("publicKey")), b64url(vector.getString("privateKey")), b64url(vector.getString("auth")))
    receiver = FixtureReceiver(keys)
    PushState.foreground = false
    PushState.clearUnifiedPush(app)
    Notifier.cancelAll(app)
  }

  @After
  fun tearDown() {
    Notifier.cancelAll(app)
  }

  /** Registers with the mock distributor and returns the connection token it was handed. */
  private fun register(): String {
    UnifiedPush.saveDistributor(app, distributor)
    UnifiedPush.register(app, INSTANCE_DEFAULT, "Harmony", vector.getString("vapidPublicKey"), keys)
    val request = shadowOf(app).broadcastIntents.last { it.action == "org.unifiedpush.android.distributor.REGISTER" }
    assertEquals(distributor, request.`package`)
    assertEquals(vector.getString("vapidPublicKey"), request.getStringExtra("vapid"))
    return request.getStringExtra("token")!!
  }

  private fun fromDistributor(action: String, token: String) =
    Intent("org.unifiedpush.android.connector.$action").putExtra("token", token)

  @Test
  fun theDistributorsEndpointIsStoredWithTheWebPushKeys() {
    val token = register()
    receiver.onReceive(app, fromDistributor("NEW_ENDPOINT", token).putExtra("endpoint", vector.getString("endpoint")))

    val endpoint = PushState.unifiedPushEndpoint(app)!!
    assertEquals(vector.getString("endpoint"), endpoint.url)
    assertEquals(vector.getString("publicKey"), endpoint.p256dh)
    assertEquals(vector.getString("auth"), endpoint.auth)
  }

  @Test
  fun aServerMessageIsDecryptedShownAndCancelledByTheReadMessage() {
    val token = register()
    receiver.onReceive(app, fromDistributor("NEW_ENDPOINT", token).putExtra("endpoint", vector.getString("endpoint")))

    receiver.onReceive(app, fromDistributor("MESSAGE", token).putExtra("bytesMessage", b64(vector.getString("notification"))))
    val posted = nm.activeNotifications.single()
    assertEquals("ch:c-1", posted.tag)
    assertEquals(PushPayload.CHANNEL_MENTIONS, posted.notification.channelId)
    val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted.notification)!!
    assertEquals("Guild #general", style.conversationTitle)
    assertEquals("are you there? 👋", style.messages.single().text.toString())
    assertEquals("Alice", style.messages.single().person?.name.toString())
    val target = JSONObject(shadowOf(posted.notification.contentIntent).savedIntent.getStringExtra(Notifier.EXTRA_TARGET)!!)
    assertEquals("/chat/s-1/c-1?messageId=m-1", target.getString("url"))

    receiver.onReceive(app, fromDistributor("MESSAGE", token).putExtra("bytesMessage", b64(vector.getString("dismissal"))))
    assertTrue(nm.activeNotifications.isEmpty())
  }

  @Test
  fun plaintextPostedToTheEndpointIsDropped() {
    val token = register()
    val forged = vector.getJSONObject("expectedNotification").toString().toByteArray()
    receiver.onReceive(app, fromDistributor("MESSAGE", token).putExtra("bytesMessage", forged))
    assertTrue(nm.activeNotifications.isEmpty())
  }

  @Test
  fun aMessageForAnotherConnectionIsIgnored() {
    register()
    receiver.onReceive(app, fromDistributor("MESSAGE", "not-a-token").putExtra("bytesMessage", b64(vector.getString("notification"))))
    assertTrue(nm.activeNotifications.isEmpty())
  }

  @Test
  fun aVisibleAppLeavesDisplayToTheWebview() {
    val token = register()
    PushState.foreground = true
    receiver.onReceive(app, fromDistributor("MESSAGE", token).putExtra("bytesMessage", b64(vector.getString("notification"))))
    assertTrue(nm.activeNotifications.isEmpty())
  }

  @Test
  fun registrationFailureIsRecorded() {
    val token = register()
    receiver.onReceive(app, fromDistributor("REGISTRATION_FAILED", token).putExtra("reason", "VAPID_REQUIRED"))
    assertEquals("VAPID_REQUIRED", PushState.unifiedPushFailure(app))
  }

  @Test
  fun theDistributorDroppingTheRegistrationClearsTheEndpoint() {
    val token = register()
    receiver.onReceive(app, fromDistributor("NEW_ENDPOINT", token).putExtra("endpoint", vector.getString("endpoint")))
    receiver.onReceive(app, fromDistributor("UNREGISTERED", token))
    assertNull(PushState.unifiedPushEndpoint(app))
  }
}
