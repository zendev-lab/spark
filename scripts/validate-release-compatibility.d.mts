export function compareStableVersions(left: string, right: string): number;
export function validateCompatibilitySemantics<T extends Record<string, any>>(contract: T): T;
export function loadAndValidateReleaseCompatibility(base?: string): Promise<Record<string, any>>;
