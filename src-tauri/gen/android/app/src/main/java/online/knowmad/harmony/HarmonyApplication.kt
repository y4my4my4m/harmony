package online.knowmad.harmony

import android.app.Application
import android.app.DownloadManager
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Environment
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

  // DownloadManager saves into Downloads (API 29+: the shared Downloads folder, no storage
  // permission; before: the app's own Downloads folder), shows its progress notification and
  // resumes after a dropped connection. Throws for a non-web URL; the Rust caller clears it.
  fun downloadUrl(url: String, fileName: String) {
    val uri = Uri.parse(url)
    val scheme = uri.scheme?.lowercase()
    require((scheme == "https" || scheme == "http") && !uri.host.isNullOrEmpty()) { "not a web URL" }
    val name = downloadName(fileName)
    val request = DownloadManager.Request(uri)
      .setTitle(name)
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
    } else {
      request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name)
    }
    (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
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

// A file name for Downloads: path separators and control characters become `_`, at most 200
// characters, never empty.
internal fun downloadName(fileName: String): String {
  val cleaned = fileName.map { c -> if (c == '/' || c == '\\' || c.isISOControl()) '_' else c }
    .joinToString("")
    .trim()
    .trimEnd('.', ' ')
  val bounded = if (cleaned.length > 200) cleaned.take(200) else cleaned
  return bounded.ifEmpty { "download" }
}
