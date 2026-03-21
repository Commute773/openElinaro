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

export interface FinanceIncomeProjectionItemData {
  name: string;
  annualOrig: number;
  currency: string;
  annualCad: number;
  confirmed: boolean;
  note?: string;
  monthsActive?: number;
}

export interface FinanceIncomeProjectionData {
  items: FinanceIncomeProjectionItemData[];
  totalCad: number;
}

export interface FinanceIncomeSourceRowData {
  id: number;
  name: string;
  type: string;
  currency: string;
  amountPerPeriod: number;
  period: string;
  billing: string | null;
  startDate: string;
  endDate: string | null;
  confirmed: boolean;
  guaranteedMonths: number;
  notes: string | null;
  monthlyEquivalent: number;
  annualOrigConservative: number;
  annualOrigOptimistic: number;
  annualCadConservative: number;
  annualCadOptimistic: number;
  includedInConservative: boolean;
  includedInOptimistic: boolean;
  monthsActive: number;
}

export interface FinanceIncomeSourcesData {
  fxRate: number;
  rows: FinanceIncomeSourceRowData[];
  conservativeProjection: FinanceIncomeProjectionData;
  optimisticProjection: FinanceIncomeProjectionData;
}

export interface FinanceContributionBreakdownData {
  QPP: number;
  QPP2: number;
  QPIP: number;
  FSS: number;
  total: number;
}

export interface FinanceAnnualTaxProjectionData {
  grossCad: number;
  taxable: number;
  federalTax: number;
  quebecTax: number;
  totalTax: number;
  contributions: FinanceContributionBreakdownData;
  effectiveRate: number;
  effectiveRateWithContribs: number;
  alimonyAnnual: number;
  netAfterTax: number;
  netAfterTaxAndAlimony: number;
}

export interface FinanceMonthlyTaxRateProjectionData {
  ytdIncome: number;
  annualized: number;
  rate: number;
  monthlySetAside: number;
}

export interface FinanceForecastScenarioData {
  label: "conservative" | "optimistic";
  incomeCad: number;
  tax: FinanceAnnualTaxProjectionData;
  annualExpensesCad: number;
  monthlyExpensesCad: number;
  annualSurplusCad: number;
  monthlySurplusCad: number;
  monthlyBurnCad: number;
  runwayMonths: number | null;
}

export interface FinanceCashflowMonthData {
  month: string;
  incomeCad: number;
  expensesCad: number;
  discretionaryCad: number;
  taxSetAside: number;
  apDue: number;
  arExpected: number;
  totalOut: number;
  net: number;
  cumulativeCad: number;
}

export interface FinanceForecastSummaryData {
  year: number;
  fxRate: number;
  standing: {
    liquidCad: number;
    debtCad: number;
    registeredCad: number;
    netLiquidCad: number;
    pendingReceivablesCad: number;
    confirmedPayablesCad: number;
    allPayablesCad: number;
    netPositionConfirmedCad: number;
    netPositionAllCad: number;
  };
  income: {
    conservative: FinanceIncomeProjectionData;
    optimistic: FinanceIncomeProjectionData;
  };
  expenses: {
    recurringMonthlyCad: number;
    discretionaryMonthlyCad: number;
    totalMonthlyCad: number;
    totalAnnualCad: number;
  };
  scenarios: {
    conservative: FinanceForecastScenarioData;
    optimistic: FinanceForecastScenarioData;
  };
  currentTaxRates: {
    monthNumber: number;
    conservative: FinanceMonthlyTaxRateProjectionData;
    optimistic: FinanceMonthlyTaxRateProjectionData;
  };
}

export interface FinanceForecastCashflowData {
  year: number;
  fxRate: number;
  startingLiquidCad: number;
  conservative: FinanceCashflowMonthData[];
  optimistic: FinanceCashflowMonthData[];
}

export interface FinanceTaxProjectionData {
  year: number;
  fxRate: number;
  conservative: {
    annual: FinanceAnnualTaxProjectionData;
    currentRate: FinanceMonthlyTaxRateProjectionData;
  };
  optimistic: {
    annual: FinanceAnnualTaxProjectionData;
    currentRate: FinanceMonthlyTaxRateProjectionData;
  };
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
