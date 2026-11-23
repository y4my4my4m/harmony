package online.knowmad.harmony

import org.junit.Assert.assertEquals
import org.junit.Test

class FramesUnsafeTest {
  @Test
  fun appendsTheMarkOnce() {
    val ua = "Mozilla/5.0 (Linux; Android 7.0) Chrome/58.0 Mobile Safari/537.36"
    val marked = FramesUnsafe.userAgent(ua)
    assertEquals("$ua HarmonyFramesUnsafe", marked)
    assertEquals(marked, FramesUnsafe.userAgent(marked))
  }

  @Test
  fun marksAnEmptyUserAgent() {
    assertEquals("HarmonyFramesUnsafe", FramesUnsafe.userAgent(null))
  }
}
