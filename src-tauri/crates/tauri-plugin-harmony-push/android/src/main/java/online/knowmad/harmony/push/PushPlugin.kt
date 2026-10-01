package online.knowmad.harmony.push

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.UnifiedPush
import java.util.concurrent.Executors

private const val NOTIFICATIONS = "notifications"

/**
 * Webview side of Android push: transport status, FCM token, UnifiedPush registration,
 * notifications shown by the running app, cancellation, and the target of a tapped
 * notification.
 *
 * Events: "tap" (a notification was tapped while the app ran; call takeLaunchTarget),
 * "fcm-token" (FCM rotated the token), "unifiedpush" ({event: endpoint | failed | unregistered}).
 */
@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = NOTIFICATIONS)
  ]
)
class PushPlugin(private val activity: Activity) : Plugin(activity) {
  private val work = Executors.newSingleThreadExecutor()

  @Volatile
  private var launchTarget: String? = null

  override fun load(webView: WebView) {
    super.load(webView)
    PushState.attach(this)
    PushState.foreground = (activity as? LifecycleOwner)
      ?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.STARTED) ?: true
    Notifier.ensureChannels(activity)
    activity.intent?.let { intake(it) }
  }

  override fun onNewIntent(intent: Intent) {
    if (intake(intent)) trigger("tap", JSObject())
  }

  override fun onResume() {
    PushState.foreground = true
  }

  override fun onStop() {
    PushState.foreground = false
  }

  override fun onDestroy() {
    PushState.detach(this)
  }

  // Recents relaunches an activity with its original intent; that tap was already handled.
  private fun intake(intent: Intent): Boolean {
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return false
    val raw = intent.getStringExtra(Notifier.EXTRA_TARGET) ?: return false
    intent.removeExtra(Notifier.EXTRA_TARGET)
    try {
      JSONObject(raw).optString("ctx").takeIf { it.isNotEmpty() }?.let { Notifier.forget(activity, it) }
    } catch (_: Exception) {
      return false
    }
    launchTarget = raw
    return true
  }

  @Command
  fun status(invoke: Invoke) {
    work.execute {
      val result = JSObject()
      result.put("fcm", FcmSupport.state(activity))
      result.put("permission", permission())
      result.put("unifiedPush", unifiedPushStatus())
      invoke.resolve(result)
    }
  }

  @Command
  fun requestPermission(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || permission() == "granted") {
      resolvePermission(invoke)
    } else {
      requestPermissionForAlias(NOTIFICATIONS, invoke, "permissionCallback")
    }
  }

  @PermissionCallback
  private fun permissionCallback(invoke: Invoke) {
    resolvePermission(invoke)
  }

  @Command
  fun openSettings(invoke: Invoke) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
      .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      activity.startActivity(intent)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "settings unavailable")
    }
  }

  @Command
  fun getFcmToken(invoke: Invoke) {
    FcmSupport.token(activity) { token, error ->
      if (token != null) {
        invoke.resolve(JSObject().apply { put("token", token) })
      } else {
        invoke.reject(error ?: "token unavailable")
      }
    }
  }

  @Command
  fun show(invoke: Invoke) {
    val payload = PushPayload.fromJson(invoke.getArgs())
    if (payload == null) {
      invoke.reject("notification needs an id and a title or body")
      return
    }
    work.execute { Notifier.show(activity, payload, fetchImages = true) }
    invoke.resolve()
  }

  /** Args: {all} | {keepIds} | {ids} | {conversationId, channelId}, first match wins. */
  @Command
  fun cancel(invoke: Invoke) {
    val args = invoke.getArgs()
    val all = args.optBoolean("all", false)
    val keep = strings(args.optJSONArray("keepIds"))
    val ids = strings(args.optJSONArray("ids"))
    val conversationId = args.optString("conversationId").takeIf { it.isNotEmpty() && it != "null" }
    val channelId = args.optString("channelId").takeIf { it.isNotEmpty() && it != "null" }
    work.execute {
      when {
        all -> Notifier.cancelAll(activity)
        keep != null -> Notifier.cancelExcept(activity, keep.toSet())
        ids != null -> Notifier.cancel(activity, ids.toSet())
        conversationId != null || channelId != null -> Notifier.cancelWhere(activity, conversationId, channelId)
      }
    }
    invoke.resolve()
  }

  @Command
  fun takeLaunchTarget(invoke: Invoke) {
    val raw = launchTarget
    launchTarget = null
    val result = JSObject()
    result.put("target", raw?.let { JSONObject(it) } ?: JSONObject.NULL)
    invoke.resolve(result)
  }

  /** Args: {distributor, vapid}. The endpoint arrives later as a "unifiedpush" event. */
  @Command
  fun unifiedPushRegister(invoke: Invoke) {
    val args = invoke.getArgs()
    val distributor = args.optString("distributor")
    val vapid = args.optString("vapid").takeIf { it.isNotEmpty() && it != "null" }
    if (distributor.isEmpty()) {
      invoke.reject("distributor required")
      return
    }
    try {
      // The previous distributor's endpoint stops working once another is saved.
      if (UnifiedPush.getSavedDistributor(activity) != distributor) {
        PushState.clearUnifiedPush(activity)
        UnifiedPush.saveDistributor(activity, distributor)
      }
      UnifiedPush.register(activity, INSTANCE_DEFAULT, "Harmony", vapid)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.javaClass.simpleName)
    }
  }

  @Command
  fun unifiedPushUnregister(invoke: Invoke) {
    try {
      UnifiedPush.unregister(activity)
    } catch (_: Exception) {
    }
    PushState.clearUnifiedPush(activity)
    invoke.resolve()
  }

  private fun resolvePermission(invoke: Invoke) {
    invoke.resolve(JSObject().apply { put("permission", permission()) })
  }

  /** granted | denied | prompt. Notifications switched off in system settings read as denied. */
  private fun permission(): String {
    if (NotificationManagerCompat.from(activity).areNotificationsEnabled()) return "granted"
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "denied"
    return when (getPermissionState(NOTIFICATIONS)) {
      PermissionState.PROMPT, PermissionState.PROMPT_WITH_RATIONALE -> "prompt"
      else -> "denied"
    }
  }

  private fun unifiedPushStatus(): JSObject {
    val result = JSObject()
    val distributors = JSONArray()
    val installed = try {
      UnifiedPush.getDistributors(activity)
    } catch (_: Exception) {
      emptyList()
    }
    for (pkg in installed) {
      if (pkg == activity.packageName) continue
      distributors.put(JSONObject().apply {
        put("id", pkg)
        put("name", label(pkg))
      })
    }
    result.put("distributors", distributors)
    val saved = try {
      UnifiedPush.getAckDistributor(activity) ?: UnifiedPush.getSavedDistributor(activity)
    } catch (_: Exception) {
      null
    }
    result.put("distributor", saved ?: JSONObject.NULL)
    val endpoint = PushState.unifiedPushEndpoint(activity)
    result.put("endpoint", endpoint?.let {
      JSONObject().apply {
        put("url", it.url)
        put("p256dh", it.p256dh)
        put("auth", it.auth)
        put("temporary", it.temporary)
      }
    } ?: JSONObject.NULL)
    result.put("failure", PushState.unifiedPushFailure(activity) ?: JSONObject.NULL)
    return result
  }

  private fun label(pkg: String): String = try {
    val pm = activity.packageManager
    @Suppress("DEPRECATION")
    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
  } catch (_: PackageManager.NameNotFoundException) {
    pkg
  }

  private fun strings(array: JSONArray?): List<String>? =
    array?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).takeIf { s -> s.isNotEmpty() } } }
}
