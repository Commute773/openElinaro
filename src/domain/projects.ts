import { z } from "zod";

export const ProjectStatusSchema = z.enum(["active", "paused", "idea", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
export type ProjectScope = "work" | "personal";

export const JobStatusSchema = z.enum(["active", "paused", "archived"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const WorkPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type WorkPriority = z.infer<typeof WorkPrioritySchema>;

export const JobAvailabilityBlockSchema = z.object({
  startAt: z.string().min(1),
  endAt: z.string().min(1),
  kind: z.enum(["vacation", "unavailable"]).default("unavailable"),
  note: z.string().min(1).optional(),
});
export type JobAvailabilityBlock = z.infer<typeof JobAvailabilityBlockSchema>;

export const JobRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: JobStatusSchema,
  priority: WorkPrioritySchema.default("medium"),
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).max(12).default([]),
  availabilityBlocks: z.array(JobAvailabilityBlockSchema).max(64).optional(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const ProjectDocsSchema = z.object({
  readme: z.string().min(1),
});
export type ProjectDocs = z.infer<typeof ProjectDocsSchema>;

export const ProjectRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: ProjectStatusSchema,
  jobId: z.string().min(1).optional(),
  priority: WorkPrioritySchema.default("medium"),
  allowedRoles: z.array(z.string().min(1)).max(12).default([]),
  workspacePath: z.string().min(1),
  workspaceOverrides: z.record(z.string().min(1), z.string().min(1)).optional(),
  summary: z.string().min(1),
  currentState: z.string().min(1),
  state: z.string().min(1),
  future: z.string().min(1),
  milestone: z.string().min(1).optional(),
  nextFocus: z.array(z.string().min(1)).max(8),
  structure: z.array(z.string().min(1)).min(1).max(8),
  tags: z.array(z.string().min(1)).max(12).default([]),
  docs: ProjectDocsSchema,
  sourceDocs: z.array(z.string().min(1)).max(12).optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const ProjectRegistrySchema = z.object({
  version: z.number().int().positive(),
  description: z.string().min(1).optional(),
  jobs: z.array(JobRecordSchema).max(64).default([]),
  projects: z.array(ProjectRecordSchema),
});
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

export function resolveProjectScope(project: Pick<ProjectRecord, "jobId">): ProjectScope {
  return project.jobId ? "work" : "personal";
}
