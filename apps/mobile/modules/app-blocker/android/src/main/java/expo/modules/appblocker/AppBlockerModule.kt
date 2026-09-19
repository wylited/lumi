package expo.modules.appblocker

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The app's handle on the blocker service: whether the person turned it on, the way to the
 * Settings page that does, the blocklist to enforce, and the blocks to report.
 */
class AppBlockerModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "AppBlocker needs a React context" }

  private fun isEnabled(): Boolean {
    val enabled = Settings.Secure.getString(
      context.contentResolver,
      Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
    ) ?: return false
    val ours = ComponentName(context, BlockerService::class.java)
    return enabled.split(':').any { ComponentName.unflattenFromString(it) == ours }
  }

  override fun definition() = ModuleDefinition {
    Name("AppBlocker")

    AsyncFunction("isEnabled") { isEnabled() }

    AsyncFunction("openSettings") {
      context.startActivity(
        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }

    AsyncFunction("setBlocklist") { apps: List<String>, goal: String?, active: Boolean ->
      BlockerStore(context).setBlocklist(apps, goal, active)
    }

    AsyncFunction("drainEvents") { BlockerStore(context).drain() }
  }
}
