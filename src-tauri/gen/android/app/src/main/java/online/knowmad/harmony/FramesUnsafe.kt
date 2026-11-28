package online.knowmad.harmony

/**
 * User agent mark for a WebView without WebMessageListener, where MainFrameIpc cannot keep the IPC
 * bridge from subframes. The web app (src/services/playTogether/frameSupport.ts) runs no activity
 * frame while it is present.
 */
object FramesUnsafe {
  const val MARK = "HarmonyFramesUnsafe"

  fun userAgent(current: String?): String {
    val base = current.orEmpty()
    return if (base.contains(MARK)) base else "$base $MARK".trim()
  }
}
