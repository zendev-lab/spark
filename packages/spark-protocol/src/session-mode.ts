import { z } from "zod";

export const sparkSessionModeOptions = ["plan", "execute", "fleet"] as const;
export const sparkSessionModeSchema = z.enum(sparkSessionModeOptions);

export const sparkSessionSetModeRequestSchema = z.object({
  sessionId: z.string().trim().min(1),
  mode: sparkSessionModeSchema,
});

export const sparkSessionModeResultSchema = sparkSessionSetModeRequestSchema;

export type SparkSessionMode = z.infer<typeof sparkSessionModeSchema>;
export type SparkSessionSetModeRequest = z.infer<typeof sparkSessionSetModeRequestSchema>;
export type SparkSessionModeResult = z.infer<typeof sparkSessionModeResultSchema>;
