import { asciiSlug } from "@zendev-lab/spark-platform-node/strings";

export function slugifyWorkspaceIdentifier(value: string) {
  return asciiSlug(value, { maxLength: 48 });
}
