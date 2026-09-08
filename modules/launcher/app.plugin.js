const {
  AndroidConfig,
  withAndroidManifest,
  withAndroidStyles,
  withMainActivity,
} = require("expo/config-plugins");

const INERT_BACK_MARKER = "// launcher: back is inert";

module.exports = function withLauncher(config) {
  return withInertBack(withOpaqueWindow(withHomeIntent(config)));
};

// The launcher owns the root of the home task, so letting back finish the
// activity destroys the task and the system relaunches the launcher from
// scratch. This has to be onBackPressed rather than React Native's
// invokeDefaultOnBackPressed: before there is a React context — the whole cold
// start — ReactActivity falls straight through to Activity.onBackPressed, so
// the React Native hook is never reached.
function withInertBack(config) {
  return withMainActivity(config, (config) => {
    if (config.modResults.language !== "kt") {
      return config;
    }

    const contents = config.modResults.contents;
    if (contents.includes(INERT_BACK_MARKER)) {
      return config;
    }

    const override = [
      `  ${INERT_BACK_MARKER}`,
      '  @Suppress("DEPRECATION")',
      "  override fun onBackPressed() = Unit",
    ].join("\n");

    const signature = "override fun invokeDefaultOnBackPressed()";
    const start = contents.indexOf(signature);

    if (start === -1) {
      // Nothing to replace, so add the override to the end of the class body.
      const classEnd = contents.lastIndexOf("}");
      config.modResults.contents = `${contents.slice(0, classEnd)}\n${override}\n${contents.slice(classEnd)}`;
      return config;
    }

    // Replace the template's implementation by matching braces, so the patch
    // does not depend on the exact body Expo generates.
    const open = contents.indexOf("{", start);
    let depth = 0;
    let close = -1;

    for (let i = open; i < contents.length; i++) {
      if (contents[i] === "{") {
        depth += 1;
      } else if (contents[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }

    if (close === -1) {
      return config;
    }

    // The template's doc comment describes the behaviour being replaced.
    const docStart = contents.lastIndexOf("/**", start);
    const docEnd = contents.indexOf("*/", docStart);
    const replaceFrom =
      docStart !== -1 && !contents.slice(docEnd + 2, start).trim()
        ? docStart
        : start;

    config.modResults.contents =
      contents.slice(0, replaceFrom) +
      override.trimStart() +
      contents.slice(close + 1);

    if (!config.modResults.contents.includes("Build.VERSION")) {
      config.modResults.contents = config.modResults.contents.replace(
        "import android.os.Build\n",
        "",
      );
    }

    return config;
  });
}

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
