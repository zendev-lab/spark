// Starlight 0.42 ships these virtual modules without ambient declarations.
// Remove this file when upstream exports their types again.
declare module "virtual:starlight/user-config" {
  const config: import("@astrojs/starlight/types").StarlightConfig;
  export default config;
}

declare module "virtual:starlight/project-context" {
  const context: Pick<import("astro").AstroConfig, "trailingSlash">;
  export default context;
}
