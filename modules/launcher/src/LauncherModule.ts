import { NativeModule, requireNativeModule } from "expo";

import type { InstalledApp } from "./LauncherModule.types";

declare class LauncherModule extends NativeModule {
  getInstalledApps(): Promise<InstalledApp[]>;
  isDefaultLauncher(): Promise<boolean>;
  launchApp(packageName: string): Promise<void>;
  requestHomeRole(): Promise<void>;
}

export default requireNativeModule<LauncherModule>("LauncherModule");

