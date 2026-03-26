import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProfileRecord } from "../domain/profiles";
import type { JobRecord, ProjectRecord } from "../domain/projects";
import { ProfileService } from "./profile-service";
import { ProjectsService } from "./projects-service";

let runtimeRoot = "";
let previousRootDirEnv: string | undefined;

function makeProfile(overrides: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: "root",
    name: "Root",
    roles: ["root"],
    memoryNamespace: "root",
    ...overrides,
  };
}

function writeProfileRegistry(rootDir: string, profiles?: ProfileRecord[]) {
  fs.mkdirSync(path.join(rootDir, ".openelinarotest", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, ".openelinarotest", "profiles/registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: profiles ?? [
        makeProfile(),
        makeProfile({ id: "restricted", name: "Restricted", roles: ["restricted"], memoryNamespace: "restricted" }),
      ],
    }, null, 2)}\n`,
  );
}

function writeProjectsRegistry(rootDir: string, projects?: ProjectRecord[], jobs?: JobRecord[]) {
  fs.mkdirSync(path.join(rootDir, ".openelinarotest", "projects"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, ".openelinarotest", "projects/registry.json"),
    `${JSON.stringify({
      version: 1,
      jobs: jobs ?? [
        {
          id: "client-job",
          name: "Client Work",
          status: "active",
          priority: "high",
          summary: "Client work.",
          tags: ["client"],
        },
      ],
      projects: projects ?? [
        {
          id: "alpha",
          name: "Alpha",
          status: "active",
          jobId: "client-job",
          priority: "high",
          allowedRoles: ["restricted"],
          workspacePath: "/workspace/alpha",
          summary: "Alpha project.",
          currentState: "Active.",
          state: "Active.",
          future: "Grow.",
          nextFocus: ["Ship v1."],
          structure: ["README.md"],
          tags: ["client"],
          docs: { readme: "projects/alpha/README.md" },
        },
        {
          id: "beta",
          name: "Beta",
          status: "active",
          priority: "low",
          allowedRoles: [],
          workspacePath: "/workspace/beta",
          summary: "Beta project.",
          currentState: "Research.",
          state: "Research.",
          future: "Explore.",
          nextFocus: ["Research options."],
          structure: ["README.md"],
          tags: ["personal"],
          docs: { readme: "projects/beta/README.md" },
        },
        {
          id: "archived-proj",
          name: "Archived",
          status: "archived",
          priority: "low",
          allowedRoles: [],
          workspacePath: "/workspace/archived",
          summary: "Archived project.",
          currentState: "Done.",
          state: "Done.",
          future: "None.",
          nextFocus: ["None."],
          structure: ["README.md"],
          tags: [],
          docs: { readme: "projects/archived/README.md" },
        },
      ],
    }, null, 2)}\n`,
  );
}

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-projects-test-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  writeProfileRegistry(runtimeRoot);
  writeProjectsRegistry(runtimeRoot);
});

afterEach(() => {
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = "";
});

describe("ProjectsService", () => {
  test("loadRegistry returns projects and jobs", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const registry = service.loadRegistry();
    expect(registry.projects).toHaveLength(3);
    expect(registry.jobs).toHaveLength(1);
  });

  test("loadRegistry returns empty when no registry file exists", () => {
    fs.rmSync(path.join(runtimeRoot, ".openelinarotest", "projects"), { recursive: true, force: true });
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const registry = service.loadRegistry();
    expect(registry.projects).toHaveLength(0);
    expect(registry.jobs).toHaveLength(0);
  });

  test("listAllProjects returns sorted projects", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const projects = service.listAllProjects();
    expect(projects[0]!.id).toBe("alpha");
    expect(projects[1]!.id).toBe("beta");
    expect(projects[2]!.id).toBe("archived-proj");
  });

  test("listAllJobs returns all jobs", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const jobs = service.listAllJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe("client-job");
  });

  test("listProjects filters by status", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const active = service.listProjects({ status: "active" });
    expect(active.every((p) => p.status === "active")).toBe(true);
    expect(active).toHaveLength(2);

    const archived = service.listProjects({ status: "archived" });
    expect(archived).toHaveLength(1);
    expect(archived[0]!.id).toBe("archived-proj");
  });

  test("listProjects filters by scope", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const work = service.listProjects({ scope: "work" });
    expect(work.every((p) => p.jobId !== undefined)).toBe(true);
    expect(work).toHaveLength(1);

    const personal = service.listProjects({ scope: "personal" });
    expect(personal.every((p) => p.jobId === undefined)).toBe(true);
  });

  test("listProjects filters by jobId", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const projects = service.listProjects({ jobId: "client-job" });
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe("alpha");
  });

  test("listProjects respects limit", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const projects = service.listProjects({ status: "all", limit: 1 });
    expect(projects).toHaveLength(1);
  });

  test("listProjects respects profile role restrictions", () => {
    const profiles = new ProfileService("restricted");
    const restricted = profiles.getActiveProfile();
    const service = new ProjectsService(restricted, profiles);
    const projects = service.listProjects({ status: "all" });
    expect(projects.every((p) => p.allowedRoles.includes("restricted"))).toBe(true);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe("alpha");
  });

  test("getProject returns a specific project", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const project = service.getProject("alpha");
    expect(project?.id).toBe("alpha");
  });

  test("getProject returns undefined for unknown project", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    expect(service.getProject("missing")).toBeUndefined();
  });

  test("getProject respects role restrictions", () => {
    const profiles = new ProfileService("restricted");
    const restricted = profiles.getActiveProfile();
    const service = new ProjectsService(restricted, profiles);
    expect(service.getProject("beta")).toBeUndefined();
    expect(service.getProject("alpha")?.id).toBe("alpha");
  });

  test("getJob returns a specific job", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const job = service.getJob("client-job");
    expect(job?.id).toBe("client-job");
  });

  test("getJob returns undefined for unknown job", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    expect(service.getJob("missing")).toBeUndefined();
  });

  test("getProjectJob returns the job for a project", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const project = service.getProject("alpha")!;
    const job = service.getProjectJob(project);
    expect(job?.id).toBe("client-job");
  });

  test("getProjectJob returns undefined when project has no jobId", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const project = service.getProject("beta")!;
    expect(service.getProjectJob(project)).toBeUndefined();
  });

  test("resolveWorkspacePath returns override when present", () => {
    const profile = makeProfile({ id: "custom" });
    writeProfileRegistry(runtimeRoot, [
      makeProfile(),
      profile,
    ]);
    writeProjectsRegistry(runtimeRoot, [
      {
        id: "proj",
        name: "Project",
        status: "active",
        priority: "high",
        allowedRoles: [],
        workspacePath: "/default/path",
        workspaceOverrides: { custom: "/custom/path" },
        summary: "A project.",
        currentState: "Active.",
        state: "Active.",
        future: "Grow.",
        nextFocus: ["Focus."],
        structure: ["README.md"],
        tags: [],
        docs: { readme: "projects/proj/README.md" },
      },
    ]);
    const profiles = new ProfileService("custom");
    const service = new ProjectsService(profile, profiles);
    const project = service.getProject("proj")!;
    expect(service.resolveWorkspacePath(project)).toBe("/custom/path");
  });

  test("resolveWorkspacePath returns workspacePath when no override", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const project = service.getProject("alpha")!;
    expect(service.resolveWorkspacePath(project)).toBe("/workspace/alpha");
  });

  test("canAccessProject checks profile roles", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const project = service.getProject("alpha")!;
    expect(service.canAccessProject(project)).toBe(true);
  });

  test("listJobs filters by status", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const active = service.listJobs({ status: "active" });
    expect(active).toHaveLength(1);
    const archived = service.listJobs({ status: "archived" });
    expect(archived).toHaveLength(0);
  });

  test("listJobs respects limit", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const jobs = service.listJobs({ status: "all", limit: 0 });
    expect(jobs).toHaveLength(0);
  });

  test("buildAssistantContext includes active projects", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const context = service.buildAssistantContext();
    expect(context).toContain("alpha");
    expect(context).toContain("beta");
    expect(context).not.toContain("archived-proj");
  });

  test("buildAssistantContext reports no projects when empty", () => {
    fs.rmSync(path.join(runtimeRoot, ".openelinarotest", "projects"), { recursive: true, force: true });
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const context = service.buildAssistantContext();
    expect(context).toContain("no projects are registered");
  });

  test("formatProject produces a multi-line description", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const project = service.getProject("alpha")!;
    const formatted = service.formatProject(project);
    expect(formatted).toContain("Project: alpha");
    expect(formatted).toContain("Status: active");
    expect(formatted).toContain("Scope: work");
    expect(formatted).toContain("Alpha project.");
  });

  test("formatJob produces a multi-line description", () => {
    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const job = service.getJob("client-job")!;
    const formatted = service.formatJob(job);
    expect(formatted).toContain("Job: client-job");
    expect(formatted).toContain("Status: active");
    expect(formatted).toContain("Client work.");
  });

  test("loadRegistry skips invalid project entries and returns valid ones", () => {
    const registryPath = path.join(runtimeRoot, ".openelinarotest", "projects", "registry.json");
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    // Insert an invalid project (missing required fields like state, future)
    raw.projects.push({ id: "broken", name: "Broken" });
    fs.writeFileSync(registryPath, JSON.stringify(raw, null, 2));

    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const registry = service.loadRegistry();
    // The 3 valid projects survive; the broken one is skipped
    expect(registry.projects).toHaveLength(3);
    expect(registry.projects.find((p) => p.id === "broken")).toBeUndefined();
  });

  test("loadRegistry skips invalid job entries and returns valid ones", () => {
    const registryPath = path.join(runtimeRoot, ".openelinarotest", "projects", "registry.json");
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    raw.jobs.push({ id: "bad-job" });
    fs.writeFileSync(registryPath, JSON.stringify(raw, null, 2));

    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const registry = service.loadRegistry();
    expect(registry.jobs).toHaveLength(1);
    expect(registry.jobs.find((j) => j.id === "bad-job")).toBeUndefined();
  });

  test("loadRegistry returns empty arrays when all entries are invalid", () => {
    const registryPath = path.join(runtimeRoot, ".openelinarotest", "projects", "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify({
      version: 1,
      jobs: [{}],
      projects: [{}, { id: "also-broken" }],
    }, null, 2));

    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    const registry = service.loadRegistry();
    expect(registry.projects).toHaveLength(0);
    expect(registry.jobs).toHaveLength(0);
  });

  test("loadRegistry still throws on corrupted envelope", () => {
    const registryPath = path.join(runtimeRoot, ".openelinarotest", "projects", "registry.json");
    fs.writeFileSync(registryPath, JSON.stringify({ version: "not-a-number" }));

    const profiles = new ProfileService("root");
    const service = new ProjectsService(profiles.getActiveProfile(), profiles);
    expect(() => service.loadRegistry()).toThrow();
  });
});
