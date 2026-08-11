import { fileURLToPath } from "node:url";

import { compile } from "@inlang/paraglide-js";

const packageRoot = new URL("../", import.meta.url);

await compile({
  project: fileURLToPath(new URL("project.inlang", packageRoot)),
  outdir: fileURLToPath(new URL("src/paraglide", packageRoot)),
  strategy: ["baseLocale"],
  emitTsDeclarations: true,
  emitGitIgnore: false,
  emitPrettierIgnore: false,
  emitReadme: true,
  includeEslintDisableComment: false,
  cleanOutdir: true,
});
