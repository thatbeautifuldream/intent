export type InstalledApp = {
  /** Component plus user serial: a package can exist in two profiles. */
  id: string;
  name: string;
  packageName: string;
  component: string;
  user: number;
};
