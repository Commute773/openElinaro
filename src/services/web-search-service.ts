import {
  DEFAULT_WEB_SEARCH_LANGUAGE,
  DEFAULT_WEB_SEARCH_UI_LANG,
} from "./tool-defaults";
import { telemetry as rootTelemetry, type TelemetryService } from "./infrastructure/telemetry";
import { attemptOr } from "../utils/result";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export type WebSearchParams = {
  query: string;
  count?: number;
  country?: string;
  language?: string;
  ui_lang?: string;
  freshness?: "day" | "week" | "month" | "year";
  date_after?: string;
  date_before?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }>;
  };
};

function normalizeUiLanguage(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  return attemptOr(() => new Intl.Locale(trimmed).toString(), trimmed);
}

function normalizeBraveError(status: number, detail: string, params: WebSearchParams) {
  const normalizedDetail = detail.trim();
  if (status === 422 && params.ui_lang && normalizedDetail.toLowerCase().includes("ui_lang")) {
    const canonical = normalizeUiLanguage(params.ui_lang);
    return [
      `Brave Search rejected ui_lang "${params.ui_lang}".`,
      canonical && canonical !== params.ui_lang
        ? `Retry with canonical locale casing like "${canonical}".`
        : "Retry with a canonical locale tag such as \"en-US\".",
      normalizedDetail ? `Detail: ${normalizedDetail}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  return `Brave Search API error (${status}): ${normalizedDetail || "Request failed."}`;
}

function mapFreshness(value?: WebSearchParams["freshness"]) {
  if (!value) {
    return undefined;
  }

  if (value === "day") {
    return "pd";
  }
  if (value === "week") {
    return "pw";
  }
  if (value === "month") {
    return "pm";
  }
  return "py";
}

function resolveFreshness(params: WebSearchParams) {
  const relative = mapFreshness(params.freshness);
  if (relative) {
    return relative;
  }

  if (params.date_after && params.date_before) {
    return `${params.date_after}to${params.date_before}`;
  }
  if (params.date_after) {
    return `${params.date_after}to${new Date().toISOString().slice(0, 10)}`;
  }
  if (params.date_before) {
    return `1970-01-01to${params.date_before}`;
  }
  return undefined;
}

function resolveSiteName(url: string) {
  return attemptOr(() => new URL(url).hostname.replace(/^www\./, "") || undefined, undefined);
}

export class WebSearchService {
  constructor(
    private readonly apiKey: string,
    private readonly telemetry: TelemetryService = rootTelemetry.child({ component: "web_search" }),
  ) {}

  async searchBrave(params: WebSearchParams) {
    return this.telemetry.span("web_search.search", {
      provider: "brave",
      query: params.query,
    }, async () => {
      const url = new URL(BRAVE_SEARCH_ENDPOINT);
      const searchLanguage = params.language?.trim().toLowerCase() || DEFAULT_WEB_SEARCH_LANGUAGE;
      const uiLanguage = normalizeUiLanguage(params.ui_lang || DEFAULT_WEB_SEARCH_UI_LANG);
      url.searchParams.set("q", params.query);
      url.searchParams.set("count", String(params.count ?? 5));

      if (params.country) {
        url.searchParams.set("country", params.country.trim().toUpperCase());
      }
      url.searchParams.set("search_lang", searchLanguage);
      url.searchParams.set("ui_lang", uiLanguage);

      const freshness = resolveFreshness(params);
      if (freshness) {
        url.searchParams.set("freshness", freshness);
      }

      const startedAt = Date.now();
      const response = await this.telemetry.instrumentFetch({
        component: "web_search",
        operation: "web_search.brave_request",
        provider: "brave",
        url: url.toString(),
        method: "GET",
        init: {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": this.apiKey,
          },
          signal: AbortSignal.timeout(30_000),
        },
      });

      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(normalizeBraveError(response.status, detail || response.statusText, params));
      }

      const payload = await response.json() as BraveSearchResponse;
      const results = Array.isArray(payload.web?.results) ? payload.web?.results : [];

      return {
        query: params.query,
        provider: "brave" as const,
        count: results.length,
        tookMs: Date.now() - startedAt,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "brave" as const,
        },
        results: results.map((entry) => ({
          title: entry.title ?? "",
          url: entry.url ?? "",
          description: entry.description ?? "",
          published: entry.age || undefined,
          siteName: entry.url ? resolveSiteName(entry.url) : undefined,
        })),
      };
    });
  }
}
