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
  artifactRefs: ReadonlySet<string>,
  evidenceRefs: ReadonlySet<string>,
  issues: EvidenceMigrationIssueBuckets,
): { value: unknown; changed: number } {
  const stateVersion = isRecord(value) ? value.version : undefined;

  function visit(current: unknown, path: string[]): { value: unknown; changed: number } {
    if (typeof current === "string") {
      const mapped = mapping.get(current);
      if (mapped) return { value: mapped, changed: 1 };
      if (isLegacyArtifactNamedEvidenceFieldPath(path)) {
        return { value: current, changed: 0 };
      }
      if (isEvidenceFieldPath(path)) {
        auditTypedEvidenceValue(
          current,
          filePath,
          path.join("."),
          mapping,
          artifactRefs,
          evidenceRefs,
          issues,
        );
      } else if (isArtifactFieldPath(path)) {
        auditTypedArtifactValue(current, filePath, path.join("."), mapping, artifactRefs, issues);
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
        const canonicalKey = canonicalEvidenceKeyForLegacyArtifactField(
          [...path, key],
          filePath,
          stateVersion,
        );
        if (canonicalKey !== key && Object.hasOwn(current, canonicalKey)) {
          issues.artifactMisclassified.push(
            migrationIssue(
              filePath,
              "legacy_evidence_field_collision",
              `${pathLabel([...path, key])} collides with ${pathLabel([...path, canonicalKey])}`,
            ),
          );
          const result = visit(entry, [...path, key]);
          changed += result.changed;
          next[key] = result.value;
          continue;
        }
        const result = visit(entry, [...path, canonicalKey]);
        changed += result.changed + (canonicalKey === key ? 0 : 1);
        next[canonicalKey] = result.value;
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
  artifactRefs: ReadonlySet<string>,
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
        artifactRefs,
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
          artifactRefs,
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
        artifactRefs,
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
  artifactRefs: ReadonlySet<string>,
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
        artifactRefs,
        evidenceRefs,
        issues,
      ),
    );
    return;
  }
  if (typeof value !== "string") return;
  if (mapping.has(value)) return;
  if (artifactRefs.has(value)) {
    issues.artifactMisclassified.push(
      migrationIssue(
        filePath,
        "artifact_in_evidence_field",
        `Artifact ref appears in ${field}`,
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

function auditTypedArtifactValue(
  value: unknown,
  filePath: string,
  field: string,
  mapping: ReadonlyMap<string, string>,
  artifactRefs: ReadonlySet<string>,
  issues: Pick<EvidenceMigrationIssueBuckets, "artifactMisclassified">,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      auditTypedArtifactValue(entry, filePath, `${field}[${index}]`, mapping, artifactRefs, issues),
    );
    return;
  }
  if (typeof value !== "string") return;
  if (
    mapping.has(value) ||
    isEvidenceRef(value) ||
    (isArtifactRef(value) && !artifactRefs.has(value))
  ) {
    issues.artifactMisclassified.push(
      migrationIssue(
        filePath,
        "evidence_in_artifact_field",
        `non-Artifact ref appears in ${field}`,
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
  if (keys.some((key) => evidenceKeys.has(key))) return true;
  // `artifactRefs` is the canonical Artifact lane at top level. Before schema v2,
  // completion summaries/digests used the same field for internal Evidence.
  return (
    keys.includes("artifactRefs") &&
    (keys.includes("completionSummary") || keys.includes("completionDigest"))
  );
}

function canonicalEvidenceKeyForLegacyArtifactField(
  path: readonly string[],
  filePath: string,
  stateVersion: unknown,
): string {
  const key = path.at(-1)!;
  const normalizedFilePath = filePath.replaceAll("\\", "/");
  const pathKey = path.join(".");
  if (
    key === "artifactRef" &&
    (pathKey === "artifactRef" || pathKey === "reviews.[].artifactRef") &&
    (normalizedFilePath.startsWith(".spark/reviews/") ||
      normalizedFilePath.includes("/reviews/") ||
      normalizedFilePath.includes("/goal-reviews/") ||
      normalizedFilePath.startsWith(".spark/asks/evidence-receipts/"))
  ) {
    return "evidenceRef";
  }
  if (key === "artifactRefs") {
    const keys = path.filter((segment) => segment !== "[]");
    if (
      (pathKey === "events.[].artifactRefs" &&
        normalizedFilePath === ".spark/role-run-activity-events.json") ||
      keys.includes("completionDigest") ||
      (keys.includes("completionSummary") && stateVersion === 2)
    ) {
      return "evidenceRefs";
    }
  }
  return key;
}

function isLegacyArtifactNamedEvidenceFieldPath(path: readonly string[]): boolean {
  const keys = path.filter((segment) => segment !== "[]");
  if (!keys.includes("artifactRef")) return false;
  // Goal v1 state keeps this field name because its reader performs in-memory normalization.
  // Review records and ask receipts are renamed by canonicalEvidenceKeyForLegacyArtifactField.
  return keys.includes("lastReview");
}

function pathLabel(path: readonly string[]): string {
  return path.join(".") || "<root>";
}

function isArtifactFieldPath(path: readonly string[]): boolean {
  return path.some((key) => key === "artifactRef" || key === "artifactRefs");
}
