import { z } from "zod";

const ModelProviderSchema = z.enum(["openai-codex", "claude", "zai"]);
export const ThinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
const ProfileExecutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ssh"),
    host: z.string().min(1),
    user: z.string().min(1),
    port: z.number().int().positive().optional(),
    defaultCwd: z.string().min(1).optional(),
  }),
]);
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;

export const ProfileRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
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
  defaultThinkingLevel: ThinkingLevelSchema.optional(),
  maxContextTokens: z.number().int().positive().optional(),
  subagentPreferredProvider: ModelProviderSchema.optional(),
  subagentDefaultModelId: z.string().min(1).optional(),
  maxSubagentDepth: z.number().int().min(0).optional(),
  subagentPaths: z.object({
    claude: z.union([
      z.string().min(1),
      z.object({
        path: z.string().min(1),
        description: z.string().min(1).optional(),
      }),
    ]).optional(),
    codex: z.union([
      z.string().min(1),
      z.object({
        path: z.string().min(1),
        description: z.string().min(1).optional(),
      }),
    ]).optional(),
  }).optional(),
});
export type ProfileRecord = z.infer<typeof ProfileRecordSchema>;

export const ProfileRegistrySchema = z.object({
  version: z.number().int().positive(),
  profiles: z.array(ProfileRecordSchema).min(1),
});
export type ProfileRegistry = z.infer<typeof ProfileRegistrySchema>;
