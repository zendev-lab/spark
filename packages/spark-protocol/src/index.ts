// Root barrel remains for compatibility. New production imports should use the
// domain/daemon/runtime/interaction/presentation subpaths.
export * from "./domain.ts";
export * from "./daemon.ts";
export * from "./runtime.ts";
export * from "./interaction.ts";
export * from "./presentation.ts";

// protocol.ts still owns composite view-model schemas that aggregate domains.
export * from "./protocol.ts";
