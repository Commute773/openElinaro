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
