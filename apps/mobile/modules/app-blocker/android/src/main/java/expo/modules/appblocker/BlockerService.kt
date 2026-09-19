package expo.modules.appblocker

import android.accessibilityservice.AccessibilityService
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.view.accessibility.AccessibilityEvent

/**
 * Sends the person home from an app the open session's goal blocks, then says so.
 *
 * It listens for one event type — a window coming to the front — and reads only its package
 * name. The app keeps the blocklist current (`AppBlockerModule.setBlocklist`); outside an
 * active session the list is inactive and this does nothing. An undone app is left alone for ten
 * minutes, and every block and undo is recorded for the server.
 */
class BlockerService : AccessibilityService() {
  private val store by lazy { BlockerStore(this) }
  private var lastPackage: String? = null
  private var lastAt = 0L

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
    val pkg = event.packageName?.toString() ?: return
    if (pkg == packageName || !store.active) return
    val now = System.currentTimeMillis()
    // One app raises several window events as it opens; act once.
    if (pkg == lastPackage && now - lastAt < 2_000) return
    if (!store.isBlocked(pkg) || store.isExempt(pkg, now)) return
    lastPackage = pkg
    lastAt = now

    performGlobalAction(GLOBAL_ACTION_HOME)
    store.record("sent_home", pkg)
    notifyBlocked(this, store, pkg)
  }

  override fun onInterrupt() = Unit

  companion object {
    const val CHANNEL = "lumi.blocks"
    const val EXEMPT_MS = 10 * 60_000L

    internal fun notifyBlocked(context: Context, store: BlockerStore, pkg: String) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL, "Blocked apps", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "When Lumi sends you home from an app your goal blocks"
          },
        )
      }
      val app = store.labelOf(pkg)
      val goal = store.goal
      val id = pkg.hashCode()
      val undo = PendingIntent.getActivity(
        context,
        id,
        Intent(context, UndoActivity::class.java)
          .putExtra(UndoActivity.EXTRA_PACKAGE, pkg)
          .putExtra(UndoActivity.EXTRA_NOTIFICATION, id)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      val builder = if (Build.VERSION.SDK_INT >= 26) {
        Notification.Builder(context, CHANNEL)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
      val text = if (goal != null) "$app is off the list for “$goal”." else "$app is off the list for this session."
      val notification = builder
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle("Lumi sent you home from $app")
        .setContentText(text)
        .setStyle(Notification.BigTextStyle().bigText(text))
        .setAutoCancel(true)
        .addAction(Notification.Action.Builder(null, "Undo for 10 min", undo).build())
        .build()
      try {
        manager.notify(id, notification)
      } catch (_: SecurityException) {
        // Notifications are off for Lumi: the block still happened and is still recorded.
      }
    }
  }
}
