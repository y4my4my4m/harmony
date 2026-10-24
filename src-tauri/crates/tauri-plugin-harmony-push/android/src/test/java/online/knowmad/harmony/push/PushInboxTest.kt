package online.knowmad.harmony.push

import android.app.Application
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A visible app leaves notifications to the webview, except the test push it sent itself. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PushInboxTest {
  private lateinit var app: Application
  private lateinit var nm: NotificationManager

  private fun notification(type: String) = mapOf(
    "kind" to "notification", "id" to "n-$type", "type" to type,
    "title" to "Test notification", "body" to "Push notifications are working.", "url" to "/",
  )

  @Before
  fun setUp() {
    app = ApplicationProvider.getApplicationContext()
    nm = app.getSystemService(NotificationManager::class.java)
    Notifier.cancelAll(app)
    PushState.foreground = true
  }

  @After
  fun tearDown() {
    PushState.foreground = false
    Notifier.cancelAll(app)
  }

  @Test
  fun aTestPushIsShownWhileTheAppIsVisible() {
    assertEquals(PushInbox.Outcome.SHOWN, PushInbox.handle(app, notification("test"), System.currentTimeMillis(), fetchImages = false))
    assertEquals(1, nm.activeNotifications.size)
  }

  @Test
  fun anyOtherNotificationIsLeftToTheVisibleApp() {
    assertEquals(PushInbox.Outcome.SUPPRESSED, PushInbox.handle(app, notification("dm"), System.currentTimeMillis(), fetchImages = false))
    assertTrue(nm.activeNotifications.isEmpty())
  }
}
