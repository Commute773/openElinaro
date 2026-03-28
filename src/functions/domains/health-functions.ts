/**
 * Health tracking function definitions.
 * Migrated from src/tools/groups/health-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";

// ---------------------------------------------------------------------------
// Shared schemas (same as health-tools.ts)
// ---------------------------------------------------------------------------

const healthHistorySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

const healthLogCheckinSchema = z.object({
  observedAt: z.string().optional(),
  kind: z.string().optional(),
  energy: z.number().min(0).max(10).optional(),
  mood: z.number().min(0).max(10).optional(),
  sleepHours: z.number().min(0).max(24).optional(),
  symptoms: z.string().optional(),
  dizziness: z.string().optional(),
  anxiety: z.number().min(0).max(10).optional(),
  caffeineMg: z.number().min(0).max(2_000).optional(),
  dextroamphetamineMg: z.number().min(0).max(200).optional(),
  heartRateBpm: z.number().min(0).max(300).optional(),
  meals: z.array(z.string()).max(20).optional(),
  notes: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Health auth defaults
// ---------------------------------------------------------------------------

const HEALTH_AUTH = { access: "anyone" as const, behavior: "uniform" as const };
const HEALTH_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const HEALTH_DOMAINS = ["health"];
const HEALTH_UNTRUSTED = {
  sourceType: "other",
  sourceName: "health summary",
  notes: "Health notes and check-ins are user-managed personal data.",
};

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildHealthFunctions: FunctionDomainBuilder = (ctx) => [
  // -----------------------------------------------------------------------
  // health_summary
  // -----------------------------------------------------------------------
  defineFunction({
    name: "health_summary",
    description:
      "Show the latest health tracking summary with recent check-ins and short trend context.",
    input: z.object({}),
    handler: async (_input, fnCtx) => fnCtx.services.health.summary(),
    auth: HEALTH_AUTH,
    domains: HEALTH_DOMAINS,
    agentScopes: HEALTH_SCOPES,
    examples: ["show health summary", "check recent health trend"],
    untrustedOutput: HEALTH_UNTRUSTED,
  }),

  // -----------------------------------------------------------------------
  // health_history
  // -----------------------------------------------------------------------
  defineFunction({
    name: "health_history",
    description:
      "List recent health check-ins from the structured store and imported markdown notes.",
    input: healthHistorySchema,
    handler: async (input, fnCtx) =>
      fnCtx.services.health.history(input.limit ?? 20),
    auth: HEALTH_AUTH,
    domains: HEALTH_DOMAINS,
    agentScopes: HEALTH_SCOPES,
    examples: ["list health check-ins", "show recent imported health notes"],
    untrustedOutput: {
      sourceType: "other",
      sourceName: "health history",
      notes: "Health notes and check-ins are user-managed personal data.",
    },
  }),

  // -----------------------------------------------------------------------
  // health_log_checkin
  // -----------------------------------------------------------------------
  defineFunction({
    name: "health_log_checkin",
    description:
      "Record a structured health check-in covering energy, mood, sleep, anxiety, symptoms, meds, meals, and notes.",
    input: healthLogCheckinSchema,
    handler: async (input, fnCtx) =>
      fnCtx.services.health.logCheckin({
        observedAt: input.observedAt,
        kind: input.kind,
        energy: input.energy,
        mood: input.mood,
        sleepHours: input.sleepHours,
        symptoms: input.symptoms,
        dizziness: input.dizziness,
        anxiety: input.anxiety,
        caffeineMg: input.caffeineMg,
        dextroamphetamineMg: input.dextroamphetamineMg,
        heartRateBpm: input.heartRateBpm,
        meals: input.meals,
        notes: input.notes,
      }),
    auth: HEALTH_AUTH,
    domains: HEALTH_DOMAINS,
    agentScopes: HEALTH_SCOPES,
    examples: ["log a health check-in", "record anxiety and energy"],
    mutatesState: true,
    untrustedOutput: {
      sourceType: "other",
      sourceName: "health check-in result",
      notes: "Health notes and check-ins are user-managed personal data.",
    },
  }),
];
