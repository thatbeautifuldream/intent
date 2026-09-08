package expo.modules.launcher

import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.os.Build
import android.provider.Settings
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.util.Locale

class LauncherModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LauncherModule")

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
            "packageName" to activity.activityInfo.packageName,
            "icon" to activity.loadIcon(packageManager).toDataUri()
          )
        }
        .sortedBy { (it["name"] as String).lowercase(Locale.getDefault()) }
    }

    AsyncFunction("isDefaultLauncher") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
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

    AsyncFunction("launchApp") { packageName: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = context.packageManager.getLaunchIntentForPackage(packageName)
        ?: throw CodedException("No launchable activity found for $packageName")
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("requestHomeRole") {
      val activity = appContext.throwingActivity
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val roleManager = activity.getSystemService(RoleManager::class.java)
        if (
          roleManager.isRoleAvailable(RoleManager.ROLE_HOME) &&
          !roleManager.isRoleHeld(RoleManager.ROLE_HOME)
        ) {
          @Suppress("DEPRECATION")
          activity.startActivityForResult(
            roleManager.createRequestRoleIntent(RoleManager.ROLE_HOME),
            HOME_ROLE_REQUEST_CODE
          )
        }
      } else {
        activity.startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun Drawable.toDataUri(): String {
    val width = intrinsicWidth.takeIf { it > 0 } ?: ICON_SIZE
    val height = intrinsicHeight.takeIf { it > 0 } ?: ICON_SIZE
    val scale = minOf(ICON_SIZE.toFloat() / width, ICON_SIZE.toFloat() / height, 1f)
    val bitmapWidth = maxOf(1, (width * scale).toInt())
    val bitmapHeight = maxOf(1, (height * scale).toInt())
    val bitmap = Bitmap.createBitmap(bitmapWidth, bitmapHeight, Bitmap.Config.ARGB_8888)
    setBounds(0, 0, bitmapWidth, bitmapHeight)
    draw(Canvas(bitmap))

    return ByteArrayOutputStream().use { output ->
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
      bitmap.recycle()
      "data:image/png;base64,${Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)}"
    }
  }

  private companion object {
    const val ICON_SIZE = 96
    const val HOME_ROLE_REQUEST_CODE = 100
  }
}
