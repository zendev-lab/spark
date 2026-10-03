import { z } from "zod";

import {
  sparkRoleCapabilitySchema,
  sparkRoleModelTypeSchema,
  sparkRoleOriginSchema,
  sparkRoleSkillNameSchema,
  sparkRoleSpecSchema,
  sparkRoleToolEffectSchema,
} from "./role-session.ts";

const workspaceCatalogInputSchema = z.object({ workspaceId: z.string().trim().min(1) }).strict();

export const sparkRoleCatalogEntrySchema = z
  .object({
    ref: sparkRoleSpecSchema.shape.ref,
    id: sparkRoleSpecSchema.shape.id,
    source: sparkRoleSpecSchema.shape.source,
    revision: sparkRoleSpecSchema.shape.revision,
    description: sparkRoleSpecSchema.shape.description,
    capabilities: sparkRoleSpecSchema.shape.capabilities,
    skills: sparkRoleSpecSchema.shape.skills,
    allowedTools: sparkRoleSpecSchema.shape.allowedTools,
    allowedToolEffects: sparkRoleSpecSchema.shape.allowedToolEffects,
    modelType: sparkRoleSpecSchema.shape.modelType,
    origin: sparkRoleOriginSchema.omit({ sourcePath: true }).optional(),
    createdAt: sparkRoleSpecSchema.shape.createdAt,
    updatedAt: sparkRoleSpecSchema.shape.updatedAt,
  })
  .strict();

export const sparkRoleListRequestSchema = workspaceCatalogInputSchema;
export const sparkRoleListResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    roles: z.array(sparkRoleCatalogEntrySchema),
  })
  .strict();

export const sparkRoleCreateRequestSchema = workspaceCatalogInputSchema.extend({
  id: z
    .string()
    .trim()
    .min(1)
    .max(96)
    .regex(/^[a-z0-9]+(?:[-_/][a-z0-9]+)*$/u),
  description: z.string().trim().min(1).max(512),
  systemPrompt: z
    .string()
    .trim()
    .min(1)
    .max(128 * 1024),
  capabilities: z.array(sparkRoleCapabilitySchema).max(7).default([]),
  skills: z.array(sparkRoleSkillNameSchema).min(1).max(8).optional(),
  allowedTools: z.array(z.string().trim().min(1)).max(128).optional(),
  allowedToolEffects: z.array(sparkRoleToolEffectSchema).max(6).optional(),
  modelType: sparkRoleModelTypeSchema,
});
export const sparkRoleCreateResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    created: z.boolean(),
    role: sparkRoleCatalogEntrySchema,
  })
  .strict();

export const sparkRoleModelSettingsSourceSchema = z.enum(["project", "user"]);
export const sparkRoleModelSettingsEntrySchema = z
  .object({
    modelType: sparkRoleModelTypeSchema,
    model: z
      .string()
      .trim()
      .min(3)
      .regex(/^[^/\s]+\/[^\s]+$/u),
    source: sparkRoleModelSettingsSourceSchema,
  })
  .strict();

export const sparkRoleModelListRequestSchema = workspaceCatalogInputSchema.extend({
  source: sparkRoleModelSettingsSourceSchema.optional(),
});
export const sparkRoleModelListResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    entries: z.array(sparkRoleModelSettingsEntrySchema),
  })
  .strict();

const roleModelTargetInputSchema = workspaceCatalogInputSchema.extend({
  roleRef: sparkRoleSpecSchema.shape.ref,
});

export const sparkRoleModelGetRequestSchema = roleModelTargetInputSchema;
export const sparkRoleModelGetResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    role: sparkRoleCatalogEntrySchema.nullable(),
    setting: sparkRoleModelSettingsEntrySchema.nullable(),
  })
  .strict();

export const sparkRoleModelSetRequestSchema = roleModelTargetInputSchema.extend({
  model: sparkRoleModelSettingsEntrySchema.shape.model,
  source: sparkRoleModelSettingsSourceSchema.default("project"),
});
export const sparkRoleModelSetResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    role: sparkRoleCatalogEntrySchema,
    setting: sparkRoleModelSettingsEntrySchema,
  })
  .strict();

export const sparkRoleModelDeleteRequestSchema = roleModelTargetInputSchema.extend({
  source: sparkRoleModelSettingsSourceSchema,
});
export const sparkRoleModelDeleteResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    role: sparkRoleCatalogEntrySchema,
    source: sparkRoleModelSettingsSourceSchema,
    deleted: z.boolean(),
  })
  .strict();

export const sparkSkillCatalogEntrySchema = z
  .object({
    name: sparkRoleSkillNameSchema,
    description: z.string().min(1),
    title: z.string().min(1).optional(),
    layer: z.enum(["builtin", "user", "workspace", "cwd", "configured", "repository"]),
    disableModelInvocation: z.boolean(),
  })
  .strict();

export const sparkSkillListRequestSchema = workspaceCatalogInputSchema;
export const sparkSkillListResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    skills: z.array(sparkSkillCatalogEntrySchema),
  })
  .strict();

export type SparkRoleCatalogEntry = z.infer<typeof sparkRoleCatalogEntrySchema>;
export type SparkRoleCreateRequest = z.infer<typeof sparkRoleCreateRequestSchema>;
export type SparkRoleModelSettingsEntry = z.infer<typeof sparkRoleModelSettingsEntrySchema>;
export type SparkSkillCatalogEntry = z.infer<typeof sparkSkillCatalogEntrySchema>;
