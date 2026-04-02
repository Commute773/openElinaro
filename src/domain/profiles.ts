import { z } from "zod";

export const MODEL_PROVIDER_IDS = ["claude"] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];
const ModelProviderSchema = z.enum(MODEL_PROVIDER_IDS);

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevelId = (typeof THINKING_LEVELS)[number];
export const ThinkingLevelSchema = z.enum(THINKING_LEVELS);
const ProfileExecutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ssh"),
    host: z.string().min(1),
    user: z.string().min(1),
    port: z.number().int().positive().optional(),
    defaultCwd: z.string().min(1).optional(),
  }),
]);

export const ProfileRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  memoryNamespace: z.string().min(1),
  shellUser: z.string().min(1).optional(),
  pathRoots: z.array(z.string().min(1)).min(1).optional(),
  execution: ProfileExecutionSchema.optional(),
  preferredProvider: ModelProviderSchema.optional(),
  defaultModelId: z.string().min(1).optional(),
  toolSummarizerProvider: ModelProviderSchema.optional(),
  toolSummarizerModelId: z.string().min(1).optional(),
  memoryProvider: ModelProviderSchema.optional(),
  memoryModelId: z.string().min(1).optional(),
  reflectionProvider: ModelProviderSchema.optional(),
  reflectionModelId: z.string().min(1).optional(),
  heartbeatProvider: ModelProviderSchema.optional(),
  heartbeatModelId: z.string().min(1).optional(),
  memoryRecallProvider: ModelProviderSchema.optional(),
  memoryRecallModelId: z.string().min(1).optional(),
  defaultThinkingLevel: ThinkingLevelSchema.optional(),
  maxContextTokens: z.number().int().positive().optional(),
});
export type ProfileRecord = z.infer<typeof ProfileRecordSchema>;

export const ProfileRegistrySchema = z.object({
  version: z.number().int().positive(),
  profiles: z.array(ProfileRecordSchema).min(1),
});
export type ProfileRegistry = z.infer<typeof ProfileRegistrySchema>;
