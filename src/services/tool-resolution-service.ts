import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentToolScope, ResolvedToolBundle, ToolCatalogCard } from "../domain/tool-catalog";
import type { ToolContext } from "../tools/tool-registry";
import { ToolRegistry } from "../tools/tool-registry";

type ResolveParams = {
  agentScope: AgentToolScope;
  context?: ToolContext;
  defaultCwd?: string;
  activatedToolNames?: string[];
};

type ScopedResolveParams = Omit<ResolveParams, "agentScope">;
type ScopedResolveAllParams = Omit<ResolveParams, "agentScope" | "activatedToolNames">;

/** Create a pair of scope-bound resolve helpers. */
function buildScopeResolver(service: ToolResolutionService, scope: AgentToolScope) {
  return {
    resolve: (params: ScopedResolveParams) => service.resolve({ ...params, agentScope: scope }),
    resolveAll: (params?: ScopedResolveAllParams) => service.resolveAllForScope(scope, params),
  };
}

export class ToolResolutionService {
  constructor(private readonly tools: ToolRegistry) {}

  resolve(params: ResolveParams): ResolvedToolBundle & { entries: StructuredToolInterface[] } {
    const selectedNames = new Set(this.tools.getAgentDefaultVisibleToolNames(params.agentScope));
    for (const name of params.activatedToolNames ?? []) {
      selectedNames.add(name);
    }

    const tools = this.tools.getToolsByNames([...selectedNames], params.context, {
      defaultCwd: params.defaultCwd,
    });
    return {
      entries: tools,
      tools: tools.map((entry) => entry.name),
      activatedTools: [...(params.activatedToolNames ?? [])],
    };
  }

  getScopeCatalog(agentScope: AgentToolScope, context?: ToolContext): ToolCatalogCard[] {
    return this.tools.getToolCatalog(context)
      .filter((card) => !card.aliasOf)
      .filter((card) => card.agentScopes.includes(agentScope));
  }

  resolveAllForScope(
    agentScope: AgentToolScope,
    params?: ScopedResolveAllParams,
  ): ResolvedToolBundle & { entries: StructuredToolInterface[] } {
    const catalog = this.getScopeCatalog(agentScope, params?.context);
    const tools = this.tools.getToolsByNames(
      catalog.map((card) => card.canonicalName),
      params?.context,
      { defaultCwd: params?.defaultCwd },
    );
    return {
      entries: tools,
      tools: tools.map((entry) => entry.name),
      activatedTools: [] as string[],
    };
  }

  /** Get a scope-bound resolver pair for any AgentToolScope. */
  forScope(scope: AgentToolScope) {
    return buildScopeResolver(this, scope);
  }

  // -- Convenience aliases (delegate to forScope) -------------------------

  resolveForChat(params: ScopedResolveParams) {
    return this.forScope("chat").resolve(params);
  }

  resolveAllForChat(params?: ScopedResolveAllParams) {
    return this.forScope("chat").resolveAll(params);
  }

  resolveForCodingPlanner(params: ScopedResolveParams) {
    return this.forScope("coding-planner").resolve(params);
  }

  resolveAllForCodingPlanner(params?: ScopedResolveAllParams) {
    return this.forScope("coding-planner").resolveAll(params);
  }

  resolveForCodingWorker(params: ScopedResolveParams) {
    return this.forScope("coding-worker").resolve(params);
  }

  resolveAllForCodingWorker(params?: ScopedResolveAllParams) {
    return this.forScope("coding-worker").resolveAll(params);
  }
}
