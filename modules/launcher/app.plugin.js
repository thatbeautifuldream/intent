const {
  AndroidConfig,
  withAndroidManifest,
  withAndroidStyles,
} = require("expo/config-plugins");

module.exports = function withLauncher(config) {
  return withOpaqueWindow(withHomeIntent(config));
};

// A launcher window that is not opaque lets the system wallpaper show through
// while the home gesture animates. Both the splash drawable and the wallpaper
// flag have to go for the transition to stay black.
function withOpaqueWindow(config) {
  return withAndroidStyles(config, (config) => {
    for (const style of config.modResults.resources.style ?? []) {
      if (style.$.name !== "AppTheme" && style.$.name !== "Theme.App.SplashScreen") {
        continue;
      }

      style.item = (style.item ?? []).filter(
        (item) =>
          item.$.name !== "android:windowBackground" &&
          item.$.name !== "android:windowShowWallpaper",
      );
      style.item.push(
        { $: { name: "android:windowBackground" }, _: "@color/activityBackground" },
        { $: { name: "android:windowShowWallpaper" }, _: "false" },
      );
    }

    return config;
  });
}

function withHomeIntent(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(
      config.modResults,
    );
    const intentFilters = mainActivity["intent-filter"] ?? [];

    if (!intentFilters.some(isHomeIntentFilter)) {
      intentFilters.push({
        action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
        category: [
          { $: { "android:name": "android.intent.category.HOME" } },
          { $: { "android:name": "android.intent.category.DEFAULT" } },
        ],
      });
    }

    mainActivity["intent-filter"] = intentFilters;
    // Keeping the launcher task alive avoids a recreate — and its blank frame —
    // every time the user swipes home.
    mainActivity.$["android:stateNotNeeded"] = "true";
    mainActivity.$["android:excludeFromRecents"] = "true";
    const queries = manifest.queries?.[0] ?? {};
    queries.intent = queries.intent ?? [];

    if (!queries.intent.some(isLauncherQuery)) {
      queries.intent.push({
        action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
        category: [
          { $: { "android:name": "android.intent.category.LAUNCHER" } },
        ],
      });
    }

    manifest.queries = [queries];

    return config;
  });
};

function isHomeIntentFilter(intentFilter) {
  return intentFilter.category?.some(
    (category) => category.$?.["android:name"] === "android.intent.category.HOME",
  );
}

function isLauncherQuery(intent) {
  return intent.category?.some(
    (category) =>
      category.$?.["android:name"] === "android.intent.category.LAUNCHER",
  );
}
