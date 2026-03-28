import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import {
  DEFAULT_WEB_SEARCH_LANGUAGE,
  DEFAULT_WEB_SEARCH_UI_LANG,
} from "../../services/tool-defaults";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/infrastructure/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

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

export function buildWebTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [];

  if (ctx.featureConfig.isActive("webSearch")) {
    tools.push(
      defineTool(
        async (input) =>
          traceSpan(
            "tool.web_search",
            async () => {
              const webSearch = ctx.createWebSearchService();
              if (!webSearch) {
                throw new Error(
                  "Brave web search is not configured. Enable the webSearch feature and provide the configured secret ref.",
                );
              }
              return webSearch.searchBrave(input);
            },
            { attributes: input },
          ),
        {
          name: "web_search",
          description:
            `Search the web using Brave Search API. Returns titles, URLs, and snippets for quick research. Defaults to English search (${DEFAULT_WEB_SEARCH_LANGUAGE}) and UI locale ${DEFAULT_WEB_SEARCH_UI_LANG}; omit those args unless overriding.`,
          schema: webSearchSchema,
        },
      ),
    );
  }

  if (ctx.featureConfig.isActive("webFetch")) {
    tools.push(
      defineTool(
        async (input) =>
          traceSpan(
            "tool.web_fetch",
            async () => ctx.webFetch.fetch(input),
            { attributes: input },
          ),
        {
          name: "web_fetch",
          description:
            "Fetch a URL through Crawl4AI and return AI-friendly page content as markdown, text, or html. Use this for reading a specific page after discovery with web_search; prefer openbrowser only when interactive browser control is required.",
          schema: webFetchSchema,
        },
      ),
    );
  }

  return tools;
}
