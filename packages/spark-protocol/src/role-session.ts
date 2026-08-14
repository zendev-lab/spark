import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkRoleSourceOptions = ["builtin", "extension", "project", "user"] as const;
export const sparkRoleSourceSchema = z.enum(sparkRoleSourceOptions);

export const sparkRoleCapabilityOptions = [
  "read",
  "write",
  "exec",
  "net",
  "interact",
  "manage",
  "spawn",
] as const;
export const sparkRoleCapabilitySchema = z.enum(sparkRoleCapabilityOptions);

/**
 * A semantic model routing key. Model Types are deliberately open vocabulary:
 * they describe the kind of work and never imply provider rank or cost.
 */
export const sparkRoleModelTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9._-]*$/u, "modelType must be a lowercase semantic key");

export const sparkRoleToolEffectOptions = [
  "read",
  "network_read",
  "control",
  "local_write",
  "external_write",
  "destructive",
] as const;
export const sparkRoleToolEffectSchema = z.enum(sparkRoleToolEffectOptions);

export const sparkRoleSkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "skill names must use lowercase kebab-case");

export const sparkRoleOriginSchema = z
  .object({
    kind: z.enum(["manual", "generated", "builtin", "extension"]),
    sourcePath: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

/** JSON-friendly reusable role definition shared by every execution surface. */
export const sparkRoleSpecSchema = z
  .object({
    ref: z.string().regex(/^role:.+/u),
    id: z.string().trim().min(1),
    source: sparkRoleSourceSchema,
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    description: z.string().trim().min(1),
    systemPrompt: z.string().trim().min(1),
    capabilities: z.array(sparkRoleCapabilitySchema).max(sparkRoleCapabilityOptions.length),
    skills: z.array(sparkRoleSkillNameSchema).min(1).max(8).optional(),
    allowedTools: z.array(z.string().trim().min(1)).optional(),
    allowedToolEffects: z.array(sparkRoleToolEffectSchema).optional(),
    modelType: sparkRoleModelTypeSchema,
    origin: sparkRoleOriginSchema.optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((role, context) => {
    if (new Set(role.capabilities).size !== role.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "role capabilities must be unique",
      });
    }
    if (role.skills && new Set(role.skills).size !== role.skills.length) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "role skills must be unique",
      });
    }
  })
  .strict();

export type SparkRoleSource = z.infer<typeof sparkRoleSourceSchema>;
export type SparkRoleCapability = z.infer<typeof sparkRoleCapabilitySchema>;
export type SparkRoleModelType = z.infer<typeof sparkRoleModelTypeSchema>;
export type SparkRoleToolEffect = z.infer<typeof sparkRoleToolEffectSchema>;
export type SparkRoleOrigin = z.infer<typeof sparkRoleOriginSchema>;
export type SparkRoleSpec = z.infer<typeof sparkRoleSpecSchema>;

export function parseSparkRoleSpec(value: unknown): SparkRoleSpec {
  return sparkRoleSpecSchema.parse(value);
}
