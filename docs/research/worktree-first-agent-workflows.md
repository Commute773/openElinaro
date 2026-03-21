# Worktree-First Agent Workflow Research

Date: 2026-03-12

## Recommendation

The best way to make Git worktrees first-class in this platform is to model them as explicit project workspace instances, not as anonymous `cwd` values and not as ad hoc shell scripts.

The platform should treat:

- the Git repository as the canonical project codebase
- the main checkout as one workspace instance
- each linked worktree as another workspace instance with its own path, branch, purpose, lease state, and lifecycle

That gives agents isolated mutable sandboxes for parallel work while keeping the project abstraction intact.

## What Git and agent tooling support today

Git already provides the primitives needed for this:

- `git worktree add` creates linked working trees on separate paths while sharing object storage with the main repository
- `git worktree list --porcelain` is the stable machine-readable interface for discovery
- `git worktree remove`, `prune`, `lock`, `unlock`, and `repair` cover cleanup and recovery
- Git stores some state per worktree and some in the shared common directory, so tooling should not infer repository layout by hand

The Git documentation also makes two implementation details important for this platform:

1. Worktree discovery should come from Git, not directory scanning.
2. Per-worktree config exists, but enabling `extensions.worktreeConfig` changes repository compatibility and should be an opt-in feature.

Anthropic’s official Claude Code docs now recommend parallel sessions with Git worktrees for independent tasks. That is the clearest current primary-source confirmation that agent workflows benefit from isolated worktrees rather than one shared checkout.

## Current repo findings

The current platform is close, but it does not yet have a first-class workspace-instance concept.

- [`src/domain/projects.ts`](../../src/domain/projects.ts) defines a project with one `workspacePath`
- [`src/domain/workflow-run.ts`](../../src/domain/workflow-run.ts) stores only `workspaceCwd?: string`
- [`src/services/access-control-service.ts`](../../src/services/access-control-service.ts) authorizes project paths against `project.workspacePath`, which will not automatically include linked worktrees outside that path
- [`src/tools/routine-tool-registry.ts`](../../src/tools/routine-tool-registry.ts) launches coding agents with raw `cwd`

So the main gap is architectural, not Git capability.

## Best platform model

Add a runtime concept like `ProjectWorkspaceInstance`:

- `id`
- `projectId`
- `kind`: `main` or `linked`
- `rootPath`
- `repoRootPath`
- `gitCommonDir`
- `branch`
- `headSha`
- `isDetached`
- `status`: `ready`, `active`, `blocked`, `orphaned`, `prunable`
- `purpose`
- `createdBy`
- `originRunId`
- `leaseOwner`
- `createdAt`
- `lastUsedAt`
- `cleanupPolicy`

Important design rule: Git remains the source of truth for real worktrees, while the platform stores only overlay metadata such as purpose, lease ownership, and cleanup preferences.

That means:

- discover actual worktrees from `git worktree list --porcelain -z`
- enrich them with local metadata from a platform store such as `~/.openelinaro/project-workspaces.json`
- never rely on the platform registry alone to decide what worktrees exist

## Best agent workflow pattern

Use these defaults:

1. Read-only or exploratory agent work can use the main workspace instance.
2. Any write-capable background agent should get its own linked worktree by default.
3. Parallel subagents should each get a separate linked worktree.
4. No two active agents should share the same mutable worktree.

This is the important behavior change. Worktrees should be the default isolation boundary for concurrent agent execution.

Recommended task flow:

1. Resolve a project.
2. Resolve or create a workspace instance for the task.
3. Lease that workspace instance to one run.
4. Run all filesystem and shell tools against the workspace instance root.
5. On completion, either:
   - keep the worktree if it is dirty or has a commit the user may want
   - auto-remove it if policy allows and it is clean

## API and tooling changes

Move the platform from path-first APIs to project/workspace-first APIs.

Recommended additions:

- `project_workspace_list(projectId)`
- `project_workspace_get(projectId, workspaceId)`
- `project_workspace_create(projectId, branch?, baseRef?, purpose?, cleanupPolicy?)`
- `project_workspace_remove(projectId, workspaceId, force?)`
- `project_workspace_status(projectId, workspaceId)`
- `project_workspace_repair(projectId)`

Recommended changes to existing flows:

- let `launch_coding_agent` accept `projectId` and `workspaceId`
- keep `cwd` only as a compatibility escape hatch
- persist `workspaceId` and `projectId` on `WorkflowRun`, not just `workspaceCwd`
- show branch, path, cleanliness, and lease state in workflow status output

## Access control changes

The current path-based access model should be extended to authorize all managed worktrees for an allowed project.

Concretely:

- keep project docs authorization as-is
- treat every discovered workspace instance for a permitted project as an allowed root
- reject unmanaged paths even if they happen to sit near the repo

Without this change, worktrees will either break non-root profiles or force the system to over-authorize arbitrary paths.

## Lifecycle and safety rules

These rules matter more than the creation command itself:

- Lease a linked worktree to exactly one active run at a time.
- Do not reuse a dirty linked worktree automatically.
- Prefer deterministic directory names, for example `<project>-<task-slug>-<short-id>`.
- Preserve worktrees with uncommitted changes or local commits until the user explicitly removes them.
- Periodically run `git worktree prune` and expose `repair` for moved paths.
- Do not use `git worktree lock` as the concurrency mechanism; use platform leases for that. Git’s lock is mainly for preventing pruning of special worktrees.

## Per-worktree config

Per-worktree config is useful for agent workflows, but should be phased in carefully.

Good uses:

- sparse-checkout for task-focused worktrees
- agent-specific excludes or local tool settings
- worktree-local branch or environment behavior

But because `extensions.worktreeConfig` affects repository compatibility, the platform should:

- detect Git version support
- gate this behind a project setting
- avoid enabling it silently on existing repositories

## Suggested storage model

Use a small local metadata store for managed workspace instances, for example:

- `~/.openelinaro/project-workspaces.json`

Suggested record shape:

- `workspaceId`
- `projectId`
- `path`
- `branch`
- `baseRef`
- `purpose`
- `originRunId`
- `leaseOwner`
- `cleanupPolicy`
- `createdAt`
- `lastUsedAt`
- `lastKnownHeadSha`

Again, this is metadata only. Discovery should still start with Git.

## Rollout order

### Phase 1

Introduce discovery and status without changing agent behavior:

- add a worktree-aware service
- parse `git worktree list --porcelain -z`
- show main plus linked worktrees in project output

### Phase 2

Add managed creation and removal:

- create linked worktrees through one platform service
- persist metadata and lease state
- update access control to recognize managed worktrees

### Phase 3

Make agent runs worktree-first:

- default `launch_coding_agent` to isolated linked worktrees for write tasks
- store `projectId` and `workspaceId` on runs
- propagate workspace identity into prompts, logs, and status output

### Phase 4

Add advanced workflows:

- subagent fan-out into sibling worktrees
- optional sparse-checkout
- cleanup automation and stale-worktree surfacing

## Concrete recommendation for this repo

For this codebase, I would make three changes first:

1. Add a `ProjectWorkspaceService` that discovers Git worktrees and overlays local metadata.
2. Extend the domain from `project.workspacePath` plus `workflow.workspaceCwd` to `projectId + workspaceId + rootPath`.
3. Make background coding agents allocate linked worktrees by default when the task can write.

That gets the core value of worktrees into the platform without redesigning the whole project system.

## Sources

- Git worktree documentation: [git-worktree](https://git-scm.com/docs/git-worktree)
- Git configuration documentation for per-worktree config: [git-config](https://git-scm.com/docs/git-config)
- Git repository layout documentation for shared vs per-worktree data: [gitrepository-layout](https://git-scm.com/docs/gitrepository-layout)
- Anthropic official guidance on parallel Claude Code sessions with Git worktrees: [Claude Code common workflows](https://docs.anthropic.com/en/docs/claude-code/common-workflows)
