import type { OpenElinaroApp } from "../../../app/runtime";
import { CORS_HEADERS } from "./helpers";
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

/**
 * App-level routes that require the OpenElinaroApp instance directly.
 * These are integration-layer concerns (dashboard, agent mgmt, chat,
 * tool catalog, SSE events) that don't map to the function layer.
 * Service-level operations (routines, finance, shell, etc.) are
 * generated from function definitions instead.
 */
const staticRoutes: RouteDefinition[] = [
  ...chatRoutes,
  ...toolRoutes,
  ...dataRoutes,
  ...eventRoutes,
];
const compiledStaticRoutes: CompiledRoute[] = staticRoutes.map(compileRoute);

/** Cache for compiled generated routes (lazily built per-app). */
let compiledGeneratedRoutes: CompiledRoute[] | null = null;
let generatedRoutesApp: OpenElinaroApp | null = null;

function getCompiledGeneratedRoutes(app: OpenElinaroApp): CompiledRoute[] {
  if (compiledGeneratedRoutes && generatedRoutesApp === app) {
    return compiledGeneratedRoutes;
  }
  const generated = app.getGeneratedApiRoutes?.() ?? [];
  compiledGeneratedRoutes = generated.map(compileRoute);
  generatedRoutesApp = app;
  return compiledGeneratedRoutes;
}

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
 * Handles API requests.
 * Returns a Response if the request matched an API route, or null if it didn't.
 *
 * Routes are checked in order: generated (function-layer) first, then static (legacy).
 * This ensures function-layer routes take priority for migrated endpoints.
 */
export async function handleApiRequest(
  request: Request,
  pathname: string,
  app: OpenElinaroApp,
): Promise<Response | null> {
  if (request.method === "OPTIONS" && pathname.startsWith("/api")) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Check generated routes first (from function layer)
  const generatedRoutes = getCompiledGeneratedRoutes(app);
  for (const route of generatedRoutes) {
    if (request.method !== route.method) continue;
    const params = matchRoute(route, pathname);
    if (params === null) continue;
    return route.handler(request, params, app);
  }

  // Then check static routes (legacy hand-written handlers)
  for (const route of compiledStaticRoutes) {
    if (request.method !== route.method) continue;
    const params = matchRoute(route, pathname);
    if (params === null) continue;
    return route.handler(request, params, app);
  }

  return null;
}
