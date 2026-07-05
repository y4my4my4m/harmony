package online.knowmad.harmony

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

// Keeps the process foregrounded during a call so audio/mic survive the app being
// backgrounded (Android 11+ blocks background mic without a mic foreground service).
class CallForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val channelId = "harmony_call"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val mgr = getSystemService(NotificationManager::class.java)
      if (mgr.getNotificationChannel(channelId) == null) {
        mgr.createNotificationChannel(
          NotificationChannel(channelId, "Ongoing call", NotificationManager.IMPORTANCE_LOW)
        )
      }
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val pending =
      PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE)
    val notif =
      NotificationCompat.Builder(this, channelId)
        .setSmallIcon(R.drawable.ic_stat_harmony)
        .setContentTitle("Harmony")
        .setContentText("Voice call in progress")
        .setOngoing(true)
        .setContentIntent(pending)
        .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(CALL_NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(CALL_NOTIF_ID, notif)
    }
    return START_STICKY
  }

  companion object {
    const val CALL_NOTIF_ID = 4242
  }
}
