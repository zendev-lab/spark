#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [inventoryArgument] = process.argv.slice(2);
if (process.argv.length > 3) {
  throw new Error("Usage: node scripts/validate-architecture-inventory.mjs [inventory.json]");
}
const schemaPath = resolve(root, "architecture/packages.schema.json");
const inventoryPath = inventoryArgument
  ? resolve(root, inventoryArgument)
  : resolve(root, "architecture/packages.json");
const [schema, inventory] = await Promise.all(
  [schemaPath, inventoryPath].map(async (path) => {
    const source = await readFile(path, "utf8");
    try {
      return JSON.parse(source);
    } catch (error) {
      throw new Error(`${path} is not valid JSON`, { cause: error });
    }
  }),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);
if (!validate(inventory)) {
  const failures = (validate.errors ?? []).map((error) => {
    const path = error.instancePath || "/";
    return `${path}: ${error.message ?? error.keyword}`;
  });
  throw new Error(`Invalid architecture/packages.json:\n- ${failures.join("\n- ")}`);
}

console.log("Architecture package inventory matches architecture/packages.schema.json.");
