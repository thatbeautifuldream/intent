# Android Launcher

Minimal Android launcher experiment built with Expo SDK 57, React Native, and TypeScript.

## Run on a physical device

Install JDK 21, enable USB debugging, connect the device, and verify that `adb devices` lists it.

```sh
pnpm install
pnpm android --device
```

The Android command creates and installs a development build containing the local Kotlin module. Start Metro for later sessions with:

```sh
pnpm start
```

In the app, select **Set as home app** and approve **Android Launcher**. Press the device Home button to return to the React Native screen. Select any listed app to launch it.

Native launcher behavior is contained in `modules/launcher`. Changes to Kotlin or the config plugin require rebuilding the Android app.
