export declare const PERSISTENT_ROOT_BASE: string;
export declare function isTempPath(candidate: unknown): boolean;
export declare function persistentRootDefault(options: { uid?: number | null; repoRoot: string; id?: string }): string;
export declare function rebootGuards(options: {
  rootDir: string;
  reportPath: string;
  reportExplicit: boolean;
  uid: number | null;
  systemctlOk: boolean;
}): string[];
export declare function isInside(dir: string, inner: string): boolean;
