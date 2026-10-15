package online.knowmad.harmony.push

import android.app.NotificationManager
import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * The phone's ringer, for alert sounds the webview plays. Those go to the media stream, which
 * the ringer mode does not silence; the app asks before playing one.
 */
object Ringer {
  const val NORMAL = "normal"
  const val VIBRATE = "vibrate"
  const val SILENT = "silent"

  /** Length of the buzz standing in for an alert sound on vibrate, ms. */
  const val BUZZ_MS = 180L

  /** Ringer mode, Do Not Disturb (any filter but "all") counting as silent. */
  fun mode(context: Context): String {
    val dnd = context.getSystemService(NotificationManager::class.java)?.currentInterruptionFilter
    if (dnd != null && dnd != NotificationManager.INTERRUPTION_FILTER_ALL && dnd != NotificationManager.INTERRUPTION_FILTER_UNKNOWN) {
      return SILENT
    }
    return when (context.getSystemService(AudioManager::class.java)?.ringerMode) {
      AudioManager.RINGER_MODE_SILENT -> SILENT
      AudioManager.RINGER_MODE_VIBRATE -> VIBRATE
      else -> NORMAL
    }
  }

  fun buzz(context: Context) {
    val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    } ?: return
    if (!vibrator.hasVibrator()) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      vibrator.vibrate(VibrationEffect.createOneShot(BUZZ_MS, VibrationEffect.DEFAULT_AMPLITUDE))
    } else {
      @Suppress("DEPRECATION")
      vibrator.vibrate(BUZZ_MS)
    }
  }
}
