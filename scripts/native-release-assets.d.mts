export interface NativeReleaseTarget {
  target: string;
  asset: string;
  size: number;
  sha256: string;
}

export interface NativeReleaseManifest {
  schemaVersion: 1;
  version: string;
  gitSha: string;
  targets: NativeReleaseTarget[];
  installer: {
    asset: "install.sh";
    size: number;
    sha256: string;
  };
}

export interface NativeReleaseDistribution {
  target: string;
}

export interface NativeReleaseAssetOptions {
  version?: string;
  gitSha?: string;
  outputDirectory?: string;
  nativeBinaryRoot?: string;
  distributions?: NativeReleaseDistribution[];
  releaseBaseUrl?: string;
  requireHttps?: boolean;
}

export function buildNativeReleaseAssets(
  options?: NativeReleaseAssetOptions,
): Promise<NativeReleaseManifest>;

export function renderInstallScript(options: {
  version: string;
  releaseBaseUrl: string;
  targets: NativeReleaseTarget[];
  requireHttps?: boolean;
}): string;
