import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type ViteUserConfig } from "vitest/config";

type ScreenshotPathData = {
  arg: string;
  browserName: string;
  ext: string;
  root: string;
  testFileName: string;
};

const config = {
  plugins: [svelte()],
  optimizeDeps: {
    exclude: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
    include: ["bits-ui > svelte-toolbelt > style-to-object"],
  },
  resolve: {
    conditions: ["browser"],
    dedupe: ["svelte"],
  },
  ssr: {
    noExternal: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
  },
  test: {
    fileParallelism: false,
    name: "browser",
    include: ["src/**/*.browser.test.ts", "catalog/**/*.browser.test.ts"],
    setupFiles: ["vitest-browser-svelte"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      expect: {
        toMatchScreenshot: {
          comparatorName: "pixelmatch",
          comparatorOptions: {
            threshold: 0.2,
            allowedMismatchedPixelRatio: 0.04,
          },
          resolveScreenshotPath: ({
            arg,
            browserName,
            ext,
            root,
            testFileName,
          }: ScreenshotPathData) =>
            path.resolve(
              root,
              "catalog",
              "__screenshots__",
              testFileName,
              `${arg}-${browserName}${ext}`,
            ),
        },
      },
    },
  },
} as unknown as ViteUserConfig;

export default defineConfig(config);
