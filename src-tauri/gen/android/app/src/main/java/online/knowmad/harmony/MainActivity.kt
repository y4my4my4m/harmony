package online.knowmad.harmony

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  private val fullscreen by lazy {
    FullscreenVideo(window.decorView as ViewGroup) { active -> showFullscreen(active) }
  }

  private val fullscreenOrientation by lazy { FullscreenOrientation(this) }

  private val leaveFullscreenOnBack = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      fullscreen.leave()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    (application as HarmonyApplication).attach(this)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    fitContentToInsets()
    restoreBars()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // wry sets its chrome client after this hook, in the same main-thread task.
    webView.post { wrapChromeClient(webView) }
  }

  private fun wrapChromeClient(webView: WebView) {
    val current: WebChromeClient? = when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> webView.webChromeClient
      WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_CHROME_CLIENT) -> WebViewCompat.getWebChromeClient(webView)
      else -> null
    }
    if (current == null || current is FullscreenChromeClient) return
    webView.webChromeClient = FullscreenChromeClient(current, fullscreen)
  }

  private fun showFullscreen(active: Boolean) {
    // The last callback added runs first: added on entry, it precedes Tauri's back handler.
    leaveFullscreenOnBack.remove()
    if (active) onBackPressedDispatcher.addCallback(this, leaveFullscreenOnBack)
    leaveFullscreenOnBack.isEnabled = active
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = if (active) {
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        } else {
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
        }
      }
    }
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    if (active) {
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
      fullscreenOrientation.enter()
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
      fullscreenOrientation.exit()
    }
  }

  // targetSdk 35+ is edge-to-edge on Android 15+: decorFitsSystemWindows(true)
  // is ignored and the IME no longer resizes the window, so the WebView keeps
  // its full height under the keyboard. Insets are applied as padding on the
  // content root on every API level; the bottom edge takes the larger of the
  // navigation bar and the IME.
  private fun fitContentToInsets() {
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  private fun restoreBars() {
    val prefs = getSharedPreferences("harmony_ui", MODE_PRIVATE)
    val status = prefs.getString("status_color", "#16161e") ?: "#16161e"
    val nav = prefs.getString("nav_color", "#16161e") ?: "#16161e"
    applyBars(status, nav, prefs.getBoolean("status_dark", false), prefs.getBoolean("nav_dark", false))
  }

  fun applyBars(statusHex: String, navHex: String, statusDark: Boolean, navDark: Boolean) {
    runOnUiThread {
      // statusBarColor is a no-op when edge-to-edge is enforced; the inset
      // padding shows the content root background instead.
      parse(statusHex)?.let {
        window.statusBarColor = it
        findViewById<View>(android.R.id.content).setBackgroundColor(it)
      }
      parse(navHex)?.let { window.navigationBarColor = it }
      val controller = WindowInsetsControllerCompat(window, window.decorView)
      controller.isAppearanceLightStatusBars = statusDark
      controller.isAppearanceLightNavigationBars = navDark
    }
  }

  private fun parse(hex: String): Int? =
    try {
      Color.parseColor(hex)
    } catch (e: IllegalArgumentException) {
      null
    }
}
