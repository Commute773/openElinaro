import fs from "node:fs";
import type { AppResponse } from "../domain/assistant";
import type { ProfileRecord } from "../domain/profiles";
import { resolveDiscordResponse } from "../services/discord-response-service";
import { RecentThreadContextService, shouldIncludeRecentThreadContext } from "../services/recent-thread-context-service";
import type { ProfileService } from "../services/profile-service";
import type { ConversationStore } from "../services/conversation/conversation-store";
import { WorkPlanningService } from "../services/work-planning-service";
import type { RoutinesService } from "../services/routines-service";
import { telemetry } from "../services/telemetry";
import type { RuntimeScope } from "./runtime-scope";

export function finalizeAppResponse(scope: RuntimeScope, response: AppResponse): AppResponse {
  return resolveDiscordResponse({
    response,
    assertPathAccess: (targetPath) => {
      const resolvedPath = scope.access.assertPathAccess(targetPath);
      if (!fs.existsSync(resolvedPath)) {
        return resolvedPath;
      }

      return scope.access.assertPathAccess(resolvedPath);
    },
  });
}

export async function buildThreadStartSystemContext(
  scope: RuntimeScope,
  conversationKey: string,
  appTelemetry: typeof telemetry,
  conversations: ConversationStore,
  profiles: ProfileService,
) {
  const conversation = await conversations.get(conversationKey);
  if (!shouldIncludeRecentThreadContext(conversation.messages)) {
    return undefined;
  }

  const recentThreadContext = appTelemetry.instrumentMethods(
    new RecentThreadContextService(
      scope.profile,
      scope.projects,
      profiles,
    ),
    { component: "recent_thread_context" },
  ).buildThreadStartContext();
  const reflectionContext = await scope.reflection.buildThreadBootstrapContext();
  const sections = [reflectionContext, recentThreadContext].filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export function buildHeartbeatWorkFocus(
  scope: RuntimeScope,
  appTelemetry: typeof telemetry,
  routines: RoutinesService,
  reference?: Date,
) {
  return appTelemetry.instrumentMethods(
    new WorkPlanningService(routines, scope.projects),
    { component: "work_planning" },
  ).buildHeartbeatSummary(reference) ?? undefined;
}

export function buildAutomationSessionKey(kind: string, conversationKey: string) {
  return `automation:${kind}:${conversationKey}`;
}
