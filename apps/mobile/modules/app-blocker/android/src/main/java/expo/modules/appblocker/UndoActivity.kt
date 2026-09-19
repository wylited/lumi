package expo.modules.appblocker

import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.os.Bundle

/**
 * "Undo for 10 min" from the notification: leave the app alone for ten minutes and open it again.
 *
 * An activity rather than a broadcast receiver on purpose: since Android 12 a receiver started
 * from a notification may not open another app ("notification trampolines"), and an activity may.
 * It has no window of its own and finishes at once.
 */
class UndoActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val pkg = intent.getStringExtra(EXTRA_PACKAGE)
    if (pkg != null) {
      val store = BlockerStore(this)
      store.exempt(pkg, System.currentTimeMillis() + BlockerService.EXEMPT_MS)
      store.record("undone", pkg)
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.cancel(intent.getIntExtra(EXTRA_NOTIFICATION, pkg.hashCode()))
      packageManager.getLaunchIntentForPackage(pkg)?.let { startActivity(it) }
    }
    finish()
  }

  companion object {
    const val EXTRA_PACKAGE = "lumi.blocker.package"
    const val EXTRA_NOTIFICATION = "lumi.blocker.notification"
  }
}
