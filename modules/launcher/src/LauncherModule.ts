import { NativeModule, requireNativeModule } from "expo";

import type { InstalledApp } from "./LauncherModule.types";

type LauncherEvents = {
  onAppsChanged(payload: { removed: string[] }): void;
};

declare class LauncherModule extends NativeModule<LauncherEvents> {
  getInstalledApps(): Promise<InstalledApp[]>;
  isDefaultLauncher(): Promise<boolean>;
  launchApp(packageName: string): Promise<void>;
  openAppInfo(packageName: string): Promise<void>;
  requestHomeRole(): Promise<void>;
}

export default requireNativeModule<LauncherModule>("LauncherModule");

