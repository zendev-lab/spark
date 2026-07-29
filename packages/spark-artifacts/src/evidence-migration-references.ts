import {
  migrationIssue,
  isRecord,
  type EvidenceMigrationIssue,
  type EvidenceMigrationIssueBuckets,
  type EvidenceMigrationSkipped,
} from "./evidence-migration-types.ts";
import { isArtifactRef, isEvidenceRef } from "./evidence-migration-paths.ts";

export function rewriteStateRefs(
  value: unknown,
  filePath: string,
  mapping: ReadonlyMap<string, string>,
  productRefs: ReadonlySet<string>,
  evidenceRefs: ReadonlySet<string>,
  issues: EvidenceMigrationIssueBuckets,
): { value: unknown; changed: number } {
  function visit(current: unknown, path: string[]): { value: unknown; changed: number } {
    if (typeof current === "string") {
      const mapped = mapping.get(current);
      if (mapped) return { value: mapped, changed: 1 };
      if (isEvidenceFieldPath(path)) {
        auditTypedEvidenceValue(
          current,
          filePath,
          path.join("."),
          mapping,
          productRefs,
          evidenceRefs,
          issues,
        );
      } else if (isProductFieldPath(path)) {
        auditTypedProductValue(current, filePath, path.join("."), mapping, productRefs, issues);
      }
      return { value: current, changed: 0 };
    }
    if (Array.isArray(current)) {
      let changed = 0;
      const next = current.map((entry) => {
        const result = visit(entry, [...path, "[]"]);
        changed += result.changed;
        return result.value;
      });
      return { value: changed > 0 ? next : current, changed };
    }
    if (isRecord(current)) {
      let changed = 0;
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        const result = visit(entry, [...path, key]);
        changed += result.changed;
        next[key] = result.value;
      }
      return { value: changed > 0 ? next : current, changed };
    }
    return { value: current, changed: 0 };
  }
  return visit(value, []);
}

export function rewriteExactRefs(
  value: unknown,
  mapping: ReadonlyMap<string, string>,
): { value: unknown; changed: number } {
  if (typeof value === "string") {
    const mapped = mapping.get(value);
    return mapped ? { value: mapped, changed: 1 } : { value, changed: 0 };
  }
  if (Array.isArray(value)) {
    let changed = 0;
    const next = value.map((entry) => {
      const result = rewriteExactRefs(entry, mapping);
      changed += result.changed;
      return result.value;
    });
    return { value: changed > 0 ? next : value, changed };
  }
  if (isRecord(value)) {
    let changed = 0;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = rewriteExactRefs(entry, mapping);
      changed += result.changed;
      next[key] = result.value;
    }
    return { value: changed > 0 ? next : value, changed };
  }
  return { value, changed: 0 };
}

export function auditEvidenceRecordRefs(
  raw: Record<string, unknown>,
  path: string,
  mapping: ReadonlyMap<string, string>,
  productRefs: ReadonlySet<string>,
  evidenceRefs: ReadonlySet<string>,
  issues: EvidenceMigrationIssueBuckets,
): void {
  const links = raw.links;
  if (Array.isArray(links)) {
    for (let index = 0; index < links.length; index += 1) {
      const link = links[index];
      if (!isRecord(link)) continue;
      auditTypedEvidenceValue(
        link.from,
        path,
        `links[${index}].from`,
        mapping,
        productRefs,
        evidenceRefs,
        issues,
      );
      const to = link.to;
      if (typeof to === "string" && (isArtifactRef(to) || isEvidenceRef(to))) {
        auditTypedEvidenceValue(
          to,
          path,
          `links[${index}].to`,
          mapping,
          productRefs,
          evidenceRefs,
          issues,
        );
      }
    }
  }
  if (isRecord(raw.provenance)) {
    for (const key of ["parentArtifactRefs", "parentEvidenceRefs"] as const) {
      auditTypedEvidenceValue(
        raw.provenance[key],
        path,
        `provenance.${key}`,
        mapping,
        productRefs,
        evidenceRefs,
        issues,
      );
    }
  }
}

export function sortedUniqueIssues(issues: EvidenceMigrationIssue[]): EvidenceMigrationIssue[] {
  const unique = new Map(issues.map((entry) => [JSON.stringify(entry), entry]));
  return [...unique.values()].sort((left, right) =>
    `${left.path}\0${left.code}\0${left.ref ?? ""}`.localeCompare(
      `${right.path}\0${right.code}\0${right.ref ?? ""}`,
    ),
  );
}

export function sortedUniqueSkipped(
  skipped: EvidenceMigrationSkipped[],
): EvidenceMigrationSkipped[] {
  const unique = new Map(skipped.map((entry) => [JSON.stringify(entry), entry]));
  return [...unique.values()].sort((left, right) =>
    `${left.path}\0${left.reason}`.localeCompare(`${right.path}\0${right.reason}`),
  );
}

function auditTypedEvidenceValue(
  value: unknown,
  filePath: string,
  field: string,
  mapping: ReadonlyMap<string, string>,
  productRefs: ReadonlySet<string>,
  evidenceRefs: ReadonlySet<string>,
  issues: EvidenceMigrationIssueBuckets,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      auditTypedEvidenceValue(
        entry,
        filePath,
        `${field}[${index}]`,
        mapping,
        productRefs,
        evidenceRefs,
        issues,
      ),
    );
    return;
  }
  if (typeof value !== "string") return;
  if (mapping.has(value)) return;
  if (productRefs.has(value)) {
    issues.productMisclassified.push(
      migrationIssue(
        filePath,
        "product_in_evidence_field",
        `Product Artifact ref appears in ${field}`,
        value,
      ),
    );
    return;
  }
  if ((isArtifactRef(value) || isEvidenceRef(value)) && !evidenceRefs.has(value)) {
    issues.dangling.push(
      migrationIssue(filePath, "dangling_evidence_ref", `missing evidence ref in ${field}`, value),
    );
  }
}

function auditTypedProductValue(
  value: unknown,
  filePath: string,
  field: string,
  mapping: ReadonlyMap<string, string>,
  productRefs: ReadonlySet<string>,
  issues: Pick<EvidenceMigrationIssueBuckets, "productMisclassified">,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      auditTypedProductValue(entry, filePath, `${field}[${index}]`, mapping, productRefs, issues),
    );
    return;
  }
  if (typeof value !== "string") return;
  if (
    mapping.has(value) ||
    isEvidenceRef(value) ||
    (isArtifactRef(value) && !productRefs.has(value))
  ) {
    issues.productMisclassified.push(
      migrationIssue(
        filePath,
        "evidence_in_product_field",
        `non-product ref appears in ${field}`,
        value,
      ),
    );
  }
}

function isEvidenceFieldPath(path: readonly string[]): boolean {
  const keys = path.filter((segment) => segment !== "[]");
  const evidenceKeys = new Set([
    "evidenceRef",
    "evidenceRefs",
    "evidencePreviews",
    "inputEvidenceRefs",
    "outputEvidenceRefs",
    "inputArtifacts",
    "outputArtifacts",
    "artifactRefs",
    "parentEvidenceRefs",
    "parentArtifactRefs",
    "reviewArtifactRef",
    "lastReviewArtifactRef",
    "controlArtifactRef",
    "askArtifactRef",
    "askArtifactRefs",
    "taskEvidenceRefs",
    "knownFailedReviewArtifacts",
    "attemptedFinishArtifacts",
  ]);
  return keys.some((key) => evidenceKeys.has(key));
}

function isProductFieldPath(path: readonly string[]): boolean {
  return path.some((key) => key === "productArtifactRef" || key === "productArtifactRefs");
}
