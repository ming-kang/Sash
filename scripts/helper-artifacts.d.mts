interface HelperTarget {
  platform: string;
  arch: string;
}

interface HelperAsset extends HelperTarget {
  name: string;
  size: number;
  sha256: string;
}

export declare const helperPlatforms: string[];
export declare const helperArchitectures: string[];
export declare const helperFilenames: string[];
export declare function helperEntry(platform: string): string;
export declare function helperFilename(platform: string, arch: string): string;
export declare function pairedCoreFilename(platform: string, arch: string): string;
export declare function helperTargets(root: string): HelperTarget[];
export declare function helperAsset(
  dist: string,
  platform: string,
  arch: string,
): Promise<HelperAsset>;
export declare function helperAssets(root: string): Promise<HelperAsset[]>;
export declare function pairedCoreAsset(
  dist: string,
  platform: string,
  arch: string,
): Promise<HelperAsset>;
