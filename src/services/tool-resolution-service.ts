import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentToolScope, ResolvedToolBundle } from "../domain/tool-catalog";
import type { ToolContext } from "../tools/routine-tool-registry";
import { RoutineToolRegistry } from "../tools/routine-tool-registry";

type ResolveParams = {
  agentScope: AgentToolScope;
  context?: ToolContext;
  defaultCwd?: string;
  activatedToolNames?: string[];
};

export class ToolResolutionService {
  constructor(private readonly tools: RoutineToolRegistry) {}

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
      selectedBySearch: [...(params.activatedToolNames ?? [])],
    };
  }

  getScopeCatalog(agentScope: AgentToolScope, context?: ToolContext) {
    return this.tools.getToolCatalog(context)
      .filter((card) => !card.aliasOf)
      .filter((card) => card.agentScopes.includes(agentScope));
  }

  resolveAllForScope(
    agentScope: AgentToolScope,
    params?: Omit<ResolveParams, "agentScope" | "activatedToolNames">,
  ) {
    const catalog = this.getScopeCatalog(agentScope, params?.context);
    const tools = this.tools.getToolsByNames(
      catalog.map((card) => card.canonicalName),
      params?.context,
      { defaultCwd: params?.defaultCwd },
    );
    return {
      entries: tools,
      tools: tools.map((entry) => entry.name),
      selectedBySearch: [] as string[],
    };
  }

  resolveForChat(params: Omit<ResolveParams, "agentScope">) {
    return this.resolve({
      ...params,
      agentScope: "chat",
    });
  }

  resolveAllForChat(params?: Omit<ResolveParams, "agentScope" | "activatedToolNames">) {
    return this.resolveAllForScope("chat", params);
  }

  resolveForCodingPlanner(params: Omit<ResolveParams, "agentScope">) {
    return this.resolve({
      ...params,
      agentScope: "coding-planner",
    });
  }

  resolveAllForCodingPlanner(
    params?: Omit<ResolveParams, "agentScope" | "activatedToolNames">,
  ) {
    return this.resolveAllForScope("coding-planner", params);
  }

  resolveForCodingWorker(params: Omit<ResolveParams, "agentScope">) {
    return this.resolve({
      ...params,
      agentScope: "coding-worker",
    });
  }

  resolveAllForCodingWorker(
    params?: Omit<ResolveParams, "agentScope" | "activatedToolNames">,
  ) {
    return this.resolveAllForScope("coding-worker", params);
  }
}
