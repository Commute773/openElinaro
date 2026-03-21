import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FinanceService,
  type FinanceCategorizeDecision,
  type FinanceImportOptions,
  type FinanceSettingsUpdateInput,
} from "../../src/services/finance-service.ts";
import type { FinanceWhatIfInput } from "../../src/services/finance-dashboard-types.ts";

const DEFAULT_PORT = 3001;
const MAX_REVIEW_DECISIONS = 100;
const uiRoot = path.resolve(import.meta.dir);
const distRoot = path.resolve(uiRoot, "dist");
const repoRoot = process.env.OPENELINARO_ROOT
  ? path.resolve(process.env.OPENELINARO_ROOT)
  : path.resolve(uiRoot, "..", "..");

class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details ?? null;
  }
}

function expandHomePath(targetPath: string) {
  if (targetPath === "~") {
    return os.homedir();
  }
  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

function resolveConfiguredPath(targetPath: string, _label: string): string {
  const expanded = expandHomePath(targetPath);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(repoRoot, expanded);
}

const userDataRoot = resolveConfiguredPath(
  process.env.OPENELINARO_USER_DATA_DIR ?? path.join(os.homedir(), ".openelinaro"),
  "OpenElinaro user data root",
);
const dbPath = resolveConfiguredPath(
  process.env.OPENELINARO_FINANCE_DB_PATH ?? path.join(userDataRoot, "finance", "finance.db"),
  "Finance database path",
);
const forecastConfigPath = resolveConfiguredPath(
  process.env.OPENELINARO_FINANCE_FORECAST_PATH ?? path.join(userDataRoot, "finance", "forecast-config.json"),
  "Finance forecast config path",
);
const requestedPort = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;

const financeService = new FinanceService({
  dbPath,
  forecastConfigPath,
});

function relativeToRepo(filePath: string): string {
  const relativePath = path.relative(repoRoot, filePath);
  if (!relativePath) {
    return ".";
  }
  return !relativePath.startsWith("..") ? relativePath : filePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers,
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      {
        error: {
          code: "request_error",
          message: error.message,
          details: error.details,
        },
      },
      { status: error.status },
    );
  }

  return json(
    {
      error: {
        code: "internal_error",
        message: "Finance dashboard server error",
        details: error instanceof Error ? error.message : String(error),
      },
    },
    { status: 500 },
  );
}

function notFound(message = "Not found"): Response {
  return json(
    {
      error: {
        code: "not_found",
        message,
      },
    },
    { status: 404 },
  );
}

function methodNotAllowed(allowed: string[]): Response {
  return json(
    {
      error: {
        code: "method_not_allowed",
        message: `Method not allowed. Use ${allowed.join(", ")}.`,
      },
    },
    {
      status: 405,
      headers: { allow: allowed.join(", ") },
    },
  );
}

function getContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function resolveStaticFile(pathname: string): string | null {
  if (!fs.existsSync(path.join(distRoot, "index.html"))) {
    return null;
  }
  const target = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.posix.normalize(target);
  if (!normalized.startsWith("/")) {
    return null;
  }

  const candidate = path.resolve(distRoot, `.${normalized}`);
  const relativePath = path.relative(distRoot, candidate);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    if (!path.extname(normalized)) {
      const spaFallback = path.resolve(distRoot, "index.html");
      return fs.existsSync(spaFallback) ? spaFallback : null;
    }
    return null;
  }

  return candidate;
}

function renderBuildHint(): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenElinaro Finance Dashboard</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; background: #f6f3ed; color: #1d2733; }
      main { max-width: 760px; margin: 6rem auto; background: white; border: 1px solid #d9d1c4; border-radius: 24px; padding: 2rem; box-shadow: 0 24px 48px rgba(0,0,0,0.08); }
      code { background: #f2ece1; padding: 0.18rem 0.38rem; border-radius: 8px; }
      p { line-height: 1.6; color: #55646c; }
    </style>
  </head>
  <body>
    <main>
      <h1>Finance dashboard UI is not built yet.</h1>
      <p>The Bun API server is running, but the Vite client bundle is missing. Build the UI with <code>bun run finance:build</code> for this server to serve the app, or run <code>bun run finance:dev</code> separately during development.</p>
      <p>API routes are still available under <code>/api/finance/*</code>.</p>
    </main>
  </body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function serveStatic(pathname: string): Response {
  const filePath = resolveStaticFile(pathname);
  if (!filePath) {
    if (pathname === "/" || pathname === "/index.html") {
      return renderBuildHint();
    }
    return notFound("Static asset not found.");
  }

  return new Response(Bun.file(filePath), {
    headers: {
      "content-type": getContentType(filePath),
      "cache-control": pathname === "/" ? "no-cache" : "public, max-age=60",
    },
  });
}

function parseOptionalStringParam(raw: string | null, name: string, maxLength = 200): string | undefined {
  if (raw == null) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${name} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

function parseBooleanParam(raw: string | null, name: string): boolean | undefined {
  if (raw == null) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new HttpError(400, `${name} must be a boolean.`);
}

function parseIntegerParam(
  raw: string | null,
  name: string,
  options?: { min?: number; max?: number },
): number | undefined {
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new HttpError(400, `${name} must be an integer.`);
  }
  if (options?.min != null && value < options.min) {
    throw new HttpError(400, `${name} must be at least ${options.min}.`);
  }
  if (options?.max != null && value > options.max) {
    throw new HttpError(400, `${name} must be at most ${options.max}.`);
  }
  return value;
}

function parseNumberParam(
  raw: string | null,
  name: string,
  options?: { minExclusive?: number; maxInclusive?: number },
): number | undefined {
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new HttpError(400, `${name} must be a number.`);
  }
  if (options?.minExclusive != null && value <= options.minExclusive) {
    throw new HttpError(400, `${name} must be greater than ${options.minExclusive}.`);
  }
  if (options?.maxInclusive != null && value > options.maxInclusive) {
    throw new HttpError(400, `${name} must be at most ${options.maxInclusive}.`);
  }
  return value;
}

function parseOptionalBodyString(
  value: unknown,
  name: string,
  options?: { maxLength?: number; nullable?: boolean },
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    if (options?.nullable === false) {
      throw new HttpError(400, `${name} cannot be null.`);
    }
    return null;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return options?.nullable === false ? undefined : null;
  }
  const maxLength = options?.maxLength ?? 1000;
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${name} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

function parseOptionalBodyBoolean(value: unknown, name: string): boolean | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, `${name} must be a boolean.`);
  }
  return value;
}

function parseOptionalBodyInteger(
  value: unknown,
  name: string,
  options?: { min?: number; max?: number },
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, `${name} must be an integer.`);
  }
  if (options?.min != null && value < options.min) {
    throw new HttpError(400, `${name} must be at least ${options.min}.`);
  }
  if (options?.max != null && value > options.max) {
    throw new HttpError(400, `${name} must be at most ${options.max}.`);
  }
  return value;
}

function parseRequiredBodyNumber(
  value: unknown,
  name: string,
  options?: { minExclusive?: number; maxInclusive?: number },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `${name} must be a number.`);
  }
  if (options?.minExclusive != null && value <= options.minExclusive) {
    throw new HttpError(400, `${name} must be greater than ${options.minExclusive}.`);
  }
  if (options?.maxInclusive != null && value > options.maxInclusive) {
    throw new HttpError(400, `${name} must be at most ${options.maxInclusive}.`);
  }
  return value;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!isRecord(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body;
}

function parseReferenceDate(url: URL): string | undefined {
  return parseOptionalStringParam(url.searchParams.get("date"), "date", 32);
}

function parseTransactionFilters(url: URL) {
  return {
    month: parseOptionalStringParam(url.searchParams.get("month"), "month", 16),
    fromDate: parseOptionalStringParam(url.searchParams.get("fromDate"), "fromDate", 32),
    toDate: parseOptionalStringParam(url.searchParams.get("toDate"), "toDate", 32),
    account: parseOptionalStringParam(url.searchParams.get("account"), "account", 160),
    category: parseOptionalStringParam(url.searchParams.get("category"), "category", 160),
    search: parseOptionalStringParam(url.searchParams.get("search"), "search", 200),
    onlyBudget: parseBooleanParam(url.searchParams.get("onlyBudget"), "onlyBudget") ?? false,
    onlyReview: parseBooleanParam(url.searchParams.get("onlyReview"), "onlyReview") ?? false,
    limit: parseIntegerParam(url.searchParams.get("limit"), "limit", { min: 1, max: 250 }),
  };
}

function parseReviewDecision(value: unknown, index: number): FinanceCategorizeDecision {
  if (!isRecord(value)) {
    throw new HttpError(400, `decisions[${index}] must be an object.`);
  }

  const id = parseOptionalBodyInteger(value.id, `decisions[${index}].id`, { min: 1 });
  const externalId = parseOptionalBodyString(value.externalId, `decisions[${index}].externalId`, {
    maxLength: 200,
    nullable: false,
  });

  if (id == null && !externalId) {
    throw new HttpError(400, `decisions[${index}] must include id or externalId.`);
  }

  return {
    id,
    externalId: externalId ?? undefined,
    category: parseOptionalBodyString(value.category, `decisions[${index}].category`, {
      maxLength: 160,
    }),
    countsTowardBudget: parseOptionalBodyBoolean(
      value.countsTowardBudget,
      `decisions[${index}].countsTowardBudget`,
    ),
    descriptionClean: parseOptionalBodyString(
      value.descriptionClean,
      `decisions[${index}].descriptionClean`,
      { maxLength: 300 },
    ),
    note: parseOptionalBodyString(value.note, `decisions[${index}].note`, { maxLength: 2000 }),
  };
}

async function parseReviewRequest(request: Request): Promise<FinanceCategorizeDecision[]> {
  const body = await readJsonObject(request);
  const decisionsSource = Array.isArray(body.decisions) ? body.decisions : [body];

  if (decisionsSource.length === 0) {
    throw new HttpError(400, "Request must include at least one review decision.");
  }
  if (decisionsSource.length > MAX_REVIEW_DECISIONS) {
    throw new HttpError(400, `Request may include at most ${MAX_REVIEW_DECISIONS} review decisions.`);
  }

  return decisionsSource.map((decision, index) => parseReviewDecision(decision, index));
}

function parseWhatIfFromQuery(url: URL): Partial<FinanceWhatIfInput> {
  return {
    purchaseAmountCad: parseNumberParam(url.searchParams.get("purchaseAmountCad"), "purchaseAmountCad", {
      minExclusive: 0,
    }),
    date: parseReferenceDate(url),
    countsTowardBudget: parseBooleanParam(url.searchParams.get("countsTowardBudget"), "countsTowardBudget"),
  };
}

async function parseWhatIfFromBody(request: Request): Promise<FinanceWhatIfInput> {
  const body = await readJsonObject(request);
  const date = parseOptionalBodyString(body.date, "date", { maxLength: 32, nullable: false });
  return {
    purchaseAmountCad: parseRequiredBodyNumber(body.purchaseAmountCad, "purchaseAmountCad", {
      minExclusive: 0,
    }),
    date: date ?? undefined,
    countsTowardBudget: parseOptionalBodyBoolean(body.countsTowardBudget, "countsTowardBudget") ?? undefined,
  };
}

function parseSettingsUpdate(body: Record<string, unknown>): FinanceSettingsUpdateInput {
  return {
    timezone: parseOptionalBodyString(body.timezone, "timezone", { maxLength: 120, nullable: false }) ?? undefined,
    weeklyLimitCad: body.weeklyLimitCad === undefined
      ? undefined
      : parseRequiredBodyNumber(body.weeklyLimitCad, "weeklyLimitCad", { minExclusive: 0 }),
    monthlyLimitCad: body.monthlyLimitCad === undefined
      ? undefined
      : parseRequiredBodyNumber(body.monthlyLimitCad, "monthlyLimitCad", { minExclusive: 0 }),
    weeklyStartDate: parseOptionalBodyString(body.weeklyStartDate, "weeklyStartDate", {
      maxLength: 32,
      nullable: false,
    }) ?? undefined,
    fxUsdCad: body.fxUsdCad === undefined
      ? undefined
      : parseRequiredBodyNumber(body.fxUsdCad, "fxUsdCad", { minExclusive: 0 }),
    spreadsheetId: parseOptionalBodyString(body.spreadsheetId, "spreadsheetId", {
      maxLength: 200,
      nullable: false,
    }) ?? undefined,
    accountsGid: parseOptionalBodyString(body.accountsGid, "accountsGid", {
      maxLength: 60,
      nullable: false,
    }) ?? undefined,
    transactionsGid: parseOptionalBodyString(body.transactionsGid, "transactionsGid", {
      maxLength: 60,
      nullable: false,
    }) ?? undefined,
  };
}

async function parseImportRequest(request: Request): Promise<FinanceImportOptions> {
  const body = await readJsonObject(request);
  const source = parseOptionalBodyString(body.source, "source", { maxLength: 32, nullable: false });
  if (source != null && source !== "fintable_gsheet" && source !== "csv") {
    throw new HttpError(400, "source must be 'fintable_gsheet' or 'csv'.");
  }

  return {
    source: (source ?? "fintable_gsheet") as FinanceImportOptions["source"],
    dryRun: parseOptionalBodyBoolean(body.dryRun, "dryRun") ?? false,
    spreadsheetId: parseOptionalBodyString(body.spreadsheetId, "spreadsheetId", {
      maxLength: 200,
      nullable: false,
    }) ?? undefined,
    accountsGid: parseOptionalBodyString(body.accountsGid, "accountsGid", {
      maxLength: 60,
      nullable: false,
    }) ?? undefined,
    transactionsGid: parseOptionalBodyString(body.transactionsGid, "transactionsGid", {
      maxLength: 60,
      nullable: false,
    }) ?? undefined,
    csvText: parseOptionalBodyString(body.csvText, "csvText", {
      maxLength: 2_000_000,
      nullable: false,
    }) ?? undefined,
  };
}

function buildMetadata() {
  const serviceMetadata = financeService.getMetadataData();
  return {
    app: "OpenElinaro Finance Dashboard",
    defaultPort: DEFAULT_PORT,
    requestedPort: port,
    api: {
      endpoints: [
        "GET /api/health",
        "GET /api/finance/metadata",
        "GET /api/finance/summary",
        "GET /api/finance/overview",
        "GET /api/finance/signals",
        "GET /api/finance/budget",
        "GET /api/finance/spending-breakdown",
        "GET /api/finance/transactions",
        "GET /api/finance/transactions/aggregates",
        "GET /api/finance/review",
        "POST /api/finance/review",
        "GET /api/finance/accounts",
        "GET /api/finance/receivables",
        "GET /api/finance/payables",
        "GET /api/finance/recurring",
        "POST /api/finance/recurring/refresh",
        "GET /api/finance/income-sources",
        "GET /api/finance/fx",
        "GET /api/finance/fx/events",
        "GET /api/finance/import-runs",
        "POST /api/finance/import",
        "POST /api/finance/settings",
        "GET /api/finance/forecast/summary",
        "GET /api/finance/forecast/cashflow",
        "GET /api/finance/forecast/tax",
        "GET /api/finance/what-if",
        "POST /api/finance/what-if"
      ],
    },
    repoRoot: relativeToRepo(repoRoot),
    paths: {
      database: {
        absolute: financeService.getDatabasePath(),
        relative: relativeToRepo(financeService.getDatabasePath()),
        exists: fs.existsSync(financeService.getDatabasePath()),
      },
      forecastConfig: {
        absolute: financeService.getForecastConfigPath(),
        relative: relativeToRepo(financeService.getForecastConfigPath()),
        exists: fs.existsSync(financeService.getForecastConfigPath()),
      },
      uiRoot: {
        absolute: uiRoot,
        relative: relativeToRepo(uiRoot),
      },
    },
    sheet: serviceMetadata.sheet,
    serviceMetadata,
    timestamp: new Date().toISOString(),
  };
}

function handleSummary(): Response {
  const forecastSummary = financeService.getForecastSummaryData();
  const overview = financeService.getOverviewData();
  const accounts = financeService.getAccountsLiquidityData();
  const receivables = financeService.getReceivablesData();
  const payables = financeService.getPayablesData();

  return json({
    timestamp: new Date().toISOString(),
    summaryText: financeService.summary(),
    assistantContext: financeService.buildAssistantContext(),
    overview,
    accounts,
    receivables: {
      totals: receivables.totals,
      next: receivables.next,
      overdue: receivables.overdue,
      upcoming: receivables.upcoming,
    },
    payables: {
      totals: payables.totals,
      next: payables.next,
      overdue: payables.overdue,
    },
    forecast: {
      year: forecastSummary.year,
      standing: forecastSummary.standing,
      expenses: forecastSummary.expenses,
      scenarios: forecastSummary.scenarios,
      currentTaxRates: forecastSummary.currentTaxRates,
    },
  });
}

function handleOverview(): Response {
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.getOverviewData(),
  });
}

function handleSignals(url: URL): Response {
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.getDashboardSignalsData(parseReferenceDate(url) ?? new Date()),
  });
}

function handleBudget(url: URL): Response {
  const date = parseReferenceDate(url);
  const weeklyLimit = parseNumberParam(url.searchParams.get("weeklyLimit"), "weeklyLimit", {
    minExclusive: 0,
  });
  const periods = parseIntegerParam(url.searchParams.get("periods"), "periods", {
    min: 1,
    max: 104,
  });

  return json({
    timestamp: new Date().toISOString(),
    snapshot: financeService.getBudgetSnapshot({ date, weeklyLimit }),
    history: financeService.getBudgetHistoryData({ date, periods }),
    applied: {
      date: date ?? null,
      weeklyLimit: weeklyLimit ?? null,
      periods: periods ?? null,
      historyUsesConfiguredLimits: weeklyLimit == null,
    },
  });
}

function handleSpendingBreakdown(url: URL): Response {
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.getCategoryAggregates(parseTransactionFilters(url)),
  });
}

function handleTransactions(url: URL): Response {
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.listTransactionsStructured(parseTransactionFilters(url)),
  });
}

function handleReviewGet(url: URL): Response {
  const limit = parseIntegerParam(url.searchParams.get("limit"), "limit", { min: 1, max: 250 }) ?? 25;
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.getReviewQueueData(limit),
  });
}

async function handleReviewPost(request: Request, url: URL): Promise<Response> {
  const decisions = await parseReviewRequest(request);
  const limit = parseIntegerParam(url.searchParams.get("limit"), "limit", { min: 1, max: 250 }) ?? 25;
  const result = financeService.categorize(decisions);
  return json({
    timestamp: new Date().toISOString(),
    result,
    queue: financeService.getReviewQueueData(limit),
  });
}

function handleReceivables(url: URL): Response {
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.getReceivablesData({
      today: parseOptionalStringParam(url.searchParams.get("today"), "today", 32),
      horizonDays: parseIntegerParam(url.searchParams.get("horizonDays"), "horizonDays", { min: 1, max: 365 }),
      status: parseOptionalStringParam(url.searchParams.get("status"), "status", 40),
    }),
  });
}

function handlePayables(url: URL): Response {
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.getPayablesData({
      today: parseOptionalStringParam(url.searchParams.get("today"), "today", 32),
      status: parseOptionalStringParam(url.searchParams.get("status"), "status", 40),
    }),
  });
}

function handleRecurring(url: URL): Response {
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.getRecurringData({
      today: parseOptionalStringParam(url.searchParams.get("today"), "today", 32),
      refresh: parseBooleanParam(url.searchParams.get("refresh"), "refresh") ?? false,
      noAutoSeed: parseBooleanParam(url.searchParams.get("noAutoSeed"), "noAutoSeed") ?? false,
      seedLimit: parseIntegerParam(url.searchParams.get("seedLimit"), "seedLimit", { min: 1, max: 100 }),
    }),
  });
}

function handleRecurringRefresh(url: URL): Response {
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.getRecurringData({
      today: parseOptionalStringParam(url.searchParams.get("today"), "today", 32),
      refresh: true,
      noAutoSeed: parseBooleanParam(url.searchParams.get("noAutoSeed"), "noAutoSeed") ?? false,
      seedLimit: parseIntegerParam(url.searchParams.get("seedLimit"), "seedLimit", { min: 1, max: 100 }),
    }),
  });
}

function handleFxEvents(): Response {
  const fx = financeService.getFxInfoData();
  return json({
    timestamp: new Date().toISOString(),
    pair: fx.pair,
    activeRate: fx.activeRate,
    latestEvent: fx.latestEvent,
    events: fx.events,
  });
}

async function handleImportPost(request: Request): Promise<Response> {
  const options = await parseImportRequest(request);
  const result = await financeService.importTransactions(options);
  return json({
    timestamp: new Date().toISOString(),
    result,
    metadata: financeService.getMetadataData(),
    accounts: financeService.getAccountsLiquidityData(),
  });
}

async function handleSettingsPost(request: Request): Promise<Response> {
  const settings = parseSettingsUpdate(await readJsonObject(request));
  return json({
    timestamp: new Date().toISOString(),
    metadata: financeService.updateSettings(settings),
  });
}

function handleWhatIfGet(url: URL): Response {
  const input = parseWhatIfFromQuery(url);
  if (input.purchaseAmountCad == null) {
    throw new HttpError(400, "purchaseAmountCad is required.");
  }
  const normalizedInput: FinanceWhatIfInput = {
    purchaseAmountCad: input.purchaseAmountCad,
    date: input.date,
    countsTowardBudget: input.countsTowardBudget,
  };
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.simulatePurchaseImpact(normalizedInput),
  });
}

async function handleWhatIfPost(request: Request): Promise<Response> {
  return json({
    timestamp: new Date().toISOString(),
    ...financeService.simulatePurchaseImpact(await parseWhatIfFromBody(request)),
  });
}

function describeStartupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/address already in use|eaddrinuse|port\s+\d+\s+is\s+already\s+in\s+use|is port \d+ in use/i.test(message)) {
    return `Port ${port} is already in use. Stop any existing 'bun web/finance/server.ts' process or choose another PORT.`;
  }
  return message;
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/health") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return json({ ok: true, service: "finance-dashboard", timestamp: new Date().toISOString() });
  }

  if (url.pathname === "/api/finance/metadata") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return json(buildMetadata());
  }

  if (url.pathname === "/api/finance/summary") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleSummary();
  }

  if (url.pathname === "/api/finance/overview") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleOverview();
  }

  if (url.pathname === "/api/finance/signals") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleSignals(url);
  }

  if (url.pathname === "/api/finance/budget") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleBudget(url);
  }

  if (url.pathname === "/api/finance/spending-breakdown") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleSpendingBreakdown(url);
  }

  if (url.pathname === "/api/finance/transactions") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleTransactions(url);
  }

  if (url.pathname === "/api/finance/transactions/aggregates") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleSpendingBreakdown(url);
  }

  if (url.pathname === "/api/finance/review") {
    if (request.method === "GET") {
      return handleReviewGet(url);
    }
    if (request.method === "POST") {
      return handleReviewPost(request, url);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  if (url.pathname === "/api/finance/accounts") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return json({
      timestamp: new Date().toISOString(),
      ...financeService.getAccountsLiquidityData(),
    });
  }

  if (url.pathname === "/api/finance/receivables") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleReceivables(url);
  }

  if (url.pathname === "/api/finance/payables") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handlePayables(url);
  }

  if (url.pathname === "/api/finance/recurring") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleRecurring(url);
  }

  if (url.pathname === "/api/finance/recurring/refresh") {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    return handleRecurringRefresh(url);
  }

  if (url.pathname === "/api/finance/income-sources") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return json({
      timestamp: new Date().toISOString(),
      ...financeService.getIncomeSourcesData(),
    });
  }

  if (url.pathname === "/api/finance/fx") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return json({
      timestamp: new Date().toISOString(),
      ...financeService.getFxInfoData(),
    });
  }

  if (url.pathname === "/api/finance/fx/events") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleFxEvents();
  }

  if (url.pathname === "/api/finance/import-runs") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const limit = parseIntegerParam(url.searchParams.get("limit"), "limit", { min: 1, max: 100 }) ?? 20;
    return json({
      timestamp: new Date().toISOString(),
      ...financeService.listImportRunsData(limit),
    });
  }

  if (url.pathname === "/api/finance/import") {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    return handleImportPost(request);
  }

  if (url.pathname === "/api/finance/settings") {
    if (request.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    return handleSettingsPost(request);
  }

  if (url.pathname === "/api/finance/forecast/summary") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return json({
      timestamp: new Date().toISOString(),
      ...financeService.getForecastSummaryData(),
    });
  }

  if (url.pathname === "/api/finance/forecast/cashflow") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return json({
      timestamp: new Date().toISOString(),
      ...financeService.getForecastCashflowData(),
    });
  }

  if (url.pathname === "/api/finance/forecast/tax") {
    if (request.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return json({
      timestamp: new Date().toISOString(),
      ...financeService.getTaxProjectionData(),
    });
  }

  if (url.pathname === "/api/finance/what-if") {
    if (request.method === "GET") {
      return handleWhatIfGet(url);
    }
    if (request.method === "POST") {
      return handleWhatIfPost(request);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  return notFound(`Unknown API route: ${url.pathname}`);
}

const server = (() => {
  try {
    return Bun.serve({
    port,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);

      try {
        if (url.pathname.startsWith("/api/")) {
          return await handleApi(request, url);
        }

        return serveStatic(url.pathname);
      } catch (error) {
        return errorResponse(error);
      }
    },
    error(error) {
      return errorResponse(error);
    },
    });
  } catch (error) {
    financeService.close();
    console.error(`[finance-dashboard] Startup failed: ${describeStartupError(error)}`);
    process.exit(1);
  }
})();

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[finance-dashboard] Received ${signal}; shutting down.`);
  server.stop(true);
  financeService.close();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

console.log(`[finance-dashboard] Running at http://localhost:${server.port}`);
console.log(`[finance-dashboard] UI root: ${relativeToRepo(uiRoot)}`);
console.log(`[finance-dashboard] Finance DB: ${relativeToRepo(financeService.getDatabasePath())}`);
console.log(`[finance-dashboard] Forecast config: ${relativeToRepo(financeService.getForecastConfigPath())}`);
console.log(`[finance-dashboard] Default port: ${DEFAULT_PORT}`);
