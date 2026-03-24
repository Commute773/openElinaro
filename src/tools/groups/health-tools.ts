import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

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

export function buildHealthTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  return [
    defineTool(
      async () =>
        traceSpan(
          "tool.health_summary",
          async () => ctx.health.summary(),
        ),
      {
        name: "health_summary",
        description:
          "Show the latest health tracking summary with recent check-ins and short trend context.",
        schema: z.object({}),
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.health_history",
          async () => ctx.health.history(input.limit ?? 20),
          { attributes: input },
        ),
      {
        name: "health_history",
        description:
          "List recent health check-ins from the structured store and imported markdown notes.",
        schema: healthHistorySchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.health_log_checkin",
          async () => ctx.health.logCheckin({
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
          { attributes: input },
        ),
      {
        name: "health_log_checkin",
        description:
          "Record a structured health check-in covering energy, mood, sleep, anxiety, symptoms, meds, meals, and notes.",
        schema: healthLogCheckinSchema,
      },
    ),
  ];
}
