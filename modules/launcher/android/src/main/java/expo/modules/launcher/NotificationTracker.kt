package expo.modules.launcher

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Active notification counts per package, kept in sync by
 * [LauncherNotificationService] and read by [LauncherModule].
 */
object NotificationTracker {
  private var counts: Map<String, Int> = emptyMap()

  var onChange: ((Map<String, Int>) -> Unit)? = null
    set(value) {
      field = value
      value?.invoke(counts)
    }

  fun update(next: Map<String, Int>) {
    if (next == counts) {
      return
    }
    counts = next
    onChange?.invoke(counts)
  }

  fun snapshot(): Map<String, Int> = counts
}

class LauncherNotificationService : NotificationListenerService() {
  override fun onListenerConnected() = refresh()

  override fun onListenerDisconnected() = NotificationTracker.update(emptyMap())

  override fun onNotificationPosted(notification: StatusBarNotification?) = refresh()

  override fun onNotificationRemoved(notification: StatusBarNotification?) = refresh()

  private fun refresh() {
    // The listener is bound before it is connected, and reading too early throws.
    val active = try {
      activeNotifications
    } catch (_: SecurityException) {
      return
    } ?: return

    val counts = mutableMapOf<String, Int>()

    for (notification in active) {
      val flags = notification.notification.flags
      // A group summary duplicates the children it stands for, and an ongoing
      // notification is a status rather than something waiting to be read.
      if (flags and Notification.FLAG_GROUP_SUMMARY != 0) {
        continue
      }
      if (flags and Notification.FLAG_ONGOING_EVENT != 0) {
        continue
      }
      counts[notification.packageName] = (counts[notification.packageName] ?: 0) + 1
    }

    NotificationTracker.update(counts)
  }
}
