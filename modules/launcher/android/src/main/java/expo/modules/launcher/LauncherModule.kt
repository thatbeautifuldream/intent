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
import android.os.UserHandle
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

    Events("onAppsChanged")

    // LauncherApps is the launcher-specific channel for install, update and
    // uninstall events, so the list stays accurate without polling.
    OnStartObserving {
      val context = appContext.reactContext ?: return@OnStartObserving
      val service =
        context.getSystemService(Context.LAUNCHER_APPS_SERVICE) as LauncherApps

      val changed = object : LauncherApps.Callback() {
        override fun onPackageAdded(packageName: String?, user: UserHandle?) =
          sendEvent("onAppsChanged", emptyMap<String, Any>())

        override fun onPackageRemoved(packageName: String?, user: UserHandle?) =
          sendEvent("onAppsChanged", emptyMap<String, Any>())

        override fun onPackageChanged(packageName: String?, user: UserHandle?) =
          sendEvent("onAppsChanged", emptyMap<String, Any>())

        override fun onPackagesAvailable(
          packageNames: Array<out String>?,
          user: UserHandle?,
          replacing: Boolean
        ) = sendEvent("onAppsChanged", emptyMap<String, Any>())

        override fun onPackagesUnavailable(
          packageNames: Array<out String>?,
          user: UserHandle?,
          replacing: Boolean
        ) = sendEvent("onAppsChanged", emptyMap<String, Any>())
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
      val packageManager = context.packageManager
      val launcherIntent = Intent(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_LAUNCHER)
      }
      val activities = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        packageManager.queryIntentActivities(
          launcherIntent,
          PackageManager.ResolveInfoFlags.of(0)
        )
      } else {
        @Suppress("DEPRECATION")
        packageManager.queryIntentActivities(launcherIntent, 0)
      }

      activities
        .filter { it.activityInfo.packageName != context.packageName }
        .distinctBy { it.activityInfo.packageName }
        .map { activity ->
          mapOf(
            "name" to activity.loadLabel(packageManager).toString(),
            "packageName" to activity.activityInfo.packageName
          )
        }
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

    AsyncFunction("openAppInfo") { packageName: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.fromParts("package", packageName, null)
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
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

  private companion object {
    const val HOME_ROLE_REQUEST_CODE = 100
  }
}
