/**
 * Web search and fetch function definitions.
 * Migrated from src/tools/groups/web-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import {
  DEFAULT_WEB_SEARCH_LANGUAGE,
  DEFAULT_WEB_SEARCH_UI_LANG,
} from "../../services/tool-defaults";

// ---------------------------------------------------------------------------
// Shared schemas (same as web-tools.ts)
// ---------------------------------------------------------------------------

const webSearchSchema = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).max(10).optional(),
  country: z.string().min(2).max(2).optional(),
  language: z.string()
    .min(2)
    .max(16)
    .describe(`Defaults to ${DEFAULT_WEB_SEARCH_LANGUAGE}. Omit unless overriding.`)
    .optional(),
  ui_lang: z.string()
    .min(2)
    .max(16)
    .describe(`Defaults to ${DEFAULT_WEB_SEARCH_UI_LANG}. Omit unless overriding.`)
    .optional(),
  freshness: z.enum(["day", "week", "month", "year"]).optional(),
  date_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const webFetchSchema = z.object({
  url: z.string().url(),
  format: z.enum(["text", "markdown", "html"]).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  maxChars: z.number().int().min(500).max(40_000).optional(),
});

// ---------------------------------------------------------------------------
// Web auth defaults
// ---------------------------------------------------------------------------

const WEB_AUTH = { access: "anyone" as const, behavior: "uniform" as const };
const WEB_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const WEB_DOMAINS = ["web"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildWebFunctions: FunctionDomainBuilder = (ctx) => [
  // -----------------------------------------------------------------------
  // web_search
  // -----------------------------------------------------------------------
  defineFunction({
    name: "web_search",
    description:
      `Search the web using Brave Search API. Returns titles, URLs, and snippets for quick research. Defaults to English search (${DEFAULT_WEB_SEARCH_LANGUAGE}) and UI locale ${DEFAULT_WEB_SEARCH_UI_LANG}; omit those args unless overriding.`,
    input: webSearchSchema,
    handler: async (input, fnCtx) => {
      const webSearch = fnCtx.services.createWebSearchService();
      if (!webSearch) {
        throw new Error(
          "Brave web search is not configured. Enable the webSearch feature and provide the configured secret ref.",
        );
      }
      return webSearch.searchBrave(input);
    },
    auth: WEB_AUTH,
    domains: WEB_DOMAINS,
    agentScopes: WEB_SCOPES,
    featureGate: "webSearch",
  }),

  // -----------------------------------------------------------------------
  // web_fetch
  // -----------------------------------------------------------------------
  defineFunction({
    name: "web_fetch",
    description:
      "Fetch a URL through Crawl4AI and return AI-friendly page content as markdown, text, or html. Use this for reading a specific page after discovery with web_search; prefer openbrowser only when interactive browser control is required.",
    input: webFetchSchema,
    handler: async (input, fnCtx) => fnCtx.services.webFetch.fetch(input),
    auth: WEB_AUTH,
    domains: WEB_DOMAINS,
    agentScopes: WEB_SCOPES,
    featureGate: "webFetch",
  }),
];
