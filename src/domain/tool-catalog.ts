export type AgentToolScope = "chat" | "coding-planner" | "coding-worker" | "direct";
export type ToolAuthorizationAccess = "anyone" | "root";
export type ToolAuthorizationBehavior = "uniform" | "role-sensitive";

export interface ToolAuthorizationDeclaration {
  access: ToolAuthorizationAccess;
  behavior: ToolAuthorizationBehavior;
  note?: string;
}

export interface ToolCatalogMetadata {
  name: string;
  description: string;
  examples: string[];
  canonicalName: string;
  aliasOf?: string;
  domains: string[];
  tags: string[];
  agentScopes: AgentToolScope[];
  defaultVisibleScopes: AgentToolScope[];
  defaultVisibleToMainAgent: boolean;
  defaultVisibleToSubagent: boolean;
  supportsBackground: boolean;
  mutatesState: boolean;
  readsWorkspace: boolean;
  authorization: ToolAuthorizationDeclaration;
  searchText: string;
}

export interface ToolCatalogCard extends ToolCatalogMetadata {}

export interface ToolSearchResult {
  card: ToolCatalogCard;
  score: number;
  vectorScore: number;
  lexicalScore: number;
}

export interface ResolvedToolBundle {
  tools: string[];
  searchQuery?: string;
  selectedBySearch: string[];
}
