import type {
  FinanceAccountsLiquidityData,
  FinanceBudgetHistoryData,
  FinanceCategoryAggregatesData,
  FinanceDashboardSignalsData,
  FinanceForecastCashflowData,
  FinanceForecastSummaryData,
  FinanceFxInfoData,
  FinanceImportRunsData,
  FinanceIncomeSourcesData,
  FinanceMetadataData,
  FinanceOverviewData,
  FinancePayablesData,
  FinanceReceivablesData,
  FinanceRecurringData,
  FinanceReviewQueueData,
  FinanceTaxProjectionData,
  FinanceTransactionsData,
  FinanceWhatIfData,
} from "../../../src/services/finance-dashboard-types.ts";

export interface FinanceMetadataEnvelope {
  app: string;
  defaultPort: number;
  requestedPort: number;
  timestamp: string;
  serviceMetadata: FinanceMetadataData;
}

export interface FinanceBudgetEnvelope {
  timestamp: string;
  snapshot: FinanceOverviewData["budget"];
  history: FinanceBudgetHistoryData;
  applied: {
    date: string | null;
    weeklyLimit: number | null;
    periods: number | null;
    historyUsesConfiguredLimits: boolean;
  };
}

export interface FinanceImportResponse {
  timestamp: string;
  result: {
    source: string;
    dryRun: boolean;
    rowsSeen: number;
    rowsInserted: number;
    rowsUpdated: number;
    sheet?: {
      sheetUrl: string;
      accountsCsvUrl: string;
      transactionsCsvUrl: string;
    };
    needsReviewTop?: Array<{
      id: number;
      posted_date: string;
      amount: number;
      currency: string;
      amount_cad: number | null;
      merchant: string;
      category: string;
      counts: number;
      review_reason: string | null;
    }>;
  };
  metadata: FinanceMetadataData;
  accounts: FinanceAccountsLiquidityData;
}

export interface ReviewDecisionInput {
  id?: number;
  externalId?: string;
  category?: string | null;
  countsTowardBudget?: boolean | null;
  descriptionClean?: string | null;
  note?: string | null;
}

export interface SettingsUpdateInput {
  timezone?: string;
  weeklyLimitCad?: number;
  monthlyLimitCad?: number;
  weeklyStartDate?: string;
  fxUsdCad?: number;
  spreadsheetId?: string;
  accountsGid?: string;
  transactionsGid?: string;
}

export interface TransactionsFilterInput {
  month?: string;
  search?: string;
  account?: string;
  category?: string;
  limit?: number;
  onlyBudget?: boolean;
  onlyReview?: boolean;
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return payload as T;
}

function buildQuery(filters: object) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
    if (value === undefined || value === "" || value === false) {
      continue;
    }
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function getMetadata() {
  return request<FinanceMetadataEnvelope>("/api/finance/metadata");
}

export function getOverview() {
  return request<FinanceOverviewData & { timestamp: string }>("/api/finance/overview");
}

export function getSignals() {
  return request<FinanceDashboardSignalsData & { timestamp: string }>("/api/finance/signals");
}

export function getAccounts() {
  return request<FinanceAccountsLiquidityData & { timestamp: string }>("/api/finance/accounts");
}

export function getBudget(periods = 12) {
  return request<FinanceBudgetEnvelope>(`/api/finance/budget${buildQuery({ periods })}`);
}

export function getSpending(filters: { month?: string; fromDate?: string; toDate?: string }) {
  return request<FinanceCategoryAggregatesData & { timestamp: string }>(
    `/api/finance/transactions/aggregates${buildQuery(filters)}`,
  );
}

export function getReceivables() {
  return request<FinanceReceivablesData & { timestamp: string }>("/api/finance/receivables");
}

export function getPayables() {
  return request<FinancePayablesData & { timestamp: string }>("/api/finance/payables");
}

export function getRecurring(refresh = false) {
  return request<FinanceRecurringData & { timestamp: string }>(
    `/api/finance/recurring${buildQuery({ refresh })}`,
  );
}

export function getForecastSummary() {
  return request<FinanceForecastSummaryData & { timestamp: string }>("/api/finance/forecast/summary");
}

export function getForecastCashflow() {
  return request<FinanceForecastCashflowData & { timestamp: string }>("/api/finance/forecast/cashflow");
}

export function getTaxProjection() {
  return request<FinanceTaxProjectionData & { timestamp: string }>("/api/finance/forecast/tax");
}

export function getIncomeSources() {
  return request<FinanceIncomeSourcesData & { timestamp: string }>("/api/finance/income-sources");
}

export function getImportRuns(limit = 12) {
  return request<FinanceImportRunsData & { timestamp: string }>(
    `/api/finance/import-runs${buildQuery({ limit })}`,
  );
}

export function getReview(limit = 25) {
  return request<FinanceReviewQueueData & { timestamp: string }>(
    `/api/finance/review${buildQuery({ limit })}`,
  );
}

export function getTransactions(filters: TransactionsFilterInput) {
  return request<FinanceTransactionsData & { timestamp: string }>(
    `/api/finance/transactions${buildQuery(filters)}`,
  );
}

export function getFxInfo() {
  return request<FinanceFxInfoData & { timestamp: string }>("/api/finance/fx");
}

export function simulateWhatIf(input: {
  purchaseAmountCad: number;
  countsTowardBudget: boolean;
  date?: string;
}) {
  return request<FinanceWhatIfData & { timestamp: string }>("/api/finance/what-if", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function submitReview(decisions: ReviewDecisionInput[]) {
  return request<{ queue: FinanceReviewQueueData; timestamp: string }>("/api/finance/review", {
    method: "POST",
    body: JSON.stringify({ decisions }),
  });
}

export function saveSettings(input: SettingsUpdateInput) {
  return request<{ metadata: FinanceMetadataData; timestamp: string }>("/api/finance/settings", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function importFinance(input: {
  source: "fintable_gsheet" | "csv";
  dryRun?: boolean;
  spreadsheetId?: string;
  accountsGid?: string;
  transactionsGid?: string;
  csvText?: string;
}) {
  return request<FinanceImportResponse>("/api/finance/import", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
