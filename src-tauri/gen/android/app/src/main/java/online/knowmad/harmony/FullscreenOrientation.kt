package online.knowmad.harmony

import android.app.Activity
import android.content.pm.ActivityInfo

// Fullscreen content turns with the device, rotation lock included: a landscape video fills
// a sideways phone. Leaving fullscreen restores the activity's own orientation.
class FullscreenOrientation(private val activity: Activity) {
  private var saved: Int? = null

  fun enter() {
    if (saved != null) return
    saved = activity.requestedOrientation
    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR
  }

  fun exit() {
    val previous = saved ?: return
    saved = null
    activity.requestedOrientation = previous
  }
}
