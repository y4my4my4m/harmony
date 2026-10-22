package online.knowmad.harmony

import android.app.Activity
import android.app.Application
import android.content.pm.ActivityInfo
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Fullscreen follows the sensor; leaving it restores the orientation the activity had. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], application = Application::class)
class FullscreenOrientationTest {
  private lateinit var activity: Activity
  private lateinit var orientation: FullscreenOrientation

  @Before
  fun setUp() {
    activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    orientation = FullscreenOrientation(activity)
  }

  @Test
  fun fullscreenTurnsWithTheSensorAndLeavingRestoresTheActivityOrientation() {
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    orientation.enter()
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR, activity.requestedOrientation)
    orientation.exit()
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, activity.requestedOrientation)
  }

  @Test
  fun aLockedOrientationComesBackAfterFullscreen() {
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    orientation.enter()
    orientation.enter()
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR, activity.requestedOrientation)
    orientation.exit()
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, activity.requestedOrientation)
  }

  @Test
  fun leavingWithoutEnteringChangesNothing() {
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    orientation.exit()
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, activity.requestedOrientation)
  }
}
