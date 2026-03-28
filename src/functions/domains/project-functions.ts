/**
 * Project, job, profile, and ticket function definitions.
 * Migrated from src/tools/groups/project-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import type { JobStatus, ProjectStatus } from "../../domain/projects";
import { NotFoundError } from "../../domain/errors";
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
} from "../../services/models/model-service";
import type { ThinkingLevel } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Shared schemas (same as project-tools.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureTicketsConfigured(tickets: { getConfigurationError(): string | null }) {
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

      if (error instanceof NotFoundError) {
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
    throw new NotFoundError(
      "Model",
      `${requestedModelId} (no configured provider catalog for profile ${targetProfile.id})`,
    );
  }

  throw new NotFoundError("Model", requestedModelId);
}

// ---------------------------------------------------------------------------
// Auth defaults
// ---------------------------------------------------------------------------

const PROJECT_AUTH = { access: "anyone" as const, behavior: "role-sensitive" as const };
const PROJECT_SCOPES: ("chat" | "coding-planner" | "coding-worker" | "direct")[] = ["chat", "coding-planner", "coding-worker", "direct"];
const PROJECT_DOMAINS = ["projects", "work"];

const TICKET_AUTH = { access: "anyone" as const, behavior: "uniform" as const };

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildProjectFunctions: FunctionDomainBuilder = (ctx) => {
  const fns = [
    // -----------------------------------------------------------------------
    // job_list
    // -----------------------------------------------------------------------
    defineFunction({
      name: "job_list",
      description:
        "List known jobs or clients from ~/.openelinaro/projects/registry.json, including status, priority, and summary.",
      input: listJobSchema,
      handler: async (input, fnCtx) => {
        const jobs = fnCtx.services.projects.listJobs({
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
      auth: { ...PROJECT_AUTH, note: "Only jobs attached to accessible projects are listed." },
      domains: PROJECT_DOMAINS,
      agentScopes: PROJECT_SCOPES,
    }),

    // -----------------------------------------------------------------------
    // job_get
    // -----------------------------------------------------------------------
    defineFunction({
      name: "job_get",
      description:
        "Get one known job or client, including status, priority, summary, and availability blocks.",
      input: idSchema,
      handler: async (input, fnCtx) => {
        const job = fnCtx.services.projects.getJob(input.id);
        if (!job) {
          throw new Error(`Job not found: ${input.id}`);
        }
        return fnCtx.services.projects.formatJob(job);
      },
      auth: { ...PROJECT_AUTH, note: "Only jobs attached to accessible projects are readable." },
      domains: PROJECT_DOMAINS,
      agentScopes: PROJECT_SCOPES,
    }),

    // -----------------------------------------------------------------------
    // work_summary
    // -----------------------------------------------------------------------
    defineFunction({
      name: "work_summary",
      description:
        "Show the current work-time context, active jobs, top projects, current focus, and ranked next work items.",
      input: workSummarySchema,
      handler: async (input, fnCtx) => {
        const snapshot = fnCtx.services.workPlanning.getSnapshot();
        if (input.format === "json") {
          return JSON.stringify(snapshot, null, 2);
        }
        return fnCtx.services.workPlanning.buildSummary();
      },
      auth: { ...PROJECT_AUTH, note: "Work summaries only include projects and jobs visible to the active profile." },
      domains: PROJECT_DOMAINS,
      agentScopes: PROJECT_SCOPES,
    }),

    // -----------------------------------------------------------------------
    // project_list
    // -----------------------------------------------------------------------
    defineFunction({
      name: "project_list",
      description:
        "List known projects from ~/.openelinaro/projects/registry.json, including personal vs work scope, status, summary, and workspace path.",
      input: listProjectSchema,
      handler: async (input, fnCtx) => {
        const projects = fnCtx.services.projects.listProjects({
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
            `workspace=${fnCtx.services.projects.resolveWorkspacePath(project)}`,
          ].join(" ")).join("\n");
      },
      auth: { ...PROJECT_AUTH, note: "Only projects allowed by role are listed." },
      domains: PROJECT_DOMAINS,
      agentScopes: PROJECT_SCOPES,
    }),

    // -----------------------------------------------------------------------
    // project_get
    // -----------------------------------------------------------------------
    defineFunction({
      name: "project_get",
      description:
        "Get one known project, including current state, next focus, workspace path, README location, and embedded state/future/milestone content from the registry.",
      input: idSchema,
      handler: async (input, fnCtx) => {
        const project = fnCtx.services.projects.getProject(input.id);
        if (!project) {
          throw new Error(`Project not found: ${input.id}`);
        }
        return fnCtx.services.projects.formatProject(project);
      },
      auth: { ...PROJECT_AUTH, note: "Only projects allowed by role are readable." },
      domains: PROJECT_DOMAINS,
      agentScopes: PROJECT_SCOPES,
    }),

    // -----------------------------------------------------------------------
    // profile_list_launchable
    // -----------------------------------------------------------------------
    defineFunction({
      name: "profile_list_launchable",
      description:
        "List the profiles the active agent is authorized to launch, including current default model, thinking, and auth status.",
      input: listLaunchableProfilesSchema,
      handler: async (input, fnCtx) => {
        const activeProfile = fnCtx.services.access.getProfile();
        const profiles = fnCtx.services.access.listLaunchableProfiles();
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
      auth: { ...PROJECT_AUTH, note: "Returned profiles are limited to subagent targets the active profile can launch." },
      domains: PROJECT_DOMAINS,
      agentScopes: PROJECT_SCOPES,
    }),

    // -----------------------------------------------------------------------
    // profile_set_defaults
    // -----------------------------------------------------------------------
    defineFunction({
      name: "profile_set_defaults",
      description:
        "Update one launchable profile's persisted default model and/or thinking level, and sync its stored active selection.",
      input: setProfileDefaultsSchema,
      handler: async (input, fnCtx) => {
        fnCtx.services.access.assertSpawnProfile(input.profileId);
        const targetProfile = fnCtx.services.access.listLaunchableProfiles()
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

        const profileService = new ProfileService(fnCtx.services.access.getProfile().id);
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
      auth: { ...PROJECT_AUTH, note: "Only launchable target profiles can be updated, and model ids are validated against the target profile's live provider catalog before both profile defaults and stored runtime selection are synced." },
      domains: PROJECT_DOMAINS,
      agentScopes: PROJECT_SCOPES,
      mutatesState: true,
    }),

    // -----------------------------------------------------------------------
    // tickets_list (feature-gated)
    // -----------------------------------------------------------------------
    defineFunction({
      name: "tickets_list",
      description:
        "List Elinaro Tickets with optional status, priority, label, query, and sort filters. Defaults to active statuses only; closed statuses like done and wontfix only appear when you include them explicitly in statuses.",
      input: listElinaroTicketsSchema,
      handler: async (input, fnCtx) => {
        ensureTicketsConfigured(fnCtx.services.tickets);
        const result = await fnCtx.services.tickets.listTickets({
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
      auth: { ...TICKET_AUTH, note: "Reads the external Elinaro Tickets tracker through the configured API URL or SSH tunnel." },
      domains: PROJECT_DOMAINS,
      agentScopes: ["chat", "direct"],
      featureGate: "tickets",
    }),

    // -----------------------------------------------------------------------
    // tickets_get (feature-gated)
    // -----------------------------------------------------------------------
    defineFunction({
      name: "tickets_get",
      description: "Get one Elinaro ticket by id.",
      input: idSchema,
      handler: async (input, fnCtx) => {
        ensureTicketsConfigured(fnCtx.services.tickets);
        const ticket = await fnCtx.services.tickets.getTicket(input.id);
        return formatTicketDetail(ticket);
      },
      auth: { ...TICKET_AUTH, note: "Reads one ticket from the external Elinaro Tickets tracker." },
      domains: PROJECT_DOMAINS,
      agentScopes: ["chat", "direct"],
      featureGate: "tickets",
    }),

    // -----------------------------------------------------------------------
    // tickets_create (feature-gated)
    // -----------------------------------------------------------------------
    defineFunction({
      name: "tickets_create",
      description: "Create a new Elinaro ticket with title, priority, optional description, labels, and status.",
      input: createElinaroTicketSchema,
      handler: async (input, fnCtx) => {
        ensureTicketsConfigured(fnCtx.services.tickets);
        const ticket = await fnCtx.services.tickets.createTicket({
          title: input.title,
          description: input.description,
          status: input.status,
          priority: input.priority,
          labels: input.labels,
        });
        return `Created ticket:\n${formatTicketDetail(ticket)}`;
      },
      auth: { ...TICKET_AUTH, note: "Creates a ticket in the external Elinaro Tickets tracker." },
      domains: PROJECT_DOMAINS,
      agentScopes: ["chat", "direct"],
      featureGate: "tickets",
      mutatesState: true,
    }),

    // -----------------------------------------------------------------------
    // tickets_update (feature-gated)
    // -----------------------------------------------------------------------
    defineFunction({
      name: "tickets_update",
      description: "Update an existing Elinaro ticket's title, description, status, priority, or labels.",
      input: updateElinaroTicketSchema,
      handler: async (input, fnCtx) => {
        ensureTicketsConfigured(fnCtx.services.tickets);
        const ticket = await fnCtx.services.tickets.updateTicket(input.id, {
          title: input.title,
          description: input.description,
          status: input.status,
          priority: input.priority,
          labels: input.labels,
        });
        return `Updated ticket:\n${formatTicketDetail(ticket)}`;
      },
      auth: { ...TICKET_AUTH, note: "Updates a ticket in the external Elinaro Tickets tracker." },
      domains: PROJECT_DOMAINS,
      agentScopes: ["chat", "direct"],
      featureGate: "tickets",
      mutatesState: true,
    }),
  ];

  return fns;
};
