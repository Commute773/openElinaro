import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import type { JobStatus, ProjectStatus } from "../../domain/projects";
import {
  ELINARO_DEFAULT_VISIBLE_TICKET_STATUSES,
  ELINARO_TICKET_PRIORITIES,
  ELINARO_TICKET_STATUSES,
  type ElinaroTicket,
} from "../../services/elinaro-tickets-service";
import { hasProviderAuth, getAuthStatus } from "../../auth/store";
import { ProfileService } from "../../services/profile-service";
import {
  AmbiguousModelIdentifierError,
  ModelService,
  type ModelProviderId,
} from "../../services/model-service";
import type { ThinkingLevel } from "@mariozechner/pi-ai";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

const responseFormatSchema = z.enum(["text", "json"]);
const modelProviderSchema = z.enum(["openai-codex", "claude"]);
const modelProviderIds: ModelProviderId[] = ["openai-codex", "claude"];
const thinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
const jobStatusSchema = z.enum(["active", "paused", "archived"]);
const projectStatusSchema = z.enum(["active", "paused", "idea", "archived"]);
const elinaroTicketStatusSchema = z.enum(ELINARO_TICKET_STATUSES);
const elinaroTicketPrioritySchema = z.enum(ELINARO_TICKET_PRIORITIES);

const workSummarySchema = z.object({
  format: z.enum(["text", "json"]).optional(),
});

const listJobSchema = z.object({
  status: jobStatusSchema.or(z.literal("all")).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const listProjectSchema = z.object({
  status: projectStatusSchema.or(z.literal("all")).optional(),
  scope: z.enum(["work", "personal", "all"]).optional(),
  jobId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const idSchema = z.object({
  id: z.string().min(1),
});

const listElinaroTicketsSchema = z.object({
  statuses: z.array(elinaroTicketStatusSchema).optional(),
  priority: elinaroTicketPrioritySchema.optional(),
  label: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  sort: z.enum(["created_at", "updated_at", "priority"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

const createElinaroTicketSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: elinaroTicketStatusSchema.optional(),
  priority: elinaroTicketPrioritySchema,
  labels: z.array(z.string().min(1)).optional(),
});

const updateElinaroTicketSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: elinaroTicketStatusSchema.optional(),
  priority: elinaroTicketPrioritySchema.optional(),
  labels: z.array(z.string().min(1)).optional(),
}).superRefine((value, ctx) => {
  const hasUpdate =
    value.title !== undefined
    || value.description !== undefined
    || value.status !== undefined
    || value.priority !== undefined
    || value.labels !== undefined;
  if (!hasUpdate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one ticket field to update.",
    });
  }
});

const listLaunchableProfilesSchema = z.object({
  format: responseFormatSchema.optional(),
});

const setProfileDefaultsSchema = z.object({
  profileId: z.string().min(1),
  modelId: z.string().min(1).optional(),
  provider: modelProviderSchema.optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
}).superRefine((value, ctx) => {
  if (!value.modelId && !value.thinkingLevel) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one of modelId or thinkingLevel.",
      path: ["modelId"],
    });
  }
  if (value.provider && !value.modelId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provider can only be set together with modelId.",
      path: ["provider"],
    });
  }
});

function ensureTicketsConfigured(tickets: ToolBuildContext["tickets"]) {
  const error = tickets.getConfigurationError();
  if (error) {
    throw new Error(`Elinaro Tickets tool is unavailable: ${error}`);
  }
}

function formatTicketLine(ticket: ElinaroTicket) {
  const labelText = ticket.labels.length > 0 ? ` labels=${ticket.labels.join(",")}` : "";
  return `${ticket.id} | ${ticket.status} | ${ticket.priority} | ${ticket.title}${labelText} | updated=${ticket.updatedAt}`;
}

function formatTicketDetail(ticket: ElinaroTicket) {
  const lines = [
    `${ticket.id} | ${ticket.status} | ${ticket.priority}`,
    `Title: ${ticket.title}`,
    `Labels: ${ticket.labels.length > 0 ? ticket.labels.join(", ") : "(none)"}`,
    `Created: ${ticket.createdAt}`,
    `Updated: ${ticket.updatedAt}`,
    `Closed: ${ticket.closedAt ?? "(open)"}`,
  ];
  if (ticket.description.trim()) {
    lines.push("", "Description:", ticket.description.trim());
  }
  return lines.join("\n");
}

async function resolveProfileModelSelection(
  targetProfile: { id: string },
  targetModels: ModelService,
  requestedModelId: string,
  providerId?: ModelProviderId,
) {
  if (providerId) {
    const resolved = await targetModels.resolveProviderModel(providerId, requestedModelId);
    return { providerId, resolved };
  }

  const configuredProviders = modelProviderIds.filter((candidate) =>
    hasProviderAuth(candidate, targetProfile.id)
  );
  if (configuredProviders.length === 0) {
    throw new Error(
      `Cannot auto-detect a provider for profile ${targetProfile.id} because no provider auth is configured there.`,
    );
  }

  const resolvedMatches: Array<{
    providerId: ModelProviderId;
    resolved: Awaited<ReturnType<ModelService["resolveProviderModel"]>>;
  }> = [];
  const ambiguousCandidates = new Set<string>();
  let sawCatalogLookup = false;

  for (const candidate of configuredProviders) {
    try {
      const resolved = await targetModels.resolveProviderModel(candidate, requestedModelId);
      resolvedMatches.push({ providerId: candidate, resolved });
      sawCatalogLookup = true;
    } catch (error) {
      if (error instanceof AmbiguousModelIdentifierError) {
        for (const candidateModelId of error.candidates) {
          ambiguousCandidates.add(`${candidate}/${candidateModelId}`);
        }
        sawCatalogLookup = true;
        continue;
      }

      if (error instanceof Error && error.message === `Model not found in the live catalog: ${requestedModelId}`) {
        continue;
      }

      throw error;
    }
  }

  if (resolvedMatches.length === 1 && ambiguousCandidates.size === 0) {
    return resolvedMatches[0]!;
  }

  if (resolvedMatches.length > 1 || ambiguousCandidates.size > 0) {
    const candidates = [
      ...resolvedMatches.map(({ providerId: matchedProviderId, resolved }) => `${matchedProviderId}/${resolved.modelId}`),
      ...ambiguousCandidates,
    ];
    throw new AmbiguousModelIdentifierError(requestedModelId, [...new Set(candidates)]);
  }

  if (!sawCatalogLookup) {
    throw new Error(
      `Model "${requestedModelId}" was not found in any configured provider catalog for profile ${targetProfile.id}.`,
    );
  }

  throw new Error(`Model not found in the live catalog: ${requestedModelId}`);
}

export function buildProjectTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [
    defineTool(
      async (input) =>
        traceSpan(
          "tool.job_list",
          async () => {
            const jobs = ctx.projects.listJobs({
              status: (input.status as JobStatus | "all" | undefined) ?? "all",
              limit: input.limit,
            });
            if (jobs.length === 0) {
              return "No known jobs matched.";
            }
            return jobs.map((job) =>
              [
                `- ${job.id}`,
                `[${job.status}/${job.priority}]`,
                job.summary,
              ].join(" ")).join("\n");
          },
          { attributes: input },
        ),
      {
        name: "job_list",
        description:
          "List known jobs or clients from ~/.openelinaro/projects/registry.json, including status, priority, and summary.",
        schema: listJobSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.job_get",
          async () => {
            const job = ctx.projects.getJob(input.id);
            if (!job) {
              throw new Error(`Job not found: ${input.id}`);
            }
            return ctx.projects.formatJob(job);
          },
          { attributes: input },
        ),
      {
        name: "job_get",
        description:
          "Get one known job or client, including status, priority, summary, and availability blocks.",
        schema: idSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.work_summary",
          async () => {
            const snapshot = ctx.workPlanning.getSnapshot();
            if (input.format === "json") {
              return JSON.stringify(snapshot, null, 2);
            }
            return ctx.workPlanning.buildSummary();
          },
          { attributes: input },
        ),
      {
        name: "work_summary",
        description:
          "Show the current work-time context, active jobs, top projects, current focus, and ranked next work items.",
        schema: workSummarySchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.project_list",
          async () => {
            const projects = ctx.projects.listProjects({
              status: (input.status as ProjectStatus | "all" | undefined) ?? "all",
              scope: input.scope,
              jobId: input.jobId,
              limit: input.limit,
            });
            if (projects.length === 0) {
              return "No known projects matched.";
            }
            return projects.map((project) =>
              [
                `- ${project.id}`,
                `[${project.status}/${project.jobId ? "work" : "personal"}/${project.priority}]`,
                project.jobId ? `job=${project.jobId}` : "",
                project.summary,
                `workspace=${ctx.projects.resolveWorkspacePath(project)}`,
              ].join(" ")).join("\n");
          },
          { attributes: input },
        ),
      {
        name: "project_list",
        description:
          "List known projects from ~/.openelinaro/projects/registry.json, including personal vs work scope, status, summary, and workspace path.",
        schema: listProjectSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.project_get",
          async () => {
            const project = ctx.projects.getProject(input.id);
            if (!project) {
              throw new Error(`Project not found: ${input.id}`);
            }
            return ctx.projects.formatProject(project);
          },
          { attributes: input },
        ),
      {
        name: "project_get",
        description:
          "Get one known project, including current state, next focus, workspace path, README location, and embedded state/future/milestone content from the registry.",
        schema: idSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.profile_list_launchable",
          async () => {
            const activeProfile = ctx.access.getProfile();
            const profiles = ctx.access.listLaunchableProfiles();
            const items = profiles.map((profile) => ({
              id: profile.id,
              name: profile.name,
              roles: profile.roles,
              memoryNamespace: profile.memoryNamespace,
              shellUser: profile.shellUser ?? null,
              executionKind: profile.execution?.kind ?? "local",
              executionTarget: profile.execution?.kind === "ssh"
                ? `${profile.execution.user}@${profile.execution.host}${profile.execution.port ? `:${profile.execution.port}` : ""}`
                : null,
              pathRoots: profile.pathRoots ?? [],
              preferredProvider: profile.preferredProvider ?? null,
              defaultModelId: profile.defaultModelId ?? null,
              defaultThinkingLevel: profile.defaultThinkingLevel ?? "low",
              auth: getAuthStatus(profile.id),
              maxSubagentDepth: profile.maxSubagentDepth ?? null,
            }));

            if (input.format === "json") {
              return {
                activeProfileId: activeProfile.id,
                profiles: items,
                count: items.length,
              };
            }

            return [
              `Active profile: ${activeProfile.id}`,
              "Launchable subagent profiles:",
              ...items.map((profile) =>
                [
                  `- ${profile.id}`,
                  `(${profile.name})`,
                  `roles=${profile.roles.join(",")}`,
                  `memory=${profile.memoryNamespace}`,
                  profile.shellUser ? `shellUser=${profile.shellUser}` : "",
                  `execution=${profile.executionKind}`,
                  profile.executionTarget ? `target=${profile.executionTarget}` : "",
                  profile.pathRoots.length > 0 ? `roots=${profile.pathRoots.join(",")}` : "",
                  profile.preferredProvider ? `provider=${profile.preferredProvider}` : "",
                  profile.defaultModelId ? `model=${profile.defaultModelId}` : "",
                  `thinking=${profile.defaultThinkingLevel}`,
                  `auth=${profile.auth.any
                    ? [profile.auth.codex ? "codex" : "", profile.auth.claude ? "claude" : ""]
                      .filter(Boolean)
                      .join(",")
                    : "missing"}`,
                  `maxDepth=${profile.maxSubagentDepth ?? 1}`,
                ]
                  .filter(Boolean)
                  .join(" "),
              ),
            ].join("\n");
          },
          { attributes: { format: input.format } },
        ),
      {
        name: "profile_list_launchable",
        description:
          "List the profiles the active agent is authorized to launch, including current default model, thinking, and auth status.",
        schema: listLaunchableProfilesSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.profile_set_defaults",
          async () => {
            ctx.access.assertSpawnProfile(input.profileId);
            const targetProfile = ctx.access.listLaunchableProfiles()
              .find((profile) => profile.id === input.profileId);
            if (!targetProfile) {
              throw new Error(`Profile not found or not launchable: ${input.profileId}`);
            }

            let providerId: ModelProviderId | undefined;
            let resolvedModelId: string | undefined;
            let resolutionLine = "";

            if (input.modelId) {
              const targetModels = new ModelService(targetProfile);
              const selection = await resolveProfileModelSelection(
                targetProfile,
                targetModels,
                input.modelId,
                input.provider as ModelProviderId | undefined,
              );
              providerId = selection.providerId;
              const resolved = selection.resolved;
              if (!resolved.supported) {
                throw new Error(
                  `Model ${providerId}/${resolved.modelId} is listed by the provider but is not supported by the current runtime.`,
                );
              }
              resolvedModelId = resolved.modelId;
              resolutionLine = input.modelId !== resolved.modelId
                ? `Resolved "${input.modelId}" to ${resolved.modelId}.`
                : `Default model set to ${resolved.modelId}.`;
            }

            const profileService = new ProfileService(ctx.access.getProfile().id);
            const updated = profileService.setProfileDefaults(targetProfile.id, {
              preferredProvider: providerId,
              defaultModelId: resolvedModelId,
              defaultThinkingLevel: input.thinkingLevel as ThinkingLevel | undefined,
            });

            new ModelService(updated, {
              selectionStoreKey: updated.id,
            }).setStoredSelectionDefaults({
              ...(providerId && resolvedModelId ? { providerId, modelId: resolvedModelId } : {}),
              ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel as ThinkingLevel } : {}),
            });

            new ModelService(updated, {
              selectionStoreKey: `${updated.id}:subagent`,
              defaultSelectionOverride: {
                providerId: updated.subagentPreferredProvider ?? updated.preferredProvider,
                modelId: updated.subagentDefaultModelId ?? updated.defaultModelId,
              },
            }).setStoredSelectionDefaults({
              ...((resolvedModelId || providerId)
                ? {
                    providerId: updated.subagentPreferredProvider ?? providerId ?? updated.preferredProvider,
                    modelId: updated.subagentDefaultModelId ?? resolvedModelId ?? updated.defaultModelId,
                  }
                : {}),
              ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel as ThinkingLevel } : {}),
            });

            return [
              `Updated profile ${updated.id}.`,
              resolutionLine,
              providerId ? `Preferred provider: ${providerId}.` : "",
              input.thinkingLevel ? `Default thinking level: ${input.thinkingLevel}.` : "",
            ]
              .filter(Boolean)
              .join("\n");
          },
          { attributes: input },
        ),
      {
        name: "profile_set_defaults",
        description:
          "Update one launchable profile's persisted default model and/or thinking level, and sync its stored active selection.",
        schema: setProfileDefaultsSchema,
      },
    ),
  ];

  // Tickets tools (feature-gated)
  if (ctx.featureConfig.isActive("tickets")) {
    tools.push(
      defineTool(
        async (input) =>
          traceSpan(
            "tool.tickets_list",
            async () => {
              ensureTicketsConfigured(ctx.tickets);
              const result = await ctx.tickets.listTickets({
                statuses: input.statuses?.length ? input.statuses : [...ELINARO_DEFAULT_VISIBLE_TICKET_STATUSES],
                priority: input.priority,
                label: input.label,
                query: input.query,
                sort: input.sort,
                order: input.order,
              });
              if (result.tickets.length === 0) {
                return "No Elinaro tickets matched.";
              }
              return [
                `Showing ${result.tickets.length} of ${result.total} ticket(s):`,
                ...result.tickets.map((ticket) => `- ${formatTicketLine(ticket)}`),
              ].join("\n");
            },
            { attributes: input },
          ),
        {
          name: "tickets_list",
          description:
            "List Elinaro Tickets with optional status, priority, label, query, and sort filters. Defaults to active statuses only; closed statuses like done and wontfix only appear when you include them explicitly in statuses.",
          schema: listElinaroTicketsSchema,
        },
      ),
      defineTool(
        async (input) =>
          traceSpan(
            "tool.tickets_get",
            async () => {
              ensureTicketsConfigured(ctx.tickets);
              const ticket = await ctx.tickets.getTicket(input.id);
              return formatTicketDetail(ticket);
            },
            { attributes: input },
          ),
        {
          name: "tickets_get",
          description: "Get one Elinaro ticket by id.",
          schema: idSchema,
        },
      ),
      defineTool(
        async (input) =>
          traceSpan(
            "tool.tickets_create",
            async () => {
              ensureTicketsConfigured(ctx.tickets);
              const ticket = await ctx.tickets.createTicket({
                title: input.title,
                description: input.description,
                status: input.status,
                priority: input.priority,
                labels: input.labels,
              });
              return `Created ticket:\n${formatTicketDetail(ticket)}`;
            },
            { attributes: input },
          ),
        {
          name: "tickets_create",
          description: "Create a new Elinaro ticket with title, priority, optional description, labels, and status.",
          schema: createElinaroTicketSchema,
        },
      ),
      defineTool(
        async (input) =>
          traceSpan(
            "tool.tickets_update",
            async () => {
              ensureTicketsConfigured(ctx.tickets);
              const ticket = await ctx.tickets.updateTicket(input.id, {
                title: input.title,
                description: input.description,
                status: input.status,
                priority: input.priority,
                labels: input.labels,
              });
              return `Updated ticket:\n${formatTicketDetail(ticket)}`;
            },
            { attributes: input },
          ),
        {
          name: "tickets_update",
          description: "Update an existing Elinaro ticket's title, description, status, priority, or labels.",
          schema: updateElinaroTicketSchema,
        },
      ),
    );
  }

  return tools;
}
