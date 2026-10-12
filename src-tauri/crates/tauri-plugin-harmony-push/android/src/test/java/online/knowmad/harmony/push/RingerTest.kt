package online.knowmad.harmony.push

import android.app.Application
import android.app.NotificationManager
import android.media.AudioManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Ringer mode as the webview's alert sounds read it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RingerTest {
  private lateinit var app: Application
  private lateinit var audio: AudioManager
  private lateinit var nm: NotificationManager

  @Before
  fun setUp() {
    app = ApplicationProvider.getApplicationContext()
    audio = app.getSystemService(AudioManager::class.java)
    nm = app.getSystemService(NotificationManager::class.java)
    // Changing the interruption filter needs notification policy access.
    shadowOf(nm).setNotificationPolicyAccessGranted(true)
    nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_ALL)
  }

  @Test
  fun readsTheRingerMode() {
    audio.ringerMode = AudioManager.RINGER_MODE_NORMAL
    assertEquals(Ringer.NORMAL, Ringer.mode(app))
    audio.ringerMode = AudioManager.RINGER_MODE_VIBRATE
    assertEquals(Ringer.VIBRATE, Ringer.mode(app))
    audio.ringerMode = AudioManager.RINGER_MODE_SILENT
    assertEquals(Ringer.SILENT, Ringer.mode(app))
  }

  @Test
  fun doNotDisturbIsSilent() {
    audio.ringerMode = AudioManager.RINGER_MODE_NORMAL
    nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_PRIORITY)
    assertEquals(Ringer.SILENT, Ringer.mode(app))
  }
}
