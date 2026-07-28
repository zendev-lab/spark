/**
 * Public daemon-local RPC contract entrypoint.
 *
 * The exhaustive procedure metadata and DTO schemas stay in a private leaf so
 * this entrypoint remains a stable, dependency-light composition boundary.
 */
export * from "./_local-rpc-catalog.ts";
