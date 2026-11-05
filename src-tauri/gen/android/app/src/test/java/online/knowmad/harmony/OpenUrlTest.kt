package online.knowmad.harmony

import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** openUrl reports whether an app took the URL; with none, startActivity throws ActivityNotFoundException. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = HarmonyApplication::class)
class OpenUrlTest {
  private lateinit var app: HarmonyApplication

  @Before
  fun setUp() {
    app = ApplicationProvider.getApplicationContext()
    shadowOf(app).checkActivities(true)
  }

  private fun installBrowser() {
    val browser = ComponentName("org.example.browser", "org.example.browser.Main")
    val pm = shadowOf(app.packageManager)
    pm.addActivityIfNotPresent(browser)
    pm.addIntentFilterForActivity(
      browser,
      IntentFilter(Intent.ACTION_VIEW).apply {
        addCategory(Intent.CATEGORY_DEFAULT)
        addCategory(Intent.CATEGORY_BROWSABLE)
        addDataScheme("https")
        addDataScheme("http")
      },
    )
  }

  @Test
  fun aWebLinkOpensInTheAppThatHandlesIt() {
    installBrowser()
    assertTrue(app.openUrl("https://github.com/y4my4my4m/harmony/releases/tag/v1.9.2"))
    val started = shadowOf(app).nextStartedActivity
    assertEquals(Intent.ACTION_VIEW, started.action)
    assertEquals(Uri.parse("https://github.com/y4my4my4m/harmony/releases/tag/v1.9.2"), started.data)
    assertTrue(started.hasCategory(Intent.CATEGORY_BROWSABLE))
    assertTrue(started.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
  }

  @Test
  fun withNoAppForWebLinksNothingOpensAndTheCallerIsTold() {
    assertFalse(app.openUrl("https://github.com/y4my4my4m/harmony"))
    assertNull(shadowOf(app).nextStartedActivity)
  }

  @Test
  fun aNonWebUrlIsRefused() {
    installBrowser()
    assertFalse(app.openUrl("intent://scan/#Intent;scheme=zxing;end"))
    assertFalse(app.openUrl("file:///sdcard/x"))
    assertNull(shadowOf(app).nextStartedActivity)
  }
}
