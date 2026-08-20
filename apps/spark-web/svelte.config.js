import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { execFileSync } from "node:child_process";
import { typescriptWithSvelteImports } from "./src/svelte-preprocess.js";

const buildVersion =
  process.env.SPARK_BUILD_GIT_SHA?.trim() ||
  execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: [typescriptWithSvelteImports, vitePreprocess()],
  kit: {
    adapter: adapter({ out: "build" }),
    version: { name: buildVersion },
  },
};

export default config;
