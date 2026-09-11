package expo.modules.launcher

import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.LauncherApps
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.UserHandle
import android.os.UserManager
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

class LauncherModule : Module() {
  private var launcherApps: LauncherApps? = null
  private var callback: LauncherApps.Callback? = null

  override fun definition() = ModuleDefinition {
    Name("LauncherModule")

    Events("onAppsChanged", "onHomeIntent")

    // Pressing home while the launcher is already showing delivers a fresh home
    // intent. Every mainstream launcher treats that as "reset to a clean home",
    // so the UI is told to close what is open and return to the top.
    OnNewIntent { intent ->
      val isHome = intent.action == Intent.ACTION_MAIN &&
        intent.categories?.contains(Intent.CATEGORY_HOME) == true

      if (isHome) {
        sendEvent("onHomeIntent", emptyMap<String, Any>())
      }
    }

    // LauncherApps is the launcher-specific channel for install, update and
    // uninstall events, so the list stays accurate without polling.
    OnStartObserving {
      val context = appContext.reactContext ?: return@OnStartObserving
      val service =
        context.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps

      // Removals carry the package so the list can drop the row immediately;
      // anything else needs a re-query to pick up a label.
      val changed = object : LauncherApps.Callback() {
        override fun onPackageAdded(packageName: String?, user: UserHandle?) =
          sendEvent("onAppsChanged", mapOf("removed" to emptyList<String>()))

        override fun onPackageRemoved(packageName: String?, user: UserHandle?) =
          sendEvent("onAppsChanged", mapOf("removed" to listOfNotNull(packageName)))

        override fun onPackageChanged(packageName: String?, user: UserHandle?) =
          sendEvent("onAppsChanged", mapOf("removed" to emptyList<String>()))

        override fun onPackagesAvailable(
          packageNames: Array<out String>?,
          user: UserHandle?,
          replacing: Boolean
        ) = sendEvent("onAppsChanged", mapOf("removed" to emptyList<String>()))

        override fun onPackagesUnavailable(
          packageNames: Array<out String>?,
          user: UserHandle?,
          replacing: Boolean
        ) = sendEvent(
          "onAppsChanged",
          mapOf("removed" to (packageNames?.toList() ?: emptyList<String>()))
        )
      }

      service.registerCallback(changed, Handler(Looper.getMainLooper()))
      launcherApps = service
      callback = changed
    }

    OnStopObserving {
      callback?.let { launcherApps?.unregisterCallback(it) }
      callback = null
      launcherApps = null
    }

    AsyncFunction("getInstalledApps") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val service =
        context.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps
      val userManager = context.getSystemService(UserManager::class.java)

      // getActivityList is the launcher-facing enumeration: it covers the
      // current user plus any managed profile, and synthesises an entry for
      // apps that ship no launcher activity of their own. queryIntentActivities
      // only ever sees the current user, so work apps were invisible.
      val profiles = userManager?.userProfiles ?: listOf(Process.myUserHandle())

      profiles
        .flatMap { user ->
          service.getActivityList(null, user).map { activity -> activity to user }
        }
        .filter { (activity, _) ->
          activity.applicationInfo.packageName != context.packageName
        }
        .map { (activity, user) ->
          val serial = userManager?.getSerialNumberForUser(user)?.toDouble() ?: 0.0
          mapOf(
            // A package can exist in both the personal and work profile, so the
            // component and the user together are what identifies a row.
            "id" to "${activity.componentName.flattenToString()}#${serial.toLong()}",
            "name" to activity.label.toString(),
            "packageName" to activity.applicationInfo.packageName,
            "component" to activity.componentName.flattenToString(),
            "user" to serial
          )
        }
        .distinctBy { it["id"] as String }
        .sortedBy { (it["name"] as String).lowercase(Locale.getDefault()) }
    }

    AsyncFunction("isDefaultLauncher") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()

      // The role system is the authority on which app holds home. Resolving the
      // home intent and comparing packages reports the caller rather than the
      // current default, so it answers true even when another launcher is set.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val roleManager = context.getSystemService(RoleManager::class.java)
        if (roleManager != null && roleManager.isRoleAvailable(RoleManager.ROLE_HOME)) {
          return@AsyncFunction roleManager.isRoleHeld(RoleManager.ROLE_HOME)
        }
      }

      val homeIntent = Intent(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_HOME)
      }
      val resolved = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.resolveActivity(
          homeIntent,
          PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong())
        )
      } else {
        @Suppress("DEPRECATION")
        context.packageManager.resolveActivity(homeIntent, PackageManager.MATCH_DEFAULT_ONLY)
      }
      resolved?.activityInfo?.packageName == context.packageName
    }

    AsyncFunction("launchApp") { component: String, user: Double ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val target = ComponentName.unflattenFromString(component)
        ?: throw CodedException("Malformed component $component")
      val service =
        context.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps

      // startMainActivity launches into the owning profile, which a plain
      // startActivity cannot do for a work app.
      service.startMainActivity(target, userFor(context, user), null, null)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("openAppInfo") { component: String, user: Double ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val target = ComponentName.unflattenFromString(component)
        ?: throw CodedException("Malformed component $component")
      val service =
        context.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps

      service.startAppDetailsActivity(target, userFor(context, user), null, null)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("requestHomeRole") {
      val activity = appContext.throwingActivity
      val roleManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        activity.getSystemService(RoleManager::class.java)
      } else {
        null
      }
      val canRequestRole =
        roleManager != null &&
          roleManager.isRoleAvailable(RoleManager.ROLE_HOME) &&
          !roleManager.isRoleHeld(RoleManager.ROLE_HOME)

      if (canRequestRole) {
        @Suppress("DEPRECATION")
        activity.startActivityForResult(
          roleManager!!.createRequestRoleIntent(RoleManager.ROLE_HOME),
          HOME_ROLE_REQUEST_CODE
        )
      } else {
        // No role dialog available, so hand the user the system picker instead
        // rather than leaving the button doing nothing.
        activity.startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun userFor(context: Context, serial: Double): UserHandle {
    val userManager = context.getSystemService(UserManager::class.java)
    return userManager?.getUserForSerialNumber(serial.toLong()) ?: Process.myUserHandle()
  }

  private companion object {
    const val HOME_ROLE_REQUEST_CODE = 100
  }
}
