export interface NativeNpmDistribution {
  id: string;
  target: string;
  suffix: string;
  os: string;
  cpu: string;
  packageName: string;
  aliasPackageName: string;
  version: string;
  directory: string;
  assetName: string;
  manifestName: string;
}

export interface NpmDistribution {
  id: string;
  packageName: string;
  description: string;
  directory: string;
  assetName: string;
  manifestName: string;
  bins: Record<string, string>;
  bundles: Record<string, string>;
  copyModules?: Record<string, string>;
  files: string[];
  exactDependencies: string[];
  dsh?: Record<string, unknown>;
  exports: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  migrationSource?: string;
}

export const releaseVersion: string;
export const npmTag: "latest" | "next";
export const productsDirectory: string;
export const releaseDirectory: string;
export const nativeNpmDistributions: NativeNpmDistribution[];
export const nativeOptionalDependencies: Record<string, string>;
export const npmDistributions: NpmDistribution[];
export const npmDistributionById: Map<string, NpmDistribution>;
export const publicPackageNames: Set<string>;
