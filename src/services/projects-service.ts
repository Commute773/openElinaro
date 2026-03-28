import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { JobRecord, JobStatus, ProjectRecord, ProjectScope, ProjectStatus } from "../domain/projects";
import { JobRecordSchema, ProjectRecordSchema, resolveProjectScope } from "../domain/projects";
import type { ProfileRecord } from "../domain/profiles";
import { ProfileService } from "./profiles";
import { getRuntimeRootDir, resolveServicePath, resolveUserDataPath } from "./runtime-root";
import { telemetry } from "./infrastructure/telemetry";

/** Envelope schema — validates structure but defers per-entry validation to loadRegistry(). */
const RegistryEnvelopeSchema = z.object({
  version: z.number().int().positive(),
  description: z.string().min(1).optional(),
  jobs: z.array(z.unknown()).max(64).default([]),
  projects: z.array(z.unknown()),
});

const ASSISTANT_CONTEXT_LIMIT = 4;

function statusRank(status: ProjectStatus) {
  switch (status) {
    case "active":
      return 0;
    case "paused":
      return 1;
    case "idea":
      return 2;
    case "archived":
      return 3;
  }
}

function jobStatusRank(status: JobStatus) {
  switch (status) {
    case "active":
      return 0;
    case "paused":
      return 1;
    case "archived":
      return 2;
  }
}

function compareProjects(left: ProjectRecord, right: ProjectRecord) {
  const statusDelta = statusRank(left.status) - statusRank(right.status);
  if (statusDelta !== 0) {
    return statusDelta;
  }
  return left.name.localeCompare(right.name);
}

function compareJobs(left: JobRecord, right: JobRecord) {
  const statusDelta = jobStatusRank(left.status) - jobStatusRank(right.status);
  if (statusDelta !== 0) {
    return statusDelta;
  }
  return left.name.localeCompare(right.name);
}

export class ProjectsService {
  constructor(
    private readonly profile: ProfileRecord,
    private readonly profiles = new ProfileService(profile.id),
    private readonly repoRoot = getRuntimeRootDir(),
  ) {}

  private getProjectsRoot() {
    return resolveUserDataPath("projects");
  }

  private getBundledProjectsRoot() {
    return resolveServicePath("projects");
  }

  private getProjectRegistryPath() {
    return path.join(this.getProjectsRoot(), "registry.json");
  }

  loadRegistry() {
    const projectsRoot = this.getProjectsRoot();
    const bundledProjectsRoot = this.getBundledProjectsRoot();
    const projectRegistryPath = this.getProjectRegistryPath();
    fs.mkdirSync(projectsRoot, { recursive: true });
    if (!fs.existsSync(projectRegistryPath)) {
      if (fs.existsSync(path.join(bundledProjectsRoot, "registry.json"))) {
        fs.cpSync(bundledProjectsRoot, projectsRoot, { recursive: true });
      }
    }
    if (!fs.existsSync(projectRegistryPath)) {
      return {
        version: 1,
        jobs: [],
        projects: [],
      };
    }

    const raw = fs.readFileSync(projectRegistryPath, "utf8");
    const envelope = RegistryEnvelopeSchema.parse(JSON.parse(raw));

    const projects: ProjectRecord[] = [];
    let skippedProjects = 0;
    for (const entry of envelope.projects) {
      const result = ProjectRecordSchema.safeParse(entry);
      if (result.success) {
        projects.push(result.data);
      } else {
        skippedProjects++;
        const id = typeof entry === "object" && entry !== null && "id" in entry
          ? String((entry as Record<string, unknown>).id)
          : "(unknown)";
        telemetry.event("projects.project_skipped", {
          profileId: this.profile.id,
          entityType: "project_registry",
          entityId: id,
          error: result.error.message,
        }, {
          level: "warn",
          message: `Skipped invalid project entry ${id}: ${result.error.message}`,
        });
      }
    }

    const jobs: JobRecord[] = [];
    let skippedJobs = 0;
    for (const entry of envelope.jobs) {
      const result = JobRecordSchema.safeParse(entry);
      if (result.success) {
        jobs.push(result.data);
      } else {
        skippedJobs++;
        const id = typeof entry === "object" && entry !== null && "id" in entry
          ? String((entry as Record<string, unknown>).id)
          : "(unknown)";
        telemetry.event("projects.job_skipped", {
          profileId: this.profile.id,
          entityType: "project_registry",
          entityId: id,
          error: result.error.message,
        }, {
          level: "warn",
          message: `Skipped invalid job entry ${id}: ${result.error.message}`,
        });
      }
    }

    const registry = {
      version: envelope.version,
      ...(envelope.description !== undefined ? { description: envelope.description } : {}),
      jobs,
      projects,
    };

    telemetry.event("projects.registry_loaded", {
      profileId: this.profile.id,
      entityType: "project_registry",
      entityId: "default",
      projectCount: projects.length,
      skippedProjects,
      jobCount: jobs.length,
      skippedJobs,
    });

    return registry;
  }

  listAllProjects() {
    return this.loadRegistry().projects.sort(compareProjects);
  }

  listAllJobs() {
    return this.loadRegistry().jobs.sort(compareJobs);
  }

  canAccessProject(project: ProjectRecord) {
    return this.profiles.canAccessProject(this.profile, project);
  }

  listProjects(filters?: {
    status?: ProjectStatus | "all";
    limit?: number;
    jobId?: string;
    scope?: ProjectScope | "all";
  }) {
    const projects = this.profiles.filterProjects(this.profile, this.loadRegistry().projects)
      .filter((project) =>
        !filters?.status || filters.status === "all" || project.status === filters.status)
      .filter((project) => !filters?.jobId || project.jobId === filters.jobId)
      .filter((project) =>
        !filters?.scope || filters.scope === "all" || resolveProjectScope(project) === filters.scope)
      .sort(compareProjects);

    return typeof filters?.limit === "number" ? projects.slice(0, filters.limit) : projects;
  }

  listJobs(filters?: {
    status?: JobStatus | "all";
    limit?: number;
  }) {
    const accessibleJobIds = new Set(
      this.profiles
        .filterProjects(this.profile, this.loadRegistry().projects)
        .map((project) => project.jobId)
        .filter((jobId): jobId is string => Boolean(jobId)),
    );
    const jobs = this.loadRegistry().jobs
      .filter((job) => this.profiles.isRootProfile(this.profile) || accessibleJobIds.has(job.id))
      .filter((job) =>
        !filters?.status || filters.status === "all" || job.status === filters.status)
      .sort(compareJobs);

    return typeof filters?.limit === "number" ? jobs.slice(0, filters.limit) : jobs;
  }

  getProject(id: string) {
    return this.profiles
      .filterProjects(this.profile, this.loadRegistry().projects)
      .find((project) => project.id === id);
  }

  getJob(id: string) {
    return this.listJobs({ status: "all" }).find((job) => job.id === id);
  }

  getProjectJob(project: Pick<ProjectRecord, "jobId">) {
    if (!project.jobId) {
      return undefined;
    }
    return this.getJob(project.jobId);
  }

  resolveWorkspacePath(project: ProjectRecord) {
    const override = project.workspaceOverrides?.[this.profile.id]?.trim();
    return override || project.workspacePath;
  }

  resolveDocPath(project: ProjectRecord) {
    return path.join(resolveUserDataPath(), project.docs.readme);
  }

  buildAssistantContext() {
    const projects = this.listProjects({
      status: "active",
      limit: ASSISTANT_CONTEXT_LIMIT,
    });

    if (projects.length === 0) {
      return [
        "Project context: no projects are registered.",
        "Project registry SSOT: ~/.openelinaro/projects/registry.json.",
      ].join("\n");
    }

    return [
      "Project context:",
      ...projects.map((project) =>
        `- ${project.id} [${project.status}/${resolveProjectScope(project)}/${project.priority}]${project.jobId ? ` job=${project.jobId}` : ""} ${project.summary} Current state: ${project.currentState}${project.milestone ? ` Current milestone: ${project.milestone.split("\n")[0]}` : ""} Next focus: ${project.nextFocus.slice(0, 2).join("; ")} Workspace: ${this.resolveWorkspacePath(project)}`),
      "Project structure convention: ~/.openelinaro/projects/<id>/README.md plus long-form state, future, and milestone content embedded in ~/.openelinaro/projects/registry.json.",
      "Project scope convention: projects with a jobId are work projects; projects without a jobId are personal projects.",
    ].join("\n");
  }

  formatProject(project: ProjectRecord) {
    const job = this.getProjectJob(project);
    return [
      `Project: ${project.id}`,
      `Name: ${project.name}`,
      `Status: ${project.status}`,
      `Scope: ${resolveProjectScope(project)}`,
      `Priority: ${project.priority}`,
      job ? `Job: ${job.id} (${job.name})` : project.jobId ? `Job: ${project.jobId}` : "",
      `Allowed roles: ${project.allowedRoles.join(", ") || "(root only)"}`,
      `Workspace: ${this.resolveWorkspacePath(project)}`,
      `Summary: ${project.summary}`,
      `Current state: ${project.currentState}`,
      project.tags.length > 0 ? `Tags: ${project.tags.join(", ")}` : "",
      "Next focus:",
      ...project.nextFocus.map((entry) => `- ${entry}`),
      "Structure:",
      ...project.structure.map((entry) => `- ${entry}`),
      `README: ${this.resolveDocPath(project)}`,
      "State:",
      project.state,
      project.milestone ? "Milestone:" : "",
      project.milestone ?? "",
      "Future:",
      project.future,
      ...(project.sourceDocs?.length
        ? [
            "Copied from:",
            ...project.sourceDocs.map((entry) => `- ${entry}`),
          ]
        : []),
    ]
      .filter(Boolean)
      .join("\n");
  }

  formatJob(job: JobRecord) {
    return [
      `Job: ${job.id}`,
      `Name: ${job.name}`,
      `Status: ${job.status}`,
      `Priority: ${job.priority}`,
      `Summary: ${job.summary}`,
      job.tags.length > 0 ? `Tags: ${job.tags.join(", ")}` : "",
      ...(job.availabilityBlocks?.length
        ? [
            "Availability blocks:",
            ...job.availabilityBlocks.map((block) =>
              `- ${block.kind}: ${block.startAt} -> ${block.endAt}${block.note ? ` (${block.note})` : ""}`),
          ]
        : []),
    ]
      .filter(Boolean)
      .join("\n");
  }
}
