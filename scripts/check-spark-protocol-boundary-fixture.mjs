import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sparkProtocolSubpathBoundaryViolations } from "./spark-protocol-governance.mjs";

const [subpath, fixturePath] = process.argv.slice(2);
if (!subpath || !fixturePath) {
  console.error("usage: check-spark-protocol-boundary-fixture.mjs <subpath> <fixture>");
  process.exit(2);
}

const violations = sparkProtocolSubpathBoundaryViolations(
  subpath,
  readFileSync(resolve(fixturePath), "utf8"),
);
if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log(`${subpath} boundary fixture passed`);
