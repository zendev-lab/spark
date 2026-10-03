const {
  TEST_SOURCE_PATTERN,
  generateLayerRules,
  loadArchitectureInventory,
  resolvedPackagePattern,
} = require("./architecture/dependency-governance.cjs");

const architectureInventory = loadArchitectureInventory(__dirname);

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    ...generateLayerRules(architectureInventory),
    // --- Pi SDK boundaries are owned by architecture/packages.json ---
    {
      name: "no-direct-pi-ai",
      comment: "Direct pi-ai imports are limited to the inventory-declared owner.",
      severity: "error",
      from: {
        pathNot: piSdkAllowedSourcePattern("@earendil-works/pi-ai"),
      },
      to: {
        path: "node_modules/.*/@earendil-works/pi-ai|/node_modules/@earendil-works/pi-ai|^@earendil-works/pi-ai",
      },
    },
    {
      name: "no-direct-pi-tui",
      comment: "pi-tui was retired with spark-tui-adapter; no package may import it.",
      severity: "error",
      from: {},
      to: {
        path: "node_modules/.*/@earendil-works/pi-tui|/node_modules/@earendil-works/pi-tui|^@earendil-works/pi-tui",
      },
    },
    {
      name: "no-direct-cordis",
      comment:
        "Cordis is the composition root for dsh-llm, daemon store services, and the daemon agent-loop driver.",
      severity: "error",
      from: {
        pathNot: "^(packages/spark-llm-providers/|packages/spark-session/|apps/spark-daemon/)",
      },
      to: {
        path: "node_modules/.*/@deepseek-ai/cordis(?:/|$)|/node_modules/@deepseek-ai/cordis(?:/|$)|^@deepseek-ai/cordis(?:/|$)",
      },
    },
    {
      name: "no-direct-dsh-llm",
      comment: "dsh-llm is limited to the daemon composition root and the provider adapter family.",
      severity: "error",
      from: {
        pathNot: "^(apps/spark-daemon/|packages/spark-llm-providers/)",
      },
      to: {
        path: "node_modules/.*/@deepseek-ai/dsh-llm(?:/|$)|/node_modules/@deepseek-ai/dsh-llm(?:/|$)|^@deepseek-ai/dsh-llm(?:/|$)",
      },
    },
    {
      name: "no-direct-dsh-session",
      comment:
        "dsh-session and dsh-session-persistence are limited to the daemon composition root and the Session owner.",
      severity: "error",
      from: {
        pathNot: "^(apps/spark-daemon/|packages/spark-session/)",
      },
      to: {
        path: "node_modules/.*/@deepseek-ai/dsh-session(?:-persistence)?(?:/|$)|/node_modules/@deepseek-ai/dsh-session(?:-persistence)?(?:/|$)|^@deepseek-ai/dsh-session(?:-persistence)?(?:/|$)",
      },
    },

    // --- deep-link: @zendev-lab/*/src/* specifier (bypass package exports) ---
    {
      name: "no-workspace-package-src-specifier",
      comment:
        "Do not import @zendev-lab/*/src/* — consume packages through declared package exports.",
      severity: "error",
      from: {},
      to: {
        path: "@zendev-lab/[^/]+/src(/|$)",
      },
    },
    {
      name: "no-production-legacy-daemon-local-rpc",
      comment:
        "Production callers must use the protocol-aware daemon client facade instead of the legacy local-rpc transport.",
      severity: "error",
      from: {
        pathNot:
          "(?:^test/|/(?:__fixtures__|__tests__|fixtures|test|tests)/|\\.(?:fixture|spec|test)\\.[^/]+$|^packages/spark-daemon-client/src/(?:index|daemon-client|daemon-local-rpc)\\.ts$)",
      },
      to: {
        path:
          "node_modules/.*/@zendev-lab/spark-daemon-client/local-rpc|" +
          "/node_modules/@zendev-lab/spark-daemon-client/local-rpc|" +
          "^@zendev-lab/spark-daemon-client/local-rpc$|" +
          "^packages/spark-daemon-client/src/daemon-local-rpc\\.",
      },
    },

    // --- deep-link: relative packages/*/src from apps and root tests ---
    {
      name: "no-app-relative-packages-src-deep-link",
      comment:
        "Apps and root tests must consume workspace packages through declared package exports.",
      severity: "error",
      from: {
        path: "^(apps|test)/",
      },
      to: {
        path: "(^|/)packages/[^/]+/src(/|$)",
        dependencyTypes: ["local"],
      },
    },
    // --- deep-link: relative packages/*/src across different packages ---
    {
      name: "no-cross-package-relative-src-deep-link",
      comment: "Do not reach into another package's src via relative paths. Use package exports.",
      severity: "error",
      from: {
        path: "^packages/([^/]+)/",
      },
      to: {
        path: "^packages/(?!$1/)[^/]+/src/",
        dependencyTypes: ["local"],
      },
    },
    {
      name: "spark-i18n-hub-surface-private",
      comment:
        "The @zendev-lab/spark-i18n/hub compatibility catalog is owned exclusively by the Hub app.",
      severity: "error",
      from: {
        pathNot: "^(apps/spark-hub/|packages/spark-i18n/src/hub/)",
      },
      to: {
        path:
          "^packages/spark-i18n/src/hub/|" +
          "node_modules/.*/@zendev-lab/spark-i18n/hub(?:/|$)|" +
          "/node_modules/@zendev-lab/spark-i18n/hub(?:/|$)|" +
          "^@zendev-lab/spark-i18n/hub(?:/|$)",
      },
    },
    {
      name: "spark-ui-owns-presentation-dependencies",
      comment:
        "Presentation dependencies must stay behind @zendev-lab/spark-ui instead of leaking into apps or other packages.",
      severity: "error",
      from: {
        pathNot: "^packages/spark-ui/",
      },
      to: {
        path: [
          "node_modules/.*/@lucide/svelte(?:/|$)",
          "/node_modules/@lucide/svelte(?:/|$)",
          "^@lucide/svelte(?:/|$)",
          "node_modules/.*/(?:bits-ui|svelte-streamdown)(?:/|$)",
          "/node_modules/(?:bits-ui|svelte-streamdown)(?:/|$)",
          "^(?:bits-ui|svelte-streamdown)(?:/|$)",
        ].join("|"),
      },
    },

    // --- retained pi-* kernel adapter packages ---
    {
      name: "pi-no-product-adapters",
      comment: "pi-* packages must not depend on Spark product adapter packages.",
      severity: "error",
      from: {
        path: "^packages/pi-",
      },
      to: {
        path: productAdapterResolvedPathPattern(),
      },
    },
    {
      name: "pi-only-foundation-spark",
      comment:
        "pi-* packages may depend only on renamed Spark foundation packages, not Spark product packages.",
      severity: "error",
      from: {
        path: "^packages/pi-",
      },
      to: {
        path: sparkOutsidePiFoundationResolvedPathPattern(),
      },
    },

    // --- Spark shared packages (exclude Hub-private spark-hub-* packages) ---
    {
      name: "spark-repro-no-host-or-product",
      comment:
        "spark-repro owns host-neutral state and policy only. Hosts compose optional Fusion; " +
        "spark-repro must not import it, host/workflow runtimes, product composition code, or apps.",
      severity: "error",
      from: {
        path: "^packages/spark-repro/",
      },
      to: {
        path: [
          "^apps/",
          "^packages/pi-",
          "^packages/(?:dsh-tool-fusion|spark-(?:llm-providers|task-runtime|workflows))(?:/|$)",
          "node_modules/.*/@zendev-lab/pi-",
          "/node_modules/@zendev-lab/pi-",
          "^@zendev-lab/pi-",
          "node_modules/.*/@zendev-lab/(?:dsh-tool-fusion|spark-(?:cli|hub|daemon|llm-providers|task-runtime|workflows))(?:/|$)",
          "/node_modules/@zendev-lab/(?:dsh-tool-fusion|spark-(?:cli|hub|daemon|llm-providers|task-runtime|workflows))(?:/|$)",
          "^@zendev-lab/(?:dsh-tool-fusion|spark-(?:cli|hub|daemon|llm-providers|task-runtime|workflows))(?:/|$)",
          "node_modules/.*/@earendil-works/pi-",
          "/node_modules/@earendil-works/pi-",
          "^@earendil-works/pi-",
        ].join("|"),
      },
    },
    {
      name: "production-no-circular",
      comment: "Production application and package modules must remain acyclic.",
      severity: "error",
      from: {
        path: "^(apps|packages)/",
      },
      to: {
        circular: true,
      },
    },
    {
      name: "spark-shared-no-product-adapters",
      comment:
        "Spark shared packages must not depend on product coordination or app adapter packages.",
      severity: "error",
      from: {
        // Hub-private packages are excluded from shared-package restrictions.
        path: "^packages/spark-(?!hub-)",
      },
      to: {
        path: productAdapterResolvedPathPattern(),
      },
    },
    {
      name: "spark-shared-no-app-internals",
      comment: "Spark shared packages must not import Spark app host internals.",
      severity: "error",
      from: {
        path: "^packages/spark-(?!hub-)",
      },
      to: {
        path: sparkAppInternalResolvedPathPattern(),
      },
    },

    // --- foundation contract packages (protocol + invocation) ---
    {
      name: "foundation-contract-no-product-or-app",
      comment:
        "foundation contract packages must not depend on product coordination or app adapters.",
      severity: "error",
      from: {
        path: "^packages/spark-(protocol|invocation)/",
      },
      to: {
        path: `(${productAdapterResolvedPathPattern()})|(${sparkAppInternalResolvedPathPattern()})`,
      },
    },

    // --- daemon-app ---
    {
      name: "execution-worker-import-boundary",
      comment:
        "Daemon-private execution worker modules may import only their wire contract, daemon agent runtime, Invocation, and protocol boundaries.",
      severity: "error",
      from: {
        path: "^apps/spark-daemon/src/execution/(?:contract[.]ts|worker-entry[.]ts|worker/)",
      },
      to: {
        pathNot: [
          "^apps/spark-daemon/src/execution/(?:contract[.]ts|worker/)",
          "^apps/spark-daemon/src/product/host/",
          "^packages/spark-(?:invocation|protocol)/",
        ].join("|"),
      },
    },

    // --- Hub app and Hub-private packages ---
    {
      name: "hub-no-app-internals",
      comment: "Hub packages must not import Spark CLI host internals.",
      severity: "error",
      from: {
        path: "^(apps/spark-hub/|packages/spark-hub-)",
      },
      to: {
        path: sparkClientAppInternalResolvedPathPattern(),
      },
    },
    {
      name: "client-surfaces-no-daemon-internals",
      comment: "Hub and native Web must use daemon client APIs, not daemon product internals.",
      severity: "error",
      from: {
        path: "^(apps/spark-(?:hub|web)/|packages/spark-hub-)",
        pathNot: TEST_SOURCE_PATTERN,
      },
      to: {
        path: sparkDaemonInternalResolvedPathPattern(),
      },
    },
  ],
  options: {
    doNotFollow: {
      path: ["node_modules", "build", "dist", "\\.svelte-kit", "reports", "coverage"],
    },
    exclude: {
      path: [
        "node_modules",
        "build",
        "dist",
        "\\.svelte-kit",
        "reports",
        "coverage",
        "\\.git",
        // package-internal relative imports into own src are fine; deep-link rule
        // already scopes local deps. Keep generated / lock noise out.
      ],
    },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    // Dynamic import() detection stays on (default). Do not disable via
    // detective options or skipAnalysis.
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};

/** Resolved paths / module names for product adapter packages. */
function productAdapterResolvedPathPattern() {
  return [
    "node_modules/.*/@zendev-lab/spark-hub(?:/|$)",
    "/node_modules/@zendev-lab/spark-hub(?:/|$)",
    "^apps/spark-hub/",
    "node_modules/.*/@zendev-lab/spark-daemon(?:/|$)",
    "/node_modules/@zendev-lab/spark-daemon(?:/|$)",
    "^apps/spark-daemon/",
    "node_modules/.*/@zendev-lab/spark-hub-coordination(?:/|$)",
    "/node_modules/@zendev-lab/spark-hub-coordination(?:/|$)",
    "^packages/spark-hub-coordination/",
    "node_modules/.*/@zendev-lab/spark-hub-[^/]+",
    "/node_modules/@zendev-lab/spark-hub-[^/]+",
    "^packages/spark-hub-",
  ].join("|");
}

function piAllowedSparkFoundationDirs() {
  return [
    "spark-artifacts",
    "spark-invocation",
    "spark-driver",
    "spark-roles",
    "spark-task-runtime",
    "spark-tasks",
    "spark-workflows",
    "spark-text-rendering",
  ];
}

function sparkOutsidePiFoundationResolvedPathPattern() {
  const allowed = piAllowedSparkFoundationDirs().join("|");
  return [
    `node_modules/.*/@zendev-lab/spark-(?!${allowed})(?:$|/)`,
    `/node_modules/@zendev-lab/spark-(?!${allowed})(?:$|/)`,
    `^packages/spark-(?!${allowed})(?:/|$)`,
  ].join("|");
}

function sparkAppInternalResolvedPathPattern() {
  return [
    sparkDaemonInternalResolvedPathPattern(),
    "node_modules/.*/@zendev-lab/spark-cli(?:/|$)",
    "/node_modules/@zendev-lab/spark-cli(?:/|$)",
    "node_modules/.*/@zendev-lab/spark-web(?:/|$)",
    "/node_modules/@zendev-lab/spark-web(?:/|$)",
    "^apps/spark-daemon/",
    "^apps/spark-web/",
    "^apps/spark-cli/",
  ].join("|");
}

function sparkDaemonInternalResolvedPathPattern() {
  return [
    "node_modules/.*/@zendev-lab/spark-daemon(?:/|$)",
    "/node_modules/@zendev-lab/spark-daemon(?:/|$)",
    "^@zendev-lab/spark-daemon(?:/|$)",
    "^apps/spark-daemon/",
  ].join("|");
}

function sparkClientAppInternalResolvedPathPattern() {
  return [
    "node_modules/.*/@zendev-lab/spark-cli(?:/|$)",
    "/node_modules/@zendev-lab/spark-cli(?:/|$)",
    "node_modules/.*/@zendev-lab/spark-web(?:/|$)",
    "/node_modules/@zendev-lab/spark-web(?:/|$)",
    "^apps/spark-web/",
    "^apps/spark-cli/",
  ].join("|");
}

function piSdkAllowedSourcePattern(dependency) {
  const piOwnership = architectureInventory.governance.piOwnership;
  const declaredOwner = piOwnership.sdkDependencies.find(
    (entry) => entry.dependency === dependency,
  );
  if (!declaredOwner) throw new Error(`No Pi SDK owner declared for ${dependency}`);
  const allowedPackages = [
    declaredOwner.owner,
    ...piOwnership.temporaryDependencyExceptions
      .filter((exception) => exception.dependency === dependency)
      .map((exception) => exception.package),
  ].filter((packageName) => architectureInventory.packages[packageName]);
  return resolvedPackagePattern(architectureInventory, allowedPackages);
}
