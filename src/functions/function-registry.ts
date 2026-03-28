/**
 * Central registry for all function definitions. Generates all three surfaces:
 * - Agent tools (StructuredToolInterface[])
 * - HTTP API routes (RouteDefinition[])
 * - Discord commands (DiscordCommandDescriptor[])
 * - OpenAPI spec
 * - Auth declarations (for compile-time coverage assertion)
 * - Tool catalog cards (for catalog metadata)
 */
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { FunctionDefinition, FunctionDomainBuilder } from "./define-function";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
import type { ToolContext } from "../tools/tool-registry";
import type { RouteDefinition } from "../integrations/http/g2/router";
import type { ToolAuthorizationDeclaration, ToolCatalogCard, AgentToolScope } from "../domain/tool-catalog";
import { generateAgentTools, type FunctionContextExtras } from "./generate-tools";
import { generateApiRoutes } from "./generate-api-routes";
import { generateDiscordCommands, type DiscordCommandDescriptor } from "./generate-discord-commands";
import { generateOpenApiSpec } from "./generate-openapi";

export class FunctionRegistry {
  private readonly definitions: Map<string, FunctionDefinition> = new Map();
  private readonly builders: FunctionDomainBuilder[];

  constructor(builders: FunctionDomainBuilder[]) {
    this.builders = builders;
  }

  /**
   * Build all function definitions from domain builders using the given service context.
   * Must be called once before generating surfaces.
   */
  build(ctx: ToolBuildContext): void {
    this.definitions.clear();
    for (const builder of this.builders) {
      const defs = builder(ctx);
      for (const def of defs) {
        if (this.definitions.has(def.name)) {
          throw new Error(`Duplicate function definition: ${def.name}`);
        }
        this.definitions.set(def.name, def);
      }
    }
  }

  /** Check if any definitions have been built. */
  get isBuilt(): boolean {
    return this.definitions.size > 0;
  }

  /** Get a function definition by name. */
  get(name: string): FunctionDefinition | undefined {
    return this.definitions.get(name);
  }

  /** Get all definitions, optionally filtered. */
  getDefinitions(options?: {
    surface?: "api" | "discord" | "agent";
    featureChecker?: (featureId: string) => boolean;
  }): FunctionDefinition[] {
    let defs = [...this.definitions.values()];
    if (options?.surface) {
      defs = defs.filter((d) => {
        const surfaces = d.surfaces ?? ["api", "discord", "agent"];
        return surfaces.includes(options.surface!);
      });
    }
    if (options?.featureChecker) {
      defs = defs.filter((d) => !d.featureGate || options.featureChecker!(d.featureGate));
    }
    return defs;
  }

  /** All registered function names. */
  getNames(): string[] {
    return [...this.definitions.keys()];
  }

  // -------------------------------------------------------------------------
  // Surface generators
  // -------------------------------------------------------------------------

  /** Generate StructuredToolInterface[] for the agent tool surface. */
  generateAgentTools(
    resolveServices: () => ToolBuildContext,
    resolveToolContext?: () => ToolContext | undefined,
    featureChecker?: (featureId: string) => boolean,
    resolveExtras?: () => FunctionContextExtras,
  ): StructuredToolInterface[] {
    return generateAgentTools(
      [...this.definitions.values()],
      resolveServices,
      resolveToolContext,
      featureChecker,
      resolveExtras,
    );
  }

  /** Generate RouteDefinition[] for the HTTP API surface. */
  generateApiRoutes(
    resolveServices: () => ToolBuildContext,
    featureChecker?: (featureId: string) => boolean,
  ): RouteDefinition[] {
    return generateApiRoutes(
      [...this.definitions.values()],
      resolveServices,
      featureChecker,
    );
  }

  /** Generate DiscordCommandDescriptor[] for the Discord surface. */
  generateDiscordCommands(
    featureChecker?: (featureId: string) => boolean,
  ): DiscordCommandDescriptor[] {
    return generateDiscordCommands(
      [...this.definitions.values()],
      featureChecker,
    );
  }

  /** Generate an OpenAPI 3.1 spec from all API-surface definitions. */
  generateOpenApiSpec(
    featureChecker?: (featureId: string) => boolean,
    options?: { title?: string; version?: string; serverUrl?: string },
  ): Record<string, unknown> {
    return generateOpenApiSpec(
      [...this.definitions.values()],
      featureChecker,
      options,
    );
  }

  // -------------------------------------------------------------------------
  // Metadata generators (for integration with existing systems)
  // -------------------------------------------------------------------------

  /** Generate auth declarations for compile-time coverage assertion. */
  generateAuthDeclarations(): Record<string, ToolAuthorizationDeclaration> {
    const declarations: Record<string, ToolAuthorizationDeclaration> = {};
    for (const def of this.definitions.values()) {
      declarations[def.name] = {
        access: def.auth.access,
        behavior: def.auth.behavior,
        note: def.auth.note,
      };
    }
    return declarations;
  }

  /** Generate ToolCatalogCard[] for the catalog system. */
  generateCatalog(): ToolCatalogCard[] {
    const cards: ToolCatalogCard[] = [];
    for (const def of this.definitions.values()) {
      const surfaces = def.surfaces ?? ["api", "discord", "agent"];
      if (!surfaces.includes("agent")) continue;

      const defaultVisibleScopes = def.defaultVisibleScopes ?? [];
      cards.push({
        name: def.name,
        description: def.description,
        examples: def.examples ?? [],
        canonicalName: def.name,
        domains: def.domains,
        tags: def.tags ?? inferTags(def),
        agentScopes: def.agentScopes,
        defaultVisibleScopes,
        defaultVisibleToMainAgent: defaultVisibleScopes.includes("chat"),
        defaultVisibleToSubagent: defaultVisibleScopes.includes("coding-worker"),
        supportsBackground: def.supportsBackground ?? false,
        mutatesState: def.mutatesState ?? false,
        readsWorkspace: def.readsWorkspace ?? false,
        authorization: {
          access: def.auth.access,
          behavior: def.auth.behavior,
          note: def.auth.note,
        },
      });
    }
    return cards;
  }

  /** Generate untrusted output descriptors for the output pipeline. */
  generateUntrustedOutputMap(): Record<string, { sourceType: string; sourceName: string; notes: string }> {
    const map: Record<string, { sourceType: string; sourceName: string; notes: string }> = {};
    for (const def of this.definitions.values()) {
      if (def.untrustedOutput) {
        map[def.name] = def.untrustedOutput;
      }
    }
    return map;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferTags(def: FunctionDefinition): string[] {
  const tags: string[] = [];
  const lower = `${def.name} ${def.description}`.toLowerCase();
  if (lower.includes("list") || lower.includes("search")) tags.push("read");
  if (lower.includes("add") || lower.includes("create")) tags.push("write");
  if (lower.includes("update") || lower.includes("edit")) tags.push("write");
  if (lower.includes("delete") || lower.includes("remove")) tags.push("write");
  return tags;
}
