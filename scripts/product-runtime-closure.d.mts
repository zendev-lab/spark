export function discoverProductRuntimePackages(productDirectory: string): Promise<string[]>;

export function resolveProductRuntimeDependencies(
  root: string,
  productDirectory: string,
  exactWorkspacePackages?: string[],
): Promise<Record<string, string>>;
