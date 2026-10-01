package online.knowmad.harmony.push

import android.app.Application
import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The display core every transport feeds: stacking, channels, tap targets, cancellation. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class NotifierTest {
  private lateinit var app: Application
  private lateinit var nm: NotificationManager

  @Before
  fun setUp() {
    app = ApplicationProvider.getApplicationContext()
    nm = app.getSystemService(NotificationManager::class.java)
    PushState.foreground = false
    Notifier.cancelAll(app)
  }

  @After
  fun tearDown() {
    Notifier.cancelAll(app)
  }

  private fun dm(id: String, body: String) = mapOf(
    "kind" to "notification",
    "id" to id,
    "type" to "dm",
    "title" to "Bob sent you a message",
    "body" to body,
    "sender" to "Bob",
    "url" to "/dm/c1?messageId=m-$id",
    "conversation_id" to "c1",
    "message_id" to "m-$id",
  )

  private fun posted(tag: String) = nm.activeNotifications.single { it.tag == tag }

  @Test
  fun messagesInOneConversationStackAndAlertOncePerId() {
    assertEquals(PushInbox.Outcome.SHOWN, PushInbox.handle(app, dm("n1", "hi"), 1000, fetchImages = false))
    PushInbox.handle(app, dm("n2", "there"), 2000, fetchImages = false)
    PushInbox.handle(app, dm("n1", "hi"), 3000, fetchImages = false)

    assertEquals(1, nm.activeNotifications.size)
    val notification = posted("conv:c1").notification
    assertEquals(PushPayload.CHANNEL_MESSAGES, notification.channelId)
    val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification)!!
    assertEquals(listOf("hi", "there"), style.messages.map { it.text.toString() })
    assertEquals("Bob", style.messages.last().person?.name.toString())
    assertEquals(listOf("n1", "n2"), Notifier.active(app)["conv:c1"]!!.map { it.id })
  }

  @Test
  fun tapTargetCarriesTheRouteAndEveryStackedId() {
    PushInbox.handle(app, dm("n1", "hi"), 1000, fetchImages = false)
    PushInbox.handle(app, dm("n2", "there"), 2000, fetchImages = false)

    val intent = shadowOf(posted("conv:c1").notification.contentIntent).savedIntent
    val target = JSONObject(intent.getStringExtra(Notifier.EXTRA_TARGET)!!)
    assertEquals("/dm/c1?messageId=m-n2", target.getString("url"))
    assertEquals("n2", target.getString("id"))
    assertEquals(listOf("n1", "n2"), (0 until target.getJSONArray("ids").length()).map { target.getJSONArray("ids").getString(it) })
    assertEquals("conv:c1", target.getString("ctx"))
  }

  @Test
  fun readingOneMessageKeepsTheRestAndReadingAllRemovesIt() {
    PushInbox.handle(app, dm("n1", "hi"), 1000, fetchImages = false)
    PushInbox.handle(app, dm("n2", "there"), 2000, fetchImages = false)

    assertEquals(PushInbox.Outcome.DISMISSED, PushInbox.handle(app, mapOf("kind" to "read", "ids" to "n1"), 0, false))
    val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted("conv:c1").notification)!!
    assertEquals(listOf("there"), style.messages.map { it.text.toString() })

    PushInbox.handle(app, mapOf("kind" to "read", "ids" to "n2,unknown"), 0, false)
    assertTrue(nm.activeNotifications.isEmpty())
    assertTrue(Notifier.active(app).isEmpty())
  }

  @Test
  fun readAllClearsEveryHarmonyNotification() {
    PushInbox.handle(app, dm("n1", "hi"), 1000, fetchImages = false)
    PushInbox.handle(app, social("f1"), 1000, fetchImages = false)
    PushInbox.handle(app, mapOf("kind" to "read", "all" to "1"), 0, false)
    assertTrue(nm.activeNotifications.isEmpty())
  }

  private fun social(id: String) = mapOf(
    "kind" to "notification",
    "id" to id,
    "type" to "activitypub_follow",
    "title" to "New follower",
    "body" to "carol@remote.social started following you",
    "url" to "/social/profile/carol@remote.social",
  )

  @Test
  fun otherTypesGetTheirOwnNotificationInTheSocialChannel() {
    PushInbox.handle(app, social("f1"), 1000, fetchImages = false)
    PushInbox.handle(app, social("f2"), 1000, fetchImages = false)
    assertEquals(setOf("n:f1", "n:f2"), nm.activeNotifications.map { it.tag }.toSet())
    val notification = posted("n:f1").notification
    assertEquals(PushPayload.CHANNEL_SOCIAL, notification.channelId)
    assertEquals("New follower", notification.extras.getString(NotificationCompat.EXTRA_TITLE))
  }

  @Test
  fun mentionsAndThreadsGroupByChannelAndThread() {
    val mention = mapOf(
      "kind" to "notification", "id" to "m1", "type" to "mention", "title" to "Alice mentioned you",
      "body" to "@you look", "sender" to "Alice", "conv" to "Guild #general", "server_id" to "s1", "channel_id" to "c9",
    )
    PushInbox.handle(app, mention, 1000, fetchImages = false)
    PushInbox.handle(app, mention + ("id" to "m2") + ("thread_id" to "t1") + ("type" to "thread_reply"), 1000, false)
    val channel = posted("ch:c9").notification
    assertEquals(PushPayload.CHANNEL_MENTIONS, channel.channelId)
    assertEquals("Guild #general", NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(channel)!!.conversationTitle)
    assertNotNull(posted("thread:t1"))

    Notifier.cancelWhere(app, null, "c9")
    assertTrue(nm.activeNotifications.isEmpty())
  }

  @Test
  fun aVisibleAppSuppressesPushedNotifications() {
    PushState.foreground = true
    assertEquals(PushInbox.Outcome.SUPPRESSED, PushInbox.handle(app, dm("n1", "hi"), 1000, fetchImages = false))
    assertTrue(nm.activeNotifications.isEmpty())
  }

  @Test
  fun aSwipedNotificationStartsAFreshStack() {
    PushInbox.handle(app, dm("n1", "hi"), 1000, fetchImages = false)
    nm.cancel("conv:c1", Notifier.NOTIFICATION_ID)
    PushInbox.handle(app, dm("n2", "again"), 2000, fetchImages = false)
    val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted("conv:c1").notification)!!
    assertEquals(listOf("again"), style.messages.map { it.text.toString() })
  }

  @Test
  fun keepListCancelsTheRest() {
    PushInbox.handle(app, dm("n1", "hi"), 1000, fetchImages = false)
    PushInbox.handle(app, social("f1"), 1000, fetchImages = false)
    Notifier.cancelExcept(app, setOf("f1"))
    assertEquals(listOf("n:f1"), nm.activeNotifications.map { it.tag })
  }

  @Test
  fun unusablePayloadsAreIgnored() {
    assertEquals(PushInbox.Outcome.IGNORED, PushInbox.handle(app, mapOf("kind" to "notification", "id" to "x"), 0, false))
    assertEquals(PushInbox.Outcome.IGNORED, PushInbox.handle(app, mapOf("kind" to "notification", "title" to "t"), 0, false))
    assertEquals(PushInbox.Outcome.IGNORED, PushInbox.handle(app, mapOf("hello" to "world"), 0, false))
    assertNull(Dismissal.fromMap(mapOf("kind" to "read")))
    assertTrue(nm.activeNotifications.isEmpty())
  }

  @Test
  fun channelsFollowTheNotificationType() {
    assertEquals(PushPayload.CHANNEL_MESSAGES, PushPayload.channelFor("dm"))
    assertEquals(PushPayload.CHANNEL_MESSAGES, PushPayload.channelFor("chat_message"))
    assertEquals(PushPayload.CHANNEL_MENTIONS, PushPayload.channelFor("mention"))
    assertEquals(PushPayload.CHANNEL_MENTIONS, PushPayload.channelFor("activitypub_reply"))
    assertEquals(PushPayload.CHANNEL_SOCIAL, PushPayload.channelFor("reaction"))
    assertEquals(PushPayload.CHANNEL_SOCIAL, PushPayload.channelFor("server_invite"))
  }

  @Test
  fun avatarUrlsMustBeHttp() {
    val p = PushPayload.fromMap(dm("n1", "hi") + ("avatar" to "file:///sdcard/x.png") + ("icon" to "https://cdn.test/i.png"))!!
    assertEquals("", p.avatar)
    assertEquals("https://cdn.test/i.png", p.icon)
  }
}
