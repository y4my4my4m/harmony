package online.knowmad.harmony

import android.os.Build
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Tauri's IPC bridge (`window.ipc.postMessage`), answered for the main frame only.
 *
 * wry adds the bridge with addJavascriptInterface, which Android injects into every frame, and
 * reports every message as coming from the main page's URL. It also injects Tauri's IPC script,
 * invoke key included, into every frame (addDocumentStartJavaScript with the origin rule "*").
 * Together, any iframe (an activity, a YouTube or X embed) runs native commands with the app's
 * local permissions. A WebMessageListener knows the sending frame: subframe messages are dropped.
 *
 * Messages are handed to wry's Ipc on one background thread, as the Java bridge thread did.
 */
object MainFrameIpc {
  private val bridgeThread: Executor = Executors.newSingleThreadExecutor()

  /** Replaces wry's `ipc` Java interface. False when the WebView lacks WebMessageListener. */
  fun install(webView: WebView): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
    val rustWebView = webView as? RustWebView ?: return false
    val client = when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.O -> webView.webViewClient
      WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_CLIENT) -> WebViewCompat.getWebViewClient(webView)
      else -> null
    } as? RustWebViewClient ?: return false
    val ipc = Ipc(rustWebView, client)
    webView.removeJavascriptInterface("ipc")
    WebViewCompat.addWebMessageListener(webView, "ipc", setOf("*")) { _, message, _, isMainFrame, _ ->
      val data = message.data
      if (isMainFrame && data != null) bridgeThread.execute { ipc.postMessage(data) }
    }
    // Interfaces and listeners apply from the next navigation.
    if (webView.url != null) webView.reload()
    return true
  }
}
