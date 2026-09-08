import { NativeModule, requireNativeModule } from "expo";

import type { InstalledApp } from "./LauncherModule.types";

type LauncherEvents = {
  onNotificationsChanged(payload: { counts: Record<string, number> }): void;
};

declare class LauncherModule extends NativeModule<LauncherEvents> {
  getNotificationCounts(): Record<string, number>;
  hasNotificationAccess(): boolean;
  requestNotificationAccess(): Promise<void>;
  getInstalledApps(): Promise<InstalledApp[]>;
  isDefaultLauncher(): Promise<boolean>;
  launchApp(packageName: string): Promise<void>;
  openAppInfo(packageName: string): Promise<void>;
  requestHomeRole(): Promise<void>;
}

export default requireNativeModule<LauncherModule>("LauncherModule");

