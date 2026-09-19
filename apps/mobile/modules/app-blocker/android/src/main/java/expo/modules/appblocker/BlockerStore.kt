package expo.modules.appblocker

import android.content.Context
import android.content.pm.PackageManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the service reads and the app writes, in one SharedPreferences file: the blocklist, the
 * goal's words, the undo exemptions, and the events the app has not yet sent to the server.
 * The service can run while the React app is not, so nothing here lives in memory only.
 */
internal class BlockerStore(private val context: Context) {
  private val prefs = context.getSharedPreferences("lumi.blocker", Context.MODE_PRIVATE)

  fun setBlocklist(apps: List<String>, goal: String?, active: Boolean) {
    prefs.edit()
      .putString("apps", JSONArray(apps.map { it.trim().lowercase() }).toString())
      .putString("goal", goal)
      .putBoolean("active", active)
      .apply()
  }

  val active: Boolean get() = prefs.getBoolean("active", false)
  val goal: String? get() = prefs.getString("goal", null)

  private fun apps(): Set<String> {
    val raw = JSONArray(prefs.getString("apps", "[]"))
    return (0 until raw.length()).map { raw.getString(it) }.toSet()
  }

  fun labelOf(packageName: String): String = try {
    val pm = context.packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
  } catch (_: PackageManager.NameNotFoundException) {
    packageName
  }

  /** The goal lists apps by name ("Instagram"); a package name is accepted too. */
  fun isBlocked(packageName: String): Boolean {
    val listed = apps()
    return listed.contains(labelOf(packageName).lowercase()) || listed.contains(packageName.lowercase())
  }

  fun exempt(packageName: String, untilMs: Long) {
    prefs.edit().putLong("exempt:$packageName", untilMs).apply()
  }

  fun isExempt(packageName: String, nowMs: Long): Boolean =
    prefs.getLong("exempt:$packageName", 0L) > nowMs

  @Synchronized
  fun record(action: String, packageName: String) {
    val events = JSONArray(prefs.getString("events", "[]"))
    events.put(
      JSONObject()
        .put("action", action)
        .put("app", labelOf(packageName))
        .put("ts", System.currentTimeMillis()),
    )
    // A phone that never reaches the server keeps the last hundred, not everything.
    val trimmed = JSONArray()
    val from = maxOf(0, events.length() - 100)
    for (i in from until events.length()) trimmed.put(events.get(i))
    prefs.edit().putString("events", trimmed.toString()).apply()
  }

  @Synchronized
  fun drain(): List<Map<String, Any>> {
    val events = JSONArray(prefs.getString("events", "[]"))
    prefs.edit().putString("events", "[]").apply()
    return (0 until events.length()).map {
      val e = events.getJSONObject(it)
      mapOf("action" to e.getString("action"), "app" to e.getString("app"), "ts" to e.getLong("ts"))
    }
  }
}
