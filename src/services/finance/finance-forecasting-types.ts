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
