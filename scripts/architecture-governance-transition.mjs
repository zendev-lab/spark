import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  validateArchitectureGovernanceTransition,
} = require("../architecture/dependency-governance.cjs");

export function loadArchitectureInventoryAtGitRef(rootDir, ref) {
  try {
    const source = execFileSync("git", ["show", `${ref}:architecture/packages.json`], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read architecture transition base ${ref}: ${detail}`, {
      cause: error,
    });
  }
}

export function validateArchitectureTransitionFromGitRef(rootDir, ref, currentInventory) {
  const previousInventory = loadArchitectureInventoryAtGitRef(rootDir, ref);
  return validateArchitectureGovernanceTransition(previousInventory, currentInventory);
}
