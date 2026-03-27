export type {
  FinanceBudgetSnapshotData,
  FinanceBudgetHistoryEntryData,
  FinanceBudgetHistoryData,
  FinanceSheetInfoData,
  FinanceTransactionCategoryData,
  FinanceTransactionCountData,
  FinanceTransactionReviewData,
  FinanceNormalizedTransaction,
  FinanceTransactionFilterData,
  FinanceTransactionsData,
  FinanceReviewQueueData,
  FinanceAccountLiquidityRow,
  FinanceAccountsLiquidityData,
  FinanceReceivableItemData,
  FinanceReceivablesData,
  FinancePayableItemData,
  FinancePayablesData,
  FinanceFxEventData,
  FinanceFxInfoData,
  FinanceRecurringItemData,
  FinanceRecurringCandidateData,
  FinanceRecurringData,
  FinanceImportRunRowData,
  FinanceImportRunsData,
  FinanceCategoryAggregateData,
  FinanceMerchantAggregateData,
  FinanceTimelineAggregateData,
  FinanceCategoryAggregatesData,
} from "./finance/finance-types";

export type {
  FinanceIncomeProjectionItemData,
  FinanceIncomeProjectionData,
  FinanceIncomeSourceRowData,
  FinanceIncomeSourcesData,
  FinanceContributionBreakdownData,
  FinanceAnnualTaxProjectionData,
  FinanceMonthlyTaxRateProjectionData,
  FinanceForecastScenarioData,
  FinanceCashflowMonthData,
  FinanceForecastSummaryData,
  FinanceForecastCashflowData,
  FinanceTaxProjectionData,
} from "./finance/finance-forecasting-types";

import type {
  FinanceBudgetSnapshotData,
  FinanceReceivableItemData,
  FinancePayableItemData,
  FinanceSheetInfoData,
  FinanceImportRunRowData,
} from "./finance/finance-types";

export interface FinanceMetadataData {
  generatedAt: string;
  databasePath: string;
  forecastConfigPath: string;
  sheet: FinanceSheetInfoData;
  settings: {
    timezone: string | null;
    weeklyLimitCad: number;
    monthlyLimitCad: number;
    weeklyStartDate: string | null;
    fxUsdCad: number;
  };
  reviewCount: number;
  forecastConfig: {
    version: number;
    year: number;
    province: string;
    filingStatus: string;
    note: string;
  };
  tableCounts: Array<{
    table: string;
    count: number;
  }>;
  transactionSourceCounts: Array<{
    source: string;
    count: number;
  }>;
  finalBudgetCountBreakdown: Array<{
    countsTowardBudget: boolean;
    count: number;
  }>;
  latestImportRun: FinanceImportRunRowData | null;
}

export interface FinanceOverviewData {
  referenceDate: string;
  budget: FinanceBudgetSnapshotData;
  paceIndicator: string;
  reviewCount: number;
  netLiquidCad: number;
  pendingReceivablesCad: number;
  confirmedPayablesCad: number;
  netPositionConfirmedCad: number;
  netPositionAllCad: number;
  nextReceivable: FinanceReceivableItemData | null;
  nextPayable: FinancePayableItemData | null;
}

export interface FinanceDashboardAlertData {
  id: string;
  tone: "critical" | "warning" | "positive" | "neutral";
  title: string;
  detail: string;
}

export interface FinanceDashboardReminderData {
  id: string;
  tone: "critical" | "warning" | "positive" | "neutral";
  title: string;
  dueDate: string;
  amountCad: number;
  detail: string;
}

export interface FinanceDashboardCategoryDeltaData {
  category: string;
  currentSpendCad: number;
  previousSpendCad: number;
  deltaCad: number;
  reviewCount: number;
}

export interface FinanceDashboardHorizonPlanData {
  days: number;
  startingCashCad: number;
  taxReserveCad: number;
  currentTaxBackpayCad: number;
  afterTaxReserveCad: number;
  afterCurrentTaxBackpayCad: number;
  expectedReceivablesCad: number;
  forecastIncomeCad: number;
  forecastTaxReserveCad: number;
  budgetedSpendCad: number;
  payableOutflowsCad: number;
  recurringOutflowsCad: number;
  knownOutflowsCad: number;
  projectedTaxReserveCad: number;
  projectedTaxShortfallCad: number;
  projectedCad: number;
  projectedAfterCurrentTaxBackpayCad: number;
  status: "on_track" | "short";
}

export interface FinanceDashboardSignalsData {
  referenceDate: string;
  currentMonth: string;
  previousMonth: string;
  spend: {
    currentMonthTotalCad: number;
    currentMonthDiscretionaryCad: number;
    ytdTotalCad: number;
    ytdDiscretionaryCad: number;
  };
  tax: {
    dueNowCad: number;
    taxAccountBalanceCad: number;
    coverageCad: number;
    enoughInTaxAccount: boolean;
    estimatedTaxOnReceivedIncomeCad: number;
    estimatedTaxRateOnReceivedIncome: number;
    estimatedTaxShortfallCad: number;
    enoughReservedForEstimatedTax: boolean;
  };
  income: {
    clientIncomeReceivedYtdCad: number;
    clientIncomeReceivedYtdUsd: number;
    expectedConfirmedReceivedYtdCad: number;
    expectedConfirmedReceivedYtdUsd: number;
    importGapCad: number;
    importLooksWrong: boolean;
  };
  currentBudgetNetCad: number;
  previousBudgetNetCad: number;
  currentSpendCad: number;
  previousSpendCad: number;
  trailingThreeMonthBudgetAverageCad: number | null;
  horizons: {
    next30Days: FinanceDashboardHorizonPlanData;
    next60Days: FinanceDashboardHorizonPlanData;
    endOfYear: FinanceDashboardHorizonPlanData;
    endOfYearOptimistic: FinanceDashboardHorizonPlanData;
  };
  alerts: FinanceDashboardAlertData[];
  reminders: FinanceDashboardReminderData[];
  categoryDeltas: FinanceDashboardCategoryDeltaData[];
}

export interface FinanceWhatIfInput {
  purchaseAmountCad: number;
  date?: string;
  countsTowardBudget?: boolean;
}

export interface FinanceWhatIfData {
  referenceDate: string;
  purchaseAmountCad: number;
  countsTowardBudget: boolean;
  budget: {
    before: FinanceBudgetSnapshotData;
    afterRemainingCad: number;
    afterPaceDeltaCad: number;
    withinBudget: boolean;
  };
  liquidity: {
    netLiquidBeforeCad: number;
    netLiquidAfterCad: number;
    netPositionConfirmedBeforeCad: number;
    netPositionConfirmedAfterCad: number;
    netPositionAllBeforeCad: number;
    netPositionAllAfterCad: number;
  };
  forecast: {
    conservativeAnnualSurplusBeforeCad: number;
    conservativeAnnualSurplusAfterCad: number;
    optimisticAnnualSurplusBeforeCad: number;
    optimisticAnnualSurplusAfterCad: number;
    conservativeRunwayMonthsBefore: number | null;
    conservativeRunwayMonthsAfter: number | null;
    optimisticRunwayMonthsBefore: number | null;
    optimisticRunwayMonthsAfter: number | null;
  };
}
