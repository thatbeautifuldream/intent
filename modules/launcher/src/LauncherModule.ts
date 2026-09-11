import { NativeModule, requireNativeModule } from "expo";

import type { InstalledApp } from "./LauncherModule.types";

type LauncherEvents = {
  onAppsChanged(payload: { removed: string[] }): void;
  onHomeIntent(): void;
};

declare class LauncherModule extends NativeModule<LauncherEvents> {
  getInstalledApps(): Promise<InstalledApp[]>;
  isDefaultLauncher(): Promise<boolean>;
  launchApp(component: string, user: number): Promise<void>;
  openAppInfo(component: string, user: number): Promise<void>;
  requestHomeRole(): Promise<void>;
}

export default requireNativeModule<LauncherModule>("LauncherModule");

