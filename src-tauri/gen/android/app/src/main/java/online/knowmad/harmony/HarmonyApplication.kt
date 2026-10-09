package online.knowmad.harmony

import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.lang.ref.WeakReference

// ndk_context holds the Application (tao 0.37 initializes it with getApplicationContext();
// 0.34 held the Activity), so every method the Rust commands call by name lives here.
// Window work goes to the current MainActivity.
class HarmonyApplication : Application() {
  @Volatile
  private var activity: WeakReference<MainActivity>? = null

  fun attach(activity: MainActivity) {
    this.activity = WeakReference(activity)
  }

  // First frame of a video as a JPEG data URL; local paths and remote http(s) URLs
  // (no CORS). "" on failure.
  fun videoThumbnail(url: String): String {
    val retriever = MediaMetadataRetriever()
    return try {
      if (url.startsWith("http")) {
        retriever.setDataSource(url, HashMap<String, String>())
      } else {
        retriever.setDataSource(url)
      }
      val frame = retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        ?: return ""
      val scaled = scaleForThumb(frame)
      val baos = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.JPEG, 75, baos)
      if (scaled != frame) frame.recycle()
      "data:image/jpeg;base64," + Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
    } catch (e: Throwable) {
      ""
    } finally {
      try { retriever.release() } catch (_: Throwable) {}
    }
  }

  private fun scaleForThumb(src: Bitmap): Bitmap {
    val max = 640
    val w = src.width
    val h = src.height
    if (w <= max && h <= max) return src
    val ratio = minOf(max.toFloat() / w, max.toFloat() / h)
    return Bitmap.createScaledBitmap(src, (w * ratio).toInt(), (h * ratio).toInt(), true)
  }

  fun openUrl(url: String) {
    try {
      val uri = Uri.parse(url)
      val scheme = uri.scheme?.lowercase()
      if ((scheme != "https" && scheme != "http") || uri.host.isNullOrEmpty()) {
        android.util.Log.w("Harmony", "openUrl refused a non-web URL")
        return
      }
      // FLAG_ACTIVITY_NEW_TASK: started from the Application context, not an Activity.
      val intent = Intent(Intent.ACTION_VIEW, uri).apply {
        addCategory(Intent.CATEGORY_BROWSABLE)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      startActivity(intent)
    } catch (e: Throwable) {
      android.util.Log.w("Harmony", "openUrl failed: ${e.message}")
    }
  }

  fun startCallService() {
    val i = Intent(this, CallForegroundService::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
  }

  fun stopCallService() {
    stopService(Intent(this, CallForegroundService::class.java))
  }

  // Persisted for MainActivity.restoreBars on the next launch; applied now when an
  // Activity is attached.
  fun setSystemBarColors(statusHex: String, navHex: String, statusDark: Boolean, navDark: Boolean) {
    getSharedPreferences("harmony_ui", MODE_PRIVATE)
      .edit()
      .putString("status_color", statusHex)
      .putString("nav_color", navHex)
      .putBoolean("status_dark", statusDark)
      .putBoolean("nav_dark", navDark)
      .apply()
    activity?.get()?.applyBars(statusHex, navHex, statusDark, navDark)
  }
}
