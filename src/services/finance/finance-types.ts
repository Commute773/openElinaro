import type { FinanceForecastConfig } from "../../config/finance-config";

export type SqlValue = string | number | bigint | boolean | null;

export interface FinanceHistoryOptions {
  month?: string;
  fromDate?: string;
  toDate?: string;
  account?: string;
  category?: string;
  search?: string;
  onlyBudget?: boolean;
  onlyReview?: boolean;
  limit?: number;
}

export interface FinanceCategorizeDecision {
  id?: number;
  externalId?: string;
  category?: string | null;
  countsTowardBudget?: boolean | null;
  descriptionClean?: string | null;
  note?: string | null;
}

export interface FinanceImportOptions {
  source?: "fintable_gsheet" | "csv";
  dryRun?: boolean;
  spreadsheetId?: string;
  accountsGid?: string;
  transactionsGid?: string;
  csvText?: string;
}

export interface FinanceSettingsUpdateInput {
  timezone?: string;
  weeklyLimitCad?: number;
  monthlyLimitCad?: number;
  weeklyStartDate?: string;
  fxUsdCad?: number;
  spreadsheetId?: string;
  accountsGid?: string;
  transactionsGid?: string;
}

export interface FinanceAddExpenseInput {
  postedDate: string;
  amount: number;
  currency?: string;
  merchant?: string;
  description?: string;
  account?: string;
  category?: string;
  counts?: boolean;
  note?: string;
}

export interface FinanceAddReceivableInput {
  counterparty: string;
  amount?: number;
  amountCad?: number;
  currency?: string;
  earnedDate: string;
  expectedDate: string;
  status?: string;
  notes?: string;
}

export interface FinanceAddRecurringInput {
  name: string;
  matchKind?: string;
  matchValue: string;
  intervalKind?: string;
  intervalDays?: number;
  amountCad: number;
  amountToleranceCad?: number;
  currency?: string;
  graceDays?: number;
  nextExpectedDate?: string | null;
  lastSeenDate?: string | null;
  status?: string;
  notes?: string;
}

export interface FinanceSetRecurringInput {
  id?: number;
  name?: string;
  matchKind?: string;
  matchValue?: string;
  intervalKind?: string;
  intervalDays?: number;
  amountCad?: number;
  amountToleranceCad?: number;
  currency?: string;
  graceDays?: number;
  nextExpectedDate?: string | null;
  lastSeenDate?: string | null;
  status?: string;
  notes?: string;
}

export interface FinanceAddPayableInput {
  counterparty: string;
  description?: string;
  amount: number;
  currency?: string;
  amountCad?: number;
  dueDate: string;
  certainty?: "confirmed" | "expected" | "speculative";
  category?: string;
  notes?: string;
}

export interface FinanceAddIncomeSourceInput {
  name: string;
  type?: string;
  currency?: string;
  amountPerPeriod: number;
  period?: string;
  billing?: string;
  startDate: string;
  endDate?: string;
  confirmed?: boolean;
  guaranteedMonths?: number;
  notes?: string;
}

export interface FinanceAddFxEventInput {
  date: string;
  amountFrom: number;
  currencyFrom?: string;
  amountTo: number;
  currencyTo?: string;
  method?: string;
  notes?: string;
}

export interface FinanceUpsertAccountOptions {
  importRunId?: number;
  source?: string;
}

export interface FinanceSyntheticIncomeInput {
  externalId?: string;
  source?: string;
  accountExternalId?: string | null;
  accountName?: string | null;
  postedDate: string;
  amountCad: number;
  currency?: string;
  amount?: number;
  description: string;
  merchantName?: string | null;
  category?: string;
  note?: string | null;
  rawJson?: Record<string, unknown> | null;
}

export type FinanceBudgetSnapshot =
  | {
      mode: "week";
      date: string;
      weekIndex: number;
      weekStart: string;
      weekEndExclusive: string;
      weeklyLimitCad: number;
      carryIn: number;
      available: number;
      spentCad: number;
      grossSpentCad: number;
      incomeCad: number;
      remaining: number;
      expectedToDate: number;
      paceDelta: number;
      uncertainSpentCad: number;
      unknownFxSpend: number;
    }
  | {
      mode: "month";
      month: string;
      from: string;
      toExclusive: string;
      limitCad: number;
      spentCad: number;
      grossSpentCad: number;
      incomeCad: number;
      remaining: number;
      expectedToDate: number;
      paceDelta: number;
      uncertainSpentCad: number;
      unknownFxSpend: number;
    };

export type CategorizationRuleRow = {
  id: number;
  pattern: string;
  match_field: string;
  category: string;
  counts_toward_budget: number | null;
  confidence: number;
};

export type TransactionRow = Record<string, unknown>;

export type TaxConfig = FinanceForecastConfig["tax"];
export type IncomeSourceRecord = Record<string, unknown>;
export type RecurringRecord = Record<string, unknown>;
export type PayableRecord = Record<string, unknown>;
export type AccountBalanceRecord = Record<string, unknown>;
export type ReceivableRecord = Record<string, unknown>;

export type FinanceBudgetSnapshotData =
  | {
      mode: "week";
      date: string;
      weekIndex: number;
      weekStart: string;
      weekEndExclusive: string;
      weeklyLimitCad: number;
      carryIn: number;
      available: number;
      spentCad: number;
      grossSpentCad: number;
      incomeCad: number;
      remaining: number;
      expectedToDate: number;
      paceDelta: number;
      uncertainSpentCad: number;
      unknownFxSpend: number;
    }
  | {
      mode: "month";
      month: string;
      from: string;
      toExclusive: string;
      limitCad: number;
      spentCad: number;
      grossSpentCad: number;
      incomeCad: number;
      remaining: number;
      expectedToDate: number;
      paceDelta: number;
      uncertainSpentCad: number;
      unknownFxSpend: number;
    };

export interface FinanceBudgetHistoryEntryData {
  snapshot: FinanceBudgetSnapshotData;
  burnRate: number;
}

export interface FinanceBudgetHistoryData {
  mode: "week" | "month";
  periods: number;
  current: FinanceBudgetSnapshotData;
  rows: FinanceBudgetHistoryEntryData[];
}

export interface FinanceSheetInfoData {
  spreadsheetId: string;
  accountsGid: string;
  transactionsGid: string;
  sheetUrl: string;
  accountsCsvUrl: string;
  transactionsCsvUrl: string;
}

export interface FinanceTransactionCategoryData {
  raw: string | null;
  auto: string | null;
  user: string | null;
  final: string;
  autoConfidence: number | null;
}

export interface FinanceTransactionCountData {
  raw: boolean | null;
  auto: boolean | null;
  user: boolean | null;
  final: boolean;
}

export interface FinanceTransactionReviewData {
  needsReview: boolean;
  reason: string | null;
  reasonParts: string[];
}

export interface FinanceNormalizedTransaction {
  id: number;
  externalId: string | null;
  source: string;
  accountExternalId: string | null;
  accountName: string | null;
  postedDate: string;
  authorizedDate: string | null;
  amount: number;
  currency: string;
  amountCad: number | null;
  amountCadResolved: number | null;
  direction: "credit" | "debit" | "zero";
  descriptionRaw: string | null;
  descriptionClean: string | null;
  descriptionFinal: string | null;
  merchantName: string | null;
  category: FinanceTransactionCategoryData;
  countsTowardBudget: FinanceTransactionCountData;
  review: FinanceTransactionReviewData;
  flags: {
    isTransfer: boolean;
    isCcPayment: boolean;
  };
  note: string | null;
  importedAt: string | null;
}

export interface FinanceTransactionFilterData {
  month: string | null;
  fromDate: string | null;
  toDate: string | null;
  account: string | null;
  category: string | null;
  search: string | null;
  onlyBudget: boolean;
  onlyReview: boolean;
}

export interface FinanceTransactionsData {
  total: number;
  limit: number;
  filters: FinanceTransactionFilterData;
  rows: FinanceNormalizedTransaction[];
}

export interface FinanceReviewQueueData {
  total: number;
  limit: number;
  rows: FinanceNormalizedTransaction[];
  reasonBreakdown: Array<{
    reason: string;
    count: number;
  }>;
  categoryBreakdown: Array<{
    category: string;
    count: number;
  }>;
}

export interface FinanceAccountLiquidityRow {
  id: number;
  externalId: string | null;
  name: string;
  institution: string | null;
  currency: string;
  balance: number;
  balanceCad: number;
  classification: "liquid" | "registered" | "debt";
  lastUpdate: string | null;
  updatedAt: string | null;
}

export interface FinanceAccountsLiquidityData {
  fxRate: number;
  accounts: FinanceAccountLiquidityRow[];
  liquid: FinanceAccountLiquidityRow[];
  registered: FinanceAccountLiquidityRow[];
  debt: FinanceAccountLiquidityRow[];
  totals: {
    liquidCad: number;
    registeredCad: number;
    debtCad: number;
    netLiquidCad: number;
  };
}

export interface FinanceReceivableItemData {
  id: number;
  counterparty: string;
  amount: number | null;
  currency: string;
  amountCad: number | null;
  convertedCad: number;
  earnedDate: string;
  expectedDate: string;
  status: string;
  lastFollowupDate: string | null;
  notes: string | null;
  isOverdue: boolean;
  nextAction: string;
}

export interface FinanceReceivablesData {
  today: string;
  horizonDays: number;
  horizonDate: string;
  totals: {
    pendingCad: number;
    overdueCad: number;
    upcomingCad: number;
  };
  next: FinanceReceivableItemData | null;
  overdue: FinanceReceivableItemData[];
  upcoming: FinanceReceivableItemData[];
  rows: FinanceReceivableItemData[];
}

export interface FinancePayableItemData {
  id: number;
  counterparty: string;
  description: string | null;
  amount: number;
  currency: string;
  amountCad: number | null;
  convertedCad: number;
  dueDate: string;
  certainty: "confirmed" | "expected" | "speculative";
  category: string | null;
  status: string;
  notes: string | null;
  isOverdue: boolean;
}

export interface FinancePayablesData {
  today: string;
  totals: {
    confirmedCad: number;
    expectedCad: number;
    speculativeCad: number;
    totalCad: number;
  };
  next: FinancePayableItemData | null;
  overdue: FinancePayableItemData[];
  rows: FinancePayableItemData[];
}

export interface FinanceFxEventData {
  id: number;
  eventDate: string;
  amountFrom: number;
  currencyFrom: string;
  amountTo: number;
  currencyTo: string;
  rate: number;
  method: string | null;
  notes: string | null;
  createdAt: string | null;
}

export interface FinanceFxInfoData {
  activeRate: number;
  pair: string;
  settingsKey: string;
  latestEvent: FinanceFxEventData | null;
  events: FinanceFxEventData[];
  note: string;
}

export interface FinanceRecurringItemData {
  id: number;
  name: string;
  matchKind: string;
  matchValue: string;
  intervalKind: string;
  intervalDays: number | null;
  amountCad: number;
  amountToleranceCad: number;
  currency: string;
  monthlyCad: number;
  nextExpectedDate: string | null;
  lastSeenDate: string | null;
  status: string;
  graceDays: number;
  notes: string | null;
  isPastDue: boolean;
}

export interface FinanceRecurringCandidateData {
  name: string;
  matchKind: string;
  matchValue: string;
  intervalKind: string;
  intervalDays: number | null;
  amountCad: number;
  currency: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  nextExpectedDate: string;
  status: string;
  graceDays: number;
  existingRecurringId: number | null;
  alreadyTracked: boolean;
}

export interface FinanceRecurringData {
  today: string;
  totalMonthlyCad: number;
  active: FinanceRecurringItemData[];
  halted: FinanceRecurringItemData[];
  rows: FinanceRecurringItemData[];
  candidates: FinanceRecurringCandidateData[];
  refresh: {
    seeded: FinanceRecurringItemData[];
    active: FinanceRecurringItemData[];
    halted: FinanceRecurringItemData[];
  } | null;
}

export interface FinanceImportRunRowData {
  id: number;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  rowsSeen: number;
  rowsInserted: number;
  rowsUpdated: number;
  error: string | null;
  durationMs: number | null;
}

export interface FinanceImportRunsData {
  limit: number;
  rows: FinanceImportRunRowData[];
  bySource: Array<{
    source: string;
    runCount: number;
    rowsSeen: number;
    rowsInserted: number;
    rowsUpdated: number;
    errorCount: number;
  }>;
}

export interface FinanceCategoryAggregateData {
  category: string;
  transactionCount: number;
  spendCad: number;
  incomeCad: number;
  netCad: number;
  averageSpendCad: number;
  budgetCountedTransactionCount: number;
  reviewCount: number;
  unknownFxCount: number;
}

export interface FinanceMerchantAggregateData {
  merchant: string;
  transactionCount: number;
  spendCad: number;
  incomeCad: number;
  netCad: number;
  budgetCountedTransactionCount: number;
  reviewCount: number;
}

export interface FinanceTimelineAggregateData {
  bucket: string;
  transactionCount: number;
  spendCad: number;
  incomeCad: number;
  netCad: number;
  budgetSpendCad: number;
  budgetIncomeCad: number;
  budgetNetCad: number;
}

export interface FinanceCategoryAggregatesData {
  filters: FinanceTransactionFilterData;
  totalSpendCad: number;
  totalIncomeCad: number;
  totalNetCad: number;
  totalBudgetNetCad: number;
  groups: FinanceCategoryAggregateData[];
  merchants: FinanceMerchantAggregateData[];
  timeline: FinanceTimelineAggregateData[];
}
