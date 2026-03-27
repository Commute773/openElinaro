import type { OpenElinaroApp } from "../../../app/runtime";
import { CORS_HEADERS } from "./helpers";
import { homeRoutes } from "./home";
import { agentRoutes } from "./agents";
import { routineRoutes } from "./routines";
import { notificationRoutes } from "./notifications";
import { chatRoutes } from "./chat";
import { toolRoutes } from "./tools";
import { dataRoutes } from "./data";
import { eventRoutes } from "./events";

export type RouteHandler = (
  request: Request,
  params: Record<string, string>,
  app: OpenElinaroApp,
) => Promise<Response>;

export interface RouteDefinition {
  method: string;
  pattern: string | RegExp;
  handler: RouteHandler;
}

interface CompiledRoute {
  method: string;
  handler: RouteHandler;
  // For exact-match routes (no params)
  exactPath?: string;
  // For parameterized routes (precompiled regex + param names)
  regex?: RegExp;
  paramNames?: string[];
}

/** Precompile a RouteDefinition into a CompiledRoute for fast matching. */
function compileRoute(def: RouteDefinition): CompiledRoute {
  if (typeof def.pattern === "string") {
    if (!def.pattern.includes(":")) {
      return { method: def.method, handler: def.handler, exactPath: def.pattern };
    }
    const paramNames: string[] = [];
    const regexStr = def.pattern.replace(/:([^/]+)/g, (_match, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    return {
      method: def.method,
      handler: def.handler,
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
    };
  }
  // RegExp pattern passed through directly
  return { method: def.method, handler: def.handler, regex: def.pattern };
}

const compiledRoutes: CompiledRoute[] = [
  ...homeRoutes,
  ...agentRoutes,
  ...routineRoutes,
  ...notificationRoutes,
  ...chatRoutes,
  ...toolRoutes,
  ...dataRoutes,
  ...eventRoutes,
].map(compileRoute);

function matchRoute(
  route: CompiledRoute,
  pathname: string,
): Record<string, string> | null {
  if (route.exactPath !== undefined) {
    return pathname === route.exactPath ? {} : null;
  }
  if (!route.regex) return null;
  const m = pathname.match(route.regex);
  if (!m) return null;
  const params: Record<string, string> = {};
  if (route.paramNames) {
    for (let i = 0; i < route.paramNames.length; i++) {
      params[route.paramNames[i]!] = m[i + 1]!;
    }
  } else {
    for (let i = 1; i < m.length; i++) {
      params[`$${i}`] = m[i]!;
    }
  }
  return params;
}

/**
 * Handles G2 API requests.
 * Returns a Response if the request matched a G2 route, or null if it didn't.
 */
export async function handleG2ApiRequest(
  request: Request,
  pathname: string,
  app: OpenElinaroApp,
): Promise<Response | null> {
  if (request.method === "OPTIONS" && pathname.startsWith("/api/g2")) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  for (const route of compiledRoutes) {
    if (request.method !== route.method) continue;
    const params = matchRoute(route, pathname);
    if (params === null) continue;
    return route.handler(request, params, app);
  }

  return null;
}
