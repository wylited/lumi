package expo.modules.usagestats

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The one thing an iPhone cannot tell us: which other apps were used, for how
 * long, and how many times the phone was unlocked.
 *
 * Android exposes it through `UsageStatsManager`, gated by the
 * PACKAGE_USAGE_STATS app-op the person grants in Settings. Nothing here reads
 * content: package names, foreground time and keyguard events, nothing else.
 *
 * `sinceLast` is a diff, not a total: the app polls it on the same cadence it
 * flushes signals, and gets "seconds in each app since the previous call".
 */
class UsageStatsModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "UsageStats needs a React context" }

  private var lastPollAt = 0L
  private var lastTotals: Map<String, Long> = emptyMap()

  @Suppress("DEPRECATION")
  private fun hasPermission(): Boolean {
    val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    val mode = appOps.checkOpNoThrow(
      AppOpsManager.OPSTR_GET_USAGE_STATS,
      Process.myUid(),
      context.packageName,
    )
    return mode == AppOpsManager.MODE_ALLOWED
  }

  private fun labelOf(packageName: String): String = try {
    val info = context.packageManager.getApplicationInfo(packageName, 0)
    context.packageManager.getApplicationLabel(info).toString()
  } catch (_: PackageManager.NameNotFoundException) {
    packageName
  }

  override fun definition() = ModuleDefinition {
    Name("UsageStats")

    AsyncFunction("hasPermission") { hasPermission() }

    AsyncFunction("openSettings") {
      val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    AsyncFunction("sinceLast") {
      if (!hasPermission()) {
        return@AsyncFunction mapOf<String, Any?>(
          "apps" to emptyList<Map<String, Any?>>(),
          "unlocks" to 0,
          "foregroundApp" to null,
        )
      }

      val now = System.currentTimeMillis()
      val manager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager

      // Per-app foreground time, as a delta against the previous poll. The first
      // poll has nothing to diff against, so it attributes nothing — a total
      // since boot would look like an hour of Instagram in the first window.
      val totals = mutableMapOf<String, Long>()
      for (entry in manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - DAY_MS, now)) {
        if (entry.totalTimeInForeground > 0) totals[entry.packageName] = entry.totalTimeInForeground
      }

      val apps = mutableListOf<Map<String, Any?>>()
      for ((packageName, total) in totals) {
        val previous = lastTotals[packageName] ?: total
        val seconds = (total - previous).coerceAtLeast(0) / 1000
        if (seconds >= 1) {
          apps.add(mapOf("app" to labelOf(packageName), "seconds" to seconds.toDouble()))
        }
      }
      lastTotals = totals

      var unlocks = 0
      var foreground: String? = null
      val from = if (lastPollAt == 0L) now - DAY_MS else lastPollAt
      val events = manager.queryEvents(from, now)
      val event = UsageEvents.Event()
      while (events.hasNextEvent()) {
        events.getNextEvent(event)
        when {
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && event.eventType == UsageEvents.Event.KEYGUARD_HIDDEN ->
            unlocks += 1
          isResumed(event) -> foreground = labelOf(event.packageName)
          else -> Unit
        }
      }
      lastPollAt = now

      mapOf<String, Any?>(
        "apps" to apps,
        "unlocks" to unlocks,
        "foregroundApp" to foreground,
      )
    }
  }

  private fun isResumed(event: UsageEvents.Event): Boolean = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> event.eventType == UsageEvents.Event.ACTIVITY_RESUMED
    else -> @Suppress("DEPRECATION") event.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND
  }

  private companion object {
    const val DAY_MS = 24L * 60L * 60L * 1000L
  }
}
