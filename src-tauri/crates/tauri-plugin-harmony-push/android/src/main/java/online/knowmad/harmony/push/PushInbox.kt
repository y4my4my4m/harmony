package online.knowmad.harmony.push

import android.content.Context

/** Entry point for a message from any transport. */
object PushInbox {
  enum class Outcome { SHOWN, DISMISSED, SUPPRESSED, IGNORED }

  /**
   * A "read" message cancels; a notification is shown unless the app is visible, in which
   * case the webview has already shown it in-app.
   */
  fun handle(context: Context, data: Map<String, String?>, sentAt: Long, fetchImages: Boolean): Outcome {
    Dismissal.fromMap(data)?.let {
      Notifier.apply(context, it)
      return Outcome.DISMISSED
    }
    if (data["kind"] != "notification") return Outcome.IGNORED
    val payload = PushPayload.fromMap(data, sentAt) ?: return Outcome.IGNORED
    if (PushState.foreground) return Outcome.SUPPRESSED
    Notifier.show(context, payload, fetchImages)
    return Outcome.SHOWN
  }
}
