package online.knowmad.harmony

import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

// Host side of HTML fullscreen: a page's requestFullscreen() hands its content to
// onShowCustomView, which the host must show over everything.
interface FullscreenHost {
  fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback)
  fun exitFullscreen()
}

// wry's RustWebChromeClient answers onShowCustomView with onCustomViewHidden, which leaves
// fullscreen as soon as it is entered, and the class is final. This client takes its place
// on the WebView, forwards every other callback to it and hands fullscreen to the host.
class FullscreenChromeClient(
  private val inner: WebChromeClient,
  private val host: FullscreenHost,
) : WebChromeClient() {
  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    host.enterFullscreen(view, callback)
  }

  override fun onHideCustomView() {
    host.exitFullscreen()
  }

  override fun onProgressChanged(view: WebView, newProgress: Int) = inner.onProgressChanged(view, newProgress)

  override fun onReceivedTitle(view: WebView, title: String?) = inner.onReceivedTitle(view, title)

  override fun onReceivedIcon(view: WebView, icon: Bitmap?) = inner.onReceivedIcon(view, icon)

  override fun onReceivedTouchIconUrl(view: WebView, url: String?, precomposed: Boolean) =
    inner.onReceivedTouchIconUrl(view, url, precomposed)

  override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean =
    inner.onCreateWindow(view, isDialog, isUserGesture, resultMsg)

  override fun onRequestFocus(view: WebView) = inner.onRequestFocus(view)

  override fun onCloseWindow(window: WebView) = inner.onCloseWindow(window)

  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean =
    inner.onJsAlert(view, url, message, result)

  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean =
    inner.onJsConfirm(view, url, message, result)

  override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean =
    inner.onJsPrompt(view, url, message, defaultValue, result)

  override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult): Boolean =
    inner.onJsBeforeUnload(view, url, message, result)

  override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
    inner.onGeolocationPermissionsShowPrompt(origin, callback)

  override fun onGeolocationPermissionsHidePrompt() = inner.onGeolocationPermissionsHidePrompt()

  override fun onPermissionRequest(request: PermissionRequest) = inner.onPermissionRequest(request)

  override fun onPermissionRequestCanceled(request: PermissionRequest) = inner.onPermissionRequestCanceled(request)

  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = inner.onConsoleMessage(consoleMessage)

  override fun getDefaultVideoPoster(): Bitmap? = inner.defaultVideoPoster

  override fun getVideoLoadingProgressView(): View? = inner.videoLoadingProgressView

  override fun getVisitedHistory(callback: ValueCallback<Array<String>>) = inner.getVisitedHistory(callback)

  override fun onShowFileChooser(
    webView: WebView,
    filePathCallback: ValueCallback<Array<Uri>>,
    fileChooserParams: FileChooserParams,
  ): Boolean = inner.onShowFileChooser(webView, filePathCallback, fileChooserParams)
}
