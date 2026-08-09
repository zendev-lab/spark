import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const formalAttestationBindingSchema = z.object({
  workspaceCwd: z.string().trim().min(1),
  reproId: z.string().trim().min(1),
  requirementId: z.string().trim().min(1),
  stepId: z.string().trim().min(1),
  planRevision: z.number().int().positive(),
  stepDefinitionDigest: z.string().trim().min(1),
  invocationClass: z.literal("owning_entrypoint"),
  evidenceClass: z.literal("entrypoint"),
  profileDigest: sha256Schema,
  topologyDigest: sha256Schema,
});

export const sparkReproFormalEvidenceAttestationSchema = z.object({
  schema: z.literal("spark.repro.formal-evidence-attestation/v1"),
  verifierId: z.string().trim().min(1),
  verifierVersion: z.string().trim().min(1),
  verifiedAt: isoDateTimeSchema,
  binding: formalAttestationBindingSchema,
  verdict: z.literal("accepted"),
  resultDigest: sha256Schema,
  signature: z.string().trim().min(1),
});

export const sparkReproFormalEvidenceCandidateSchema = formalAttestationBindingSchema.extend({
  evidenceRef: z.string().startsWith("evidence:"),
  evidenceHash: sha256Schema,
});

export const sparkReproFormalEvidenceReceiptSchema = formalAttestationBindingSchema.extend({
  evidenceRef: z.string().startsWith("evidence:"),
  schema: z.literal("spark.repro.formal-evidence-receipt/v1"),
  evidenceHash: sha256Schema,
  verifierId: z.string().trim().min(1),
  verifierVersion: z.string().trim().min(1),
  verdict: z.enum(["accepted", "rejected"]),
  verifiedAt: isoDateTimeSchema,
  stale: z.boolean(),
  superseded: z.boolean(),
});

export const sparkReproFormalEvidenceRecordRequestSchema = z.object({
  workspaceCwd: z.string().trim().min(1),
  candidate: sparkReproFormalEvidenceCandidateSchema,
});

export const sparkReproFormalEvidenceRecordResultSchema = z.object({
  recorded: z.literal(true),
  receipt: sparkReproFormalEvidenceReceiptSchema,
});

export type SparkReproFormalEvidenceAttestation = z.infer<
  typeof sparkReproFormalEvidenceAttestationSchema
>;
export type SparkReproFormalEvidenceCandidate = z.infer<
  typeof sparkReproFormalEvidenceCandidateSchema
>;
export type SparkReproFormalEvidenceReceipt = z.infer<typeof sparkReproFormalEvidenceReceiptSchema>;
export type SparkReproFormalEvidenceReceiptIdentity = Pick<
  SparkReproFormalEvidenceReceipt,
  | "reproId"
  | "requirementId"
  | "stepId"
  | "evidenceRef"
  | "evidenceHash"
  | "planRevision"
  | "stepDefinitionDigest"
  | "profileDigest"
  | "topologyDigest"
>;
export type SparkReproFormalEvidenceRecordRequest = z.infer<
  typeof sparkReproFormalEvidenceRecordRequestSchema
>;
export type SparkReproFormalEvidenceRecordResult = z.infer<
  typeof sparkReproFormalEvidenceRecordResultSchema
>;

/** Stable bytes signed by an independently registered formal Evidence verifier. */
export function sparkReproFormalEvidenceAttestationPayload(
  attestation: Omit<SparkReproFormalEvidenceAttestation, "signature">,
): string {
  return canonicalJson(attestation);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("formal attestation contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`formal attestation contains unsupported ${typeof value}`);
}
