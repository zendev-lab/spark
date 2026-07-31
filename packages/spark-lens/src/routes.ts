import type { LensCapability, ProviderId } from "./types.ts";

export type NonEmptyProviders = readonly [ProviderId, ...ProviderId[]];

export type CapabilityRoute =
  | {
      kind: "exclusive";
      capability: LensCapability;
      owner: ProviderId;
    }
  | {
      kind: "fallback";
      capability: LensCapability;
      owner: ProviderId;
      fallbacks: NonEmptyProviders;
    }
  | {
      kind: "merge";
      capability: LensCapability;
      contributors: NonEmptyProviders;
    }
  | {
      kind: "verify";
      capability: LensCapability;
      owner: ProviderId;
      verifiers: NonEmptyProviders;
    };

function assertDistinct(providers: readonly ProviderId[], field: string): void {
  if (new Set(providers).size !== providers.length) {
    throw new TypeError(`${field} must contain distinct providers`);
  }
}

function assertOwnerExcluded(
  owner: ProviderId,
  providers: readonly ProviderId[],
  field: string,
): void {
  if (providers.includes(owner)) {
    throw new TypeError(`${field} must not contain the owner`);
  }
}

export const capabilityRoute = {
  exclusive(capability: LensCapability, owner: ProviderId): CapabilityRoute {
    return { kind: "exclusive", capability, owner };
  },
  fallback(
    capability: LensCapability,
    owner: ProviderId,
    fallbacks: NonEmptyProviders,
  ): CapabilityRoute {
    assertDistinct(fallbacks, "fallbacks");
    assertOwnerExcluded(owner, fallbacks, "fallbacks");
    return { kind: "fallback", capability, owner, fallbacks };
  },
  merge(capability: LensCapability, contributors: NonEmptyProviders): CapabilityRoute {
    assertDistinct(contributors, "contributors");
    return { kind: "merge", capability, contributors };
  },
  verify(
    capability: LensCapability,
    owner: ProviderId,
    verifiers: NonEmptyProviders,
  ): CapabilityRoute {
    assertDistinct(verifiers, "verifiers");
    assertOwnerExcluded(owner, verifiers, "verifiers");
    return { kind: "verify", capability, owner, verifiers };
  },
} as const;

export function providersForRoute(route: CapabilityRoute): NonEmptyProviders {
  switch (route.kind) {
    case "exclusive":
      return [route.owner];
    case "fallback":
      return [route.owner, ...route.fallbacks];
    case "merge":
      return route.contributors;
    case "verify":
      return [route.owner, ...route.verifiers];
  }
}

export function digestibleRoute(route: CapabilityRoute): unknown {
  switch (route.kind) {
    case "exclusive":
      return { kind: route.kind, capability: route.capability, owner: route.owner };
    case "fallback":
      return {
        kind: route.kind,
        capability: route.capability,
        owner: route.owner,
        fallbacks: [...route.fallbacks],
      };
    case "merge":
      return {
        kind: route.kind,
        capability: route.capability,
        contributors: [...route.contributors],
      };
    case "verify":
      return {
        kind: route.kind,
        capability: route.capability,
        owner: route.owner,
        verifiers: [...route.verifiers],
      };
  }
}
