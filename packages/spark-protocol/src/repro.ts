import { z } from "zod";
import { sparkSessionReproWorkViewSchema } from "./protocol.ts";

const ownerBinding = {
  ownerSessionId: z.string().trim().min(1).max(256),
} as const;

export const sparkReproStartRequestSchema = z
  .object({
    ...ownerBinding,
    objective: z.string().trim().min(1).max(16_384),
    reproId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._:-]+$/u)
      .optional(),
  })
  .strict();

export const sparkReproStatusRequestSchema = z.object(ownerBinding).strict();
export const sparkReproStopRequestSchema = z
  .object({
    ...ownerBinding,
    reason: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const sparkReproMutationResultSchema = z
  .object({
    repro: sparkSessionReproWorkViewSchema,
    changed: z.boolean(),
  })
  .strict();

export const sparkReproStatusResultSchema = z
  .object({ repro: sparkSessionReproWorkViewSchema.optional() })
  .strict();

export type SparkReproStartRequest = z.infer<typeof sparkReproStartRequestSchema>;
export type SparkReproStatusRequest = z.infer<typeof sparkReproStatusRequestSchema>;
export type SparkReproStopRequest = z.infer<typeof sparkReproStopRequestSchema>;
export type SparkReproMutationResult = z.infer<typeof sparkReproMutationResultSchema>;
export type SparkReproStatusResult = z.infer<typeof sparkReproStatusResultSchema>;
