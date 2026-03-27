import type { Database } from "bun:sqlite";
import type {
  FinanceForecastConfig,
} from "../../config/finance-config";
import type {
  FinanceAccountLiquidityRow,
} from "./finance-types";
import type {
  FinanceAnnualTaxProjectionData,
  FinanceCashflowMonthData,
  FinanceForecastCashflowData,
  FinanceForecastScenarioData,
  FinanceForecastSummaryData,
  FinanceIncomeProjectionData,
  FinanceMonthlyTaxRateProjectionData,
  FinanceTaxProjectionData,
} from "./finance-forecasting-types";
import type {
  TaxConfig,
  IncomeSourceRecord,
  RecurringRecord,
  PayableRecord,
  ReceivableRecord,
  AccountBalanceRecord,
} from "./finance-types";
import {
  finiteNumber,
  formatCad,
  formatMoney,
  normText,
  heading,
  dateKey,
  addDays,
  daysBetween,
  startEndForMonth,
  stringOrNull,
  toCad,
} from "./finance-helpers";
import {
  allRows,
  getNumericSettingOrDefault,
  getFxRate,
} from "./finance-database";

export function calcProgressiveTax(taxable: number, brackets: Array<[number | null, number]>, personalAmount: number) {
  let income = Math.max(0, taxable - personalAmount);
  let tax = 0;
  for (const [bracketSize, rate] of brackets) {
    if (income <= 0) {
      break;
    }
    if (bracketSize == null) {
      tax += income * rate;
      income = 0;
      continue;
    }
    const taxed = Math.min(income, bracketSize);
    tax += taxed * rate;
    income -= taxed;
  }
  return tax;
}

export function calcContributions(grossCad: number, tax: TaxConfig): FinanceAnnualTaxProjectionData["contributions"] {
  const qpp = (Math.min(grossCad, tax.qpp_max_pensionable) - tax.qpp_exemption) * tax.qpp_rate;
  const qpp2 = Math.max(0, Math.min(grossCad, tax.qpp2_ceiling) - tax.qpp_max_pensionable) * tax.qpp2_rate;
  const qpip = Math.min(grossCad * tax.qpip_rate, tax.qpip_max_insurable * tax.qpip_rate);
  const fss = grossCad * tax.fss_rate;
  return {
    QPP: Math.max(0, qpp),
    QPP2: Math.max(0, qpp2),
    QPIP: Math.max(0, qpip),
    FSS: fss,
    total: Math.max(0, qpp) + Math.max(0, qpp2) + Math.max(0, qpip) + fss,
  };
}

export function calcAnnualTax(grossCad: number, config: FinanceForecastConfig): FinanceAnnualTaxProjectionData {
  const contributions = calcContributions(grossCad, config.tax);
  const qppDeduction = contributions.QPP / 2;
  const alimonyAnnual = config.deductions.alimony_monthly_cad * 12;
  const mortgageAnnual = config.deductions.mortgage_biweekly_cad * 26;
  const homeOffice = mortgageAnnual * config.deductions.home_office_pct;
  const taxable = grossCad - qppDeduction - alimonyAnnual - homeOffice;
  const federalTax = calcProgressiveTax(
    taxable,
    config.tax.federal_brackets_2025.map((entry) => [entry[0], entry[1]] as [number | null, number]),
    config.tax.federal_personal_amount,
  ) * (1 - config.tax.qc_federal_abatement);
  const quebecTax = calcProgressiveTax(
    taxable,
    config.tax.qc_brackets_2025.map((entry) => [entry[0], entry[1]] as [number | null, number]),
    config.tax.qc_personal_amount,
  );
  const totalTax = federalTax + quebecTax;
  return {
    grossCad,
    taxable,
    federalTax,
    quebecTax,
    totalTax,
    contributions,
    effectiveRate: grossCad > 0 ? totalTax / grossCad : 0,
    effectiveRateWithContribs: grossCad > 0 ? (totalTax + contributions.total) / grossCad : 0,
    alimonyAnnual,
    netAfterTax: grossCad - totalTax - contributions.total,
    netAfterTaxAndAlimony: grossCad - totalTax - contributions.total - alimonyAnnual,
  };
}

export function computeRunwayMonths(netLiquidCad: number, monthlyBurnCad: number) {
  if (monthlyBurnCad <= 0) {
    return null;
  }
  return Math.max(0, netLiquidCad) / monthlyBurnCad;
}

export function projectAnnualIncome(
  sources: IncomeSourceRecord[],
  fxRate: number,
  includeUnconfirmed: boolean,
): FinanceIncomeProjectionData {
  const today = new Date();
  const currentYear = today.getUTCFullYear();
  let totalCad = 0;
  const items: FinanceIncomeProjectionData["items"] = [];
  for (const source of sources) {
    const confirmed = Number(source.confirmed ?? 1) === 1;
    if (!confirmed && !includeUnconfirmed) {
      const guaranteedMonths = Number(source.guaranteed_months ?? 0);
      const monthly = String(source.period ?? "monthly") === "monthly"
        ? Number(source.amount_per_period ?? 0)
        : Number(source.amount_per_period ?? 0) * 26 / 12;
      const annual = monthly * guaranteedMonths;
      const annualCad = toCad(annual, String(source.currency ?? "USD"), fxRate);
      items.push({
        name: String(source.name ?? ""),
        annualOrig: annual,
        currency: String(source.currency ?? "USD"),
        annualCad,
        confirmed: false,
        note: `${guaranteedMonths} guaranteed month(s)`,
      });
      totalCad += annualCad;
      continue;
    }
    const startDate = new Date(`${String(source.start_date)}T00:00:00Z`);
    const effectiveStartMonth = Math.max(startDate.getUTCMonth() + 1, 1);
    const monthsRemaining = Math.max(0, 12 - effectiveStartMonth + 1);
    const annual = String(source.period ?? "monthly") === "biweekly"
      ? Number(source.amount_per_period ?? 0) * Math.floor(26 * monthsRemaining / 12)
      : Number(source.amount_per_period ?? 0) * monthsRemaining;
    const annualCad = toCad(annual, String(source.currency ?? "USD"), fxRate);
    items.push({
      name: String(source.name ?? ""),
      annualOrig: annual,
      currency: String(source.currency ?? "USD"),
      annualCad,
      confirmed: confirmed,
      monthsActive: currentYear === 2026 ? monthsRemaining : 12,
    });
    totalCad += annualCad;
  }
  return { items, totalCad };
}

export function calcTaxRateForMonth(
  monthNumber: number,
  monthlyIncomeCad: number,
  sources: IncomeSourceRecord[],
  fxRate: number,
  config: FinanceForecastConfig,
  includeUnconfirmed: boolean,
): FinanceMonthlyTaxRateProjectionData {
  let ytdIncome = 0;
  for (let month = 1; month <= monthNumber; month += 1) {
    const monthStart = new Date(Date.UTC(2026, month - 1, 1));
    const monthEnd = month === 12
      ? new Date(Date.UTC(2027, 0, 1))
      : new Date(Date.UTC(2026, month, 1));
    for (const source of sources) {
      const confirmed = Number(source.confirmed ?? 1) === 1;
      if (!confirmed && !includeUnconfirmed) {
        continue;
      }
      if (!confirmed) {
        const guaranteedMonths = Number(source.guaranteed_months ?? 0);
        const sourceStart = new Date(`${String(source.start_date)}T00:00:00Z`);
        const monthsSinceStart = (month - (sourceStart.getUTCMonth() + 1)) + (2026 - sourceStart.getUTCFullYear()) * 12;
        if (monthsSinceStart >= guaranteedMonths) {
          continue;
        }
      }
      const sourceStart = new Date(`${String(source.start_date)}T00:00:00Z`);
      const sourceEnd = source.end_date
        ? new Date(`${String(source.end_date)}T00:00:00Z`)
        : new Date(Date.UTC(2099, 0, 1));
      if (monthStart >= sourceEnd || monthEnd <= sourceStart) {
        continue;
      }
      ytdIncome += toCad(
        String(source.period ?? "monthly") === "biweekly"
          ? Number(source.amount_per_period ?? 0) * 26 / 12
          : Number(source.amount_per_period ?? 0),
        String(source.currency ?? "USD"),
        fxRate,
      );
    }
  }
  const annualized = monthNumber > 0 ? ytdIncome * (12 / monthNumber) : 0;
  const tax = calcAnnualTax(annualized, config);
  return {
    ytdIncome,
    annualized,
    rate: tax.effectiveRateWithContribs,
    monthlySetAside: monthlyIncomeCad * tax.effectiveRateWithContribs,
  };
}

export function buildForecastScenario(
  label: 'conservative' | 'optimistic',
  income: FinanceIncomeProjectionData,
  totalMonthlyExpenses: number,
  monthlyDiscretionary: number,
  config: FinanceForecastConfig,
  netLiquidCad: number,
): FinanceForecastScenarioData {
  const tax = calcAnnualTax(income.totalCad, config);
  const annualExpensesCad = (totalMonthlyExpenses + monthlyDiscretionary) * 12;
  const annualSurplusCad = tax.netAfterTaxAndAlimony - annualExpensesCad;
  const monthlySurplusCad = annualSurplusCad / 12;
  const monthlyBurnCad = Math.max(0, -monthlySurplusCad);
  return {
    label,
    incomeCad: income.totalCad,
    tax,
    annualExpensesCad,
    monthlyExpensesCad: totalMonthlyExpenses + monthlyDiscretionary,
    annualSurplusCad,
    monthlySurplusCad,
    monthlyBurnCad,
    runwayMonths: computeRunwayMonths(netLiquidCad, monthlyBurnCad),
  };
}

export function addCumulativeCashflow(startingLiquidCad: number, rows: Array<Omit<FinanceCashflowMonthData, 'cumulativeCad'>>): FinanceCashflowMonthData[] {
  let cumulativeCad = startingLiquidCad;
  return rows.map((row) => {
    cumulativeCad += row.net;
    return { ...row, cumulativeCad };
  });
}

export function buildForecastSummaryData(
  db: Database,
  config: FinanceForecastConfig,
  defaultSettings: Record<string, string>,
): FinanceForecastSummaryData {
  const fxRate = getFxRate(db, defaultSettings);
  const sources = loadIncomeSources(db);
  const expenses = loadRecurringExpenses(db);
  const payables = loadPayables(db);
  const receivables = loadReceivables(db);
  const balances = loadAccountBalances(db);
  const totalLiquid = balances.liquid.reduce((sum, row) => sum + toCad(Number(row.balance ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
  const totalDebt = balances.debt.reduce((sum, row) => sum + toCad(Math.abs(Number(row.balance ?? 0)), String(row.currency ?? 'CAD'), fxRate), 0);
  const totalRegistered = balances.registered.reduce((sum, row) => sum + toCad(Number(row.balance ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
  const confirmedAp = payables.filter((row) => row.certainty === 'confirmed');
  const totalConfirmedAp = confirmedAp.reduce((sum, row) => sum + toCad(Number(row.amount ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
  const totalAllAp = payables.reduce((sum, row) => sum + toCad(Number(row.amount ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
  const pendingAr = receivables.reduce((sum, row) => sum + toCad(Number(row.amount ?? row.amount_cad ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
  const netLiquidCad = totalLiquid - totalDebt;
  const incomeConservative = projectAnnualIncome(sources, fxRate, false);
  const incomeOptimistic = projectAnnualIncome(sources, fxRate, true);
  const recurringMonthlyCad = expenses.reduce((sum, row) => sum + row.monthlyCad, 0);
  const discretionaryMonthlyCad = getNumericSettingOrDefault(db, "budget.weekly_limit_cad", defaultSettings) * 52 / 12;
  const currentMonth = new Date().getUTCMonth() + 1;
  return {
    year: Number(config.year ?? 0),
    fxRate,
    standing: {
      liquidCad: totalLiquid,
      debtCad: totalDebt,
      registeredCad: totalRegistered,
      netLiquidCad,
      pendingReceivablesCad: pendingAr,
      confirmedPayablesCad: totalConfirmedAp,
      allPayablesCad: totalAllAp,
      netPositionConfirmedCad: netLiquidCad - totalConfirmedAp + pendingAr,
      netPositionAllCad: netLiquidCad - totalAllAp + pendingAr,
    },
    income: {
      conservative: incomeConservative,
      optimistic: incomeOptimistic,
    },
    expenses: {
      recurringMonthlyCad,
      discretionaryMonthlyCad,
      totalMonthlyCad: recurringMonthlyCad + discretionaryMonthlyCad,
      totalAnnualCad: (recurringMonthlyCad + discretionaryMonthlyCad) * 12,
    },
    scenarios: {
      conservative: buildForecastScenario('conservative', incomeConservative, recurringMonthlyCad, discretionaryMonthlyCad, config, netLiquidCad),
      optimistic: buildForecastScenario('optimistic', incomeOptimistic, recurringMonthlyCad, discretionaryMonthlyCad, config, netLiquidCad),
    },
    currentTaxRates: {
      monthNumber: currentMonth,
      conservative: calcTaxRateForMonth(currentMonth, 0, sources, fxRate, config, false),
      optimistic: calcTaxRateForMonth(currentMonth, 0, sources, fxRate, config, true),
    },
  };
}

export function buildForecastCashflowData(
  db: Database,
  config: FinanceForecastConfig,
  defaultSettings: Record<string, string>,
): FinanceForecastCashflowData {
  const fxRate = getFxRate(db, defaultSettings);
  const sources = loadIncomeSources(db);
  const expenses = loadRecurringExpenses(db);
  const confirmedPayables = loadPayables(db).filter((row) => row.certainty === 'confirmed');
  const allPayables = loadPayables(db);
  const receivables = loadReceivables(db);
  const balances = loadAccountBalances(db);
  const startingLiquidCad = balances.liquid.reduce((sum, row) => sum + toCad(Number(row.balance ?? 0), String(row.currency ?? 'CAD'), fxRate), 0)
    - balances.debt.reduce((sum, row) => sum + toCad(Math.abs(Number(row.balance ?? 0)), String(row.currency ?? 'CAD'), fxRate), 0);
  return {
    year: Number(config.year ?? 0),
    fxRate,
    startingLiquidCad,
    conservative: addCumulativeCashflow(startingLiquidCad, buildCashflow(db, sources, expenses, confirmedPayables, receivables, fxRate, config, false, defaultSettings)),
    optimistic: addCumulativeCashflow(startingLiquidCad, buildCashflow(db, sources, expenses, allPayables, receivables, fxRate, config, true, defaultSettings)),
  };
}

export function buildTaxProjectionData(
  db: Database,
  config: FinanceForecastConfig,
  defaultSettings: Record<string, string>,
): FinanceTaxProjectionData {
  const summary = buildForecastSummaryData(db, config, defaultSettings);
  return {
    year: summary.year,
    fxRate: summary.fxRate,
    conservative: {
      annual: summary.scenarios.conservative.tax,
      currentRate: summary.currentTaxRates.conservative,
    },
    optimistic: {
      annual: summary.scenarios.optimistic.tax,
      currentRate: summary.currentTaxRates.optimistic,
    },
  };
}

export function proratedForecastMonthValue(month: string, monthValue: number, referenceDate: string, horizonEndExclusive: string) {
  const monthRange = startEndForMonth(month);
  const overlapStart = referenceDate > monthRange.from ? referenceDate : monthRange.from;
  const overlapEnd = horizonEndExclusive < monthRange.toExclusive ? horizonEndExclusive : monthRange.toExclusive;
  const overlapDays = Math.max(0, daysBetween(overlapStart, overlapEnd));
  if (overlapDays === 0) {
    return 0;
  }
  const totalMonthDays = Math.max(1, daysBetween(monthRange.from, monthRange.toExclusive));
  return finiteNumber(monthValue) * (overlapDays / totalMonthDays);
}

export function buildCashflow(
  db: Database,
  sources: IncomeSourceRecord[],
  expenses: Array<RecurringRecord & { monthlyCad: number }>,
  payables: PayableRecord[],
  receivables: ReceivableRecord[],
  fxRate: number,
  config: FinanceForecastConfig,
  includeUnconfirmed: boolean,
  defaultSettings: Record<string, string>,
): Array<Omit<FinanceCashflowMonthData, "cumulativeCad">> {
  const weeklyBudget = getNumericSettingOrDefault(db, "budget.weekly_limit_cad", defaultSettings);
  const activeSources = sources.filter((source) => includeUnconfirmed || Number(source.confirmed ?? 1) === 1);
  const months: Array<Omit<FinanceCashflowMonthData, "cumulativeCad">> = [];
  for (let month = 3; month <= 12; month += 1) {
    const monthKey = `2026-${month.toString().padStart(2, "0")}`;
    const monthStart = new Date(Date.UTC(2026, month - 1, 1));
    const monthEnd = month === 12 ? new Date(Date.UTC(2027, 0, 1)) : new Date(Date.UTC(2026, month, 1));
    let incomeCad = 0;
    for (const source of activeSources) {
      const sourceStart = new Date(`${String(source.start_date)}T00:00:00Z`);
      const sourceEnd = source.end_date ? new Date(`${String(source.end_date)}T00:00:00Z`) : new Date(Date.UTC(2099, 0, 1));
      if (monthStart >= sourceEnd || monthEnd <= sourceStart) {
        continue;
      }
      const confirmed = Number(source.confirmed ?? 1) === 1;
      if (!confirmed) {
        const guaranteedMonths = Number(source.guaranteed_months ?? 0);
        const monthsSinceStart = (month - (sourceStart.getUTCMonth() + 1)) + (2026 - sourceStart.getUTCFullYear()) * 12;
        if (monthsSinceStart >= guaranteedMonths) {
          continue;
        }
      }
      incomeCad += toCad(
        String(source.period ?? "monthly") === "biweekly"
          ? Number(source.amount_per_period ?? 0) * 26 / 12
          : Number(source.amount_per_period ?? 0),
        String(source.currency ?? "USD"),
        fxRate,
      );
    }
    const expensesCad = expenses.reduce((sum, expense) => sum + expense.monthlyCad, 0);
    const monthDays = Math.round((monthEnd.getTime() - monthStart.getTime()) / 86_400_000);
    const discretionaryCad = weeklyBudget * (monthDays / 7);
    const tax = calcTaxRateForMonth(month, incomeCad, sources, fxRate, config, includeUnconfirmed);
    const apDue = payables
      .filter((payable) => String(payable.due_date ?? "").slice(0, 7) === monthKey)
      .reduce((sum, payable) => sum + toCad(Number(payable.amount ?? 0), String(payable.currency ?? "CAD"), fxRate), 0);
    const arExpected = receivables
      .filter((receivable) => String(receivable.expected_date ?? "").slice(0, 7) === monthKey)
      .reduce((sum, receivable) => sum + toCad(Number(receivable.amount ?? receivable.amount_cad ?? 0), String(receivable.currency ?? "CAD"), fxRate), 0);
    const totalOut = expensesCad + discretionaryCad + tax.monthlySetAside + apDue;
    months.push({
      month: monthKey,
      incomeCad,
      expensesCad,
      discretionaryCad,
      taxSetAside: tax.monthlySetAside,
      apDue,
      arExpected,
      totalOut,
      net: incomeCad + arExpected - totalOut,
    });
  }
  return months;
}

export function renderForecastSummary(
  db: Database,
  config: FinanceForecastConfig,
  defaultSettings: Record<string, string>,
) {
  const fxRate = getFxRate(db, defaultSettings);
  const sources = loadIncomeSources(db);
  const expenses = loadRecurringExpenses(db);
  const payables = loadPayables(db);
  const receivables = loadReceivables(db);
  const balances = loadAccountBalances(db);
  const totalLiquid = balances.liquid.reduce((sum, row) => sum + toCad(Number(row.balance ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
  const totalDebt = balances.debt.reduce((sum, row) => sum + toCad(Math.abs(Number(row.balance ?? 0)), String(row.currency ?? "CAD"), fxRate), 0);
  const totalRegistered = balances.registered.reduce((sum, row) => sum + toCad(Number(row.balance ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
  const confirmedAp = payables.filter((row) => row.certainty === "confirmed");
  const totalConfirmedAp = confirmedAp.reduce((sum, row) => sum + toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
  const totalAllAp = payables.reduce((sum, row) => sum + toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
  const pendingAr = receivables.reduce((sum, row) => sum + toCad(Number(row.amount ?? row.amount_cad ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
  const netLiquid = totalLiquid - totalDebt;
  const incomeConservative = projectAnnualIncome(sources, fxRate, false);
  const incomeOptimistic = projectAnnualIncome(sources, fxRate, true);
  const totalMonthlyExpenses = expenses.reduce((sum, row) => sum + row.monthlyCad, 0);
  const monthlyDiscretionary = getNumericSettingOrDefault(db, "budget.weekly_limit_cad", defaultSettings) * 52 / 12;

  const formatIncomeLine = (item: FinanceIncomeProjectionData["items"][number]) =>
    `    ${item.confirmed ? "x" : "!"} ${String(item.name).padEnd(25)} ${formatMoney(Number(item.annualOrig ?? 0), String(item.currency ?? "USD"), 0).padStart(16)}  ${formatCad(Number(item.annualCad ?? 0)).padStart(16)}  (${item.note ?? `${item.monthsActive ?? "?"} months`})`;

  const scenarioBlock = (label: string, income: { totalCad: number }) => {
    const tax = calcAnnualTax(income.totalCad, config);
    const net = tax.netAfterTaxAndAlimony;
    const annualExpenses = (totalMonthlyExpenses + monthlyDiscretionary) * 12;
    const surplus = net - annualExpenses;
    return [
      `  -- ${label} --`,
      `    Gross CAD:              ${formatCad(income.totalCad).padStart(16)}`,
      `    Tax (fed+QC):          -${formatCad(tax.totalTax).padStart(16)}  (${(tax.effectiveRate * 100).toFixed(1)}%)`,
      `    Contributions:         -${formatCad(tax.contributions.total).padStart(16)}`,
      `    Combined rate:           ${(tax.effectiveRateWithContribs * 100).toFixed(1)}%`,
      `    Alimony:               -${formatCad(tax.alimonyAnnual).padStart(16)}`,
      `    Net:                    ${formatCad(net).padStart(16)}  (${formatCad(net / 12)}/mo)`,
      `    Expenses:              -${formatCad(annualExpenses).padStart(16)}  (${formatCad(annualExpenses / 12)}/mo)`,
      "    ========================================",
      `    SURPLUS:                ${formatCad(surplus).padStart(16)}  (${formatCad(surplus / 12)}/mo)`,
    ].join("\n");
  };

  const currentMonth = new Date().getUTCMonth() + 1;
  const taxCon = calcTaxRateForMonth(currentMonth, 0, sources, fxRate, config, false);
  const taxOpt = calcTaxRateForMonth(currentMonth, 0, sources, fxRate, config, true);

  return [
    "================================================================",
    "  2026 FINANCIAL FORECAST - SUMMARY",
    "================================================================",
    "",
    `  FX Rate: ${fxRate} USD/CAD`,
    "",
    "  CURRENT STANDING:",
    ...balances.liquid.filter((row) => Number(row.balance ?? 0) !== 0).map((row) =>
      `    ${String(row.name ?? "").padEnd(35)} ${formatMoney(Number(row.balance ?? 0), String(row.currency ?? "CAD")).padStart(16)}`),
    ...balances.debt.map((row) =>
      `    ${String(row.name ?? "").padEnd(35)} ${formatMoney(Number(row.balance ?? 0), String(row.currency ?? "CAD")).padStart(16)}`),
    `    ${"-".repeat(53)}`,
    `    ${"Net liquid".padEnd(35)} ${formatCad(netLiquid).padStart(16)}`,
    `    ${"+ Pending AR".padEnd(35)} ${formatCad(pendingAr).padStart(16)}`,
    `    ${"- Confirmed AP".padEnd(35)} ${formatCad(totalConfirmedAp).padStart(16)}`,
    `    ${"=".repeat(53)}`,
    `    ${"NET POSITION (confirmed AP)".padEnd(35)} ${formatCad(netLiquid - totalConfirmedAp + pendingAr).padStart(16)}`,
    totalAllAp !== totalConfirmedAp
      ? `    ${"NET POSITION (all AP)".padEnd(35)} ${formatCad(netLiquid - totalAllAp + pendingAr).padStart(16)}`
      : "",
    totalRegistered > 0
      ? `    ${"(Registered accounts, not liquid)".padEnd(35)} ${formatCad(totalRegistered).padStart(16)}`
      : "",
    "",
    "  INCOME (remaining 2026):",
    ...incomeOptimistic.items.map(formatIncomeLine),
    "",
    `    Conservative (confirmed):  ${formatCad(incomeConservative.totalCad).padStart(16)}`,
    `    Optimistic (all sources): ${formatCad(incomeOptimistic.totalCad).padStart(16)}`,
    "",
    "  MONTHLY EXPENSES (from recurring):",
    ...expenses
      .slice()
      .sort((left, right) => right.monthlyCad - left.monthlyCad)
      .map((expense) => `    ${String(expense.name ?? "").padEnd(30)} ${formatCad(expense.monthlyCad).padStart(12)}${String(expense.interval_kind ?? "monthly") !== "monthly" ? ` (${Number(expense.amount_cad ?? 0).toFixed(2)}/${expense.interval_kind})` : ""}`),
    `    ${"Discretionary".padEnd(30)} ${formatCad(monthlyDiscretionary).padStart(12)}  ($${getNumericSettingOrDefault(db, "budget.weekly_limit_cad", defaultSettings).toFixed(0)}/week)`,
    `    ${"-".repeat(44)}`,
    `    ${"TOTAL".padEnd(30)} ${formatCad(totalMonthlyExpenses + monthlyDiscretionary).padStart(12)}/mo`,
    `    ${"TOTAL ANNUAL".padEnd(30)} ${formatCad((totalMonthlyExpenses + monthlyDiscretionary) * 12).padStart(12)}`,
    "",
    scenarioBlock("CONSERVATIVE", incomeConservative),
    "",
    scenarioBlock("OPTIMISTIC", incomeOptimistic),
    "",
    `  2026 TAX RATE (annualized from ${currentMonth}-month YTD):`,
    `    YTD income (con):   ${formatCad(taxCon.ytdIncome)}  -> annualized ${formatCad(taxCon.annualized)}`,
    `    YTD income (opt):   ${formatCad(taxOpt.ytdIncome)}  -> annualized ${formatCad(taxOpt.annualized)}`,
    `    Effective rate (con): ${(taxCon.rate * 100).toFixed(1)}%`,
    `    Effective rate (opt): ${(taxOpt.rate * 100).toFixed(1)}%`,
  ].filter(Boolean).join("\n");
}

export function renderCashflow(
  db: Database,
  config: FinanceForecastConfig,
  defaultSettings: Record<string, string>,
) {
  const fxRate = getFxRate(db, defaultSettings);
  const sources = loadIncomeSources(db);
  const expenses = loadRecurringExpenses(db);
  const confirmedPayables = loadPayables(db).filter((row) => row.certainty === "confirmed");
  const allPayablesRows = loadPayables(db);
  const receivables = loadReceivables(db);
  const balances = loadAccountBalances(db);
  const starting = balances.liquid.reduce((sum, row) => sum + toCad(Number(row.balance ?? 0), String(row.currency ?? "CAD"), fxRate), 0)
    - balances.debt.reduce((sum, row) => sum + toCad(Math.abs(Number(row.balance ?? 0)), String(row.currency ?? "CAD"), fxRate), 0);
  const conservative = buildCashflow(db, sources, expenses, confirmedPayables, receivables, fxRate, config, false, defaultSettings);
  const optimistic = buildCashflow(db, sources, expenses, allPayablesRows, receivables, fxRate, config, true, defaultSettings);
  let cumulativeConservative = starting;
  let cumulativeOptimistic = starting;
  const lines = [
    "================================================================",
    "  2026 MONTHLY CASH FLOW WATERFALL",
    "================================================================",
    `  Starting liquid: ${formatCad(starting)}`,
    `  FX Rate: ${fxRate}`,
    "  Tax rates computed per-month via annualized YTD income",
    "",
  ];
  for (let index = 0; index < conservative.length; index += 1) {
    const con = conservative[index]!;
    const opt = optimistic[index]!;
    cumulativeConservative += Number(con.net ?? 0);
    cumulativeOptimistic += Number(opt.net ?? 0);
    lines.push(
      `  -- ${con.month} --`,
      `    Income:         ${formatCad(Number(con.incomeCad ?? 0)).padStart(14)}  (con)    ${formatCad(Number(opt.incomeCad ?? 0)).padStart(14)}  (opt)`,
    );
    if (Number(opt.arExpected ?? 0) > 0) {
      lines.push(`    AR received:   +${formatCad(Number(opt.arExpected ?? 0)).padStart(14)}`);
    }
    lines.push(
      `    Expenses:      -${formatCad(Number(opt.expensesCad ?? 0)).padStart(14)}`,
      `    Discretionary: -${formatCad(Number(opt.discretionaryCad ?? 0)).padStart(14)}`,
      `    Tax set-aside: -${formatCad(Number(con.taxSetAside ?? 0)).padStart(14)}  (con)   -${formatCad(Number(opt.taxSetAside ?? 0)).padStart(14)}  (opt)`,
    );
    if (Number(opt.apDue ?? 0) > 0) {
      lines.push(`    AP due:        -${formatCad(Number(opt.apDue ?? 0)).padStart(14)}`);
    }
    lines.push(
      "    ------------------------------------------------",
      `    Net:           ${formatCad(Number(con.net ?? 0)).padStart(14)}  (con)   ${formatCad(Number(opt.net ?? 0)).padStart(14)}  (opt)`,
      `    Cumulative:    ${formatCad(cumulativeConservative).padStart(14)}  (con)   ${formatCad(cumulativeOptimistic).padStart(14)}  (opt)`,
      "",
    );
  }
  return lines.join("\n");
}

export function renderAr(
  db: Database,
  defaultSettings: Record<string, string>,
) {
  const fxRate = getFxRate(db, defaultSettings);
  const receivables = loadReceivables(db);
  const today = dateKey(new Date());
  const overdue = receivables.filter((row) => String(row.expected_date ?? "") < today);
  const upcoming = receivables.filter((row) => String(row.expected_date ?? "") >= today);
  const lines = [
    "================================================================",
    "  ACCOUNTS RECEIVABLE",
    "================================================================",
  ];
  if (overdue.length > 0) {
    lines.push("", "  OVERDUE:");
    for (const row of overdue) {
      const amount = Number(row.amount ?? row.amount_cad ?? 0);
      const currency = String(row.currency ?? "CAD");
      const cad = toCad(amount, currency, fxRate);
      lines.push(`    ! ${String(row.counterparty ?? "").padEnd(20)} ${formatMoney(amount, currency).padStart(16)}${currency !== "CAD" ? ` (~${formatCad(cad)})` : ""}  expected ${row.expected_date}${row.notes ? ` | ${row.notes}` : ""} [id:${row.id}]`);
    }
  }
  if (upcoming.length > 0) {
    lines.push("", "  UPCOMING:");
    for (const row of upcoming) {
      const amount = Number(row.amount ?? row.amount_cad ?? 0);
      const currency = String(row.currency ?? "CAD");
      const cad = toCad(amount, currency, fxRate);
      lines.push(`    > ${String(row.counterparty ?? "").padEnd(20)} ${formatMoney(amount, currency).padStart(16)}${currency !== "CAD" ? ` (~${formatCad(cad)})` : ""}  expected ${row.expected_date}${row.notes ? ` | ${row.notes}` : ""} [id:${row.id}]`);
    }
  }
  if (overdue.length === 0 && upcoming.length === 0) {
    lines.push("", "  (no pending receivables)");
  }
  const total = receivables.reduce((sum, row) => sum + toCad(Number(row.amount ?? row.amount_cad ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
  lines.push("", `  TOTAL PENDING: ${formatCad(total)}`);
  return lines.join("\n");
}

export function renderAp(
  db: Database,
  defaultSettings: Record<string, string>,
) {
  const fxRate = getFxRate(db, defaultSettings);
  const payables = loadPayables(db);
  const today = dateKey(new Date());
  const lines = [
    "================================================================",
    "  ACCOUNTS PAYABLE",
    "================================================================",
  ];
  for (const certainty of ["confirmed", "expected", "speculative"] as const) {
    const items = payables.filter((row) => row.certainty === certainty);
    if (items.length === 0) {
      continue;
    }
    lines.push("", `  ${certainty.toUpperCase()}:`);
    for (const row of items) {
      const amount = Number(row.amount ?? 0);
      const currency = String(row.currency ?? "CAD");
      const cad = toCad(amount, currency, fxRate);
      lines.push(`    [${certainty === "confirmed" ? "x" : certainty === "expected" ? "~" : "?"}] ${String(row.counterparty ?? "").padEnd(25)} ${formatMoney(amount, currency).padStart(16)}${currency !== "CAD" ? ` (~${formatCad(cad)})` : ""}  due ${row.due_date}  [${row.category ?? "-"}]${String(row.due_date ?? "") < today ? " OVERDUE" : ""}`);
      if (row.description) {
        lines.push(`        ${row.description}`);
      }
    }
    const subtotal = items.reduce((sum, row) => sum + toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
    lines.push(`    ${"SUBTOTAL".padEnd(25)} ${formatCad(subtotal).padStart(16)}`);
  }
  const confirmed = payables.filter((row) => row.certainty === "confirmed").reduce((sum, row) => sum + toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
  const grandTotal = payables.reduce((sum, row) => sum + toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
  lines.push("", `  CONFIRMED TOTAL: ${formatCad(confirmed)}`, `  FULL TOTAL (incl speculative): ${formatCad(grandTotal)}`);
  return lines.join("\n");
}

// Data loading helpers used by forecasting
export function loadIncomeSources(db: Database) {
  return allRows<IncomeSourceRecord>(
    db,
    "SELECT * FROM income_sources ORDER BY confirmed DESC, start_date",
  );
}

export function loadRecurringExpenses(db: Database): Array<RecurringRecord & { monthlyCad: number }> {
  const rows = allRows<RecurringRecord>(
    db,
    "SELECT * FROM recurring WHERE status = 'active' ORDER BY name",
  );
  return rows.map((row) => {
    const amountCad = Number(row.amount_cad ?? 0);
    const interval = String(row.interval_kind ?? "monthly");
    const monthlyCad = interval === "biweekly"
      ? amountCad * 26 / 12
      : interval === "weekly"
        ? amountCad * 52 / 12
        : interval === "yearly"
          ? amountCad / 12
          : amountCad;
    return {
      ...row,
      monthlyCad,
    } as RecurringRecord & { monthlyCad: number };
  });
}

export function loadPayables(db: Database, status = "pending") {
  return allRows<PayableRecord>(
    db,
    "SELECT * FROM payables WHERE status = ? ORDER BY due_date",
    status,
  );
}

export function loadReceivables(db: Database, status?: string) {
  return status
    ? allRows<ReceivableRecord>(
        db,
        "SELECT * FROM receivables WHERE status = ? ORDER BY expected_date",
        status,
      )
    : allRows<ReceivableRecord>(
        db,
        "SELECT * FROM receivables WHERE status <> 'received' ORDER BY expected_date",
      );
}

export function loadAccountBalances(db: Database) {
  const rows = allRows<AccountBalanceRecord>(
    db,
    "SELECT id, external_id, name, institution, currency, balance, last_update, updated_at FROM accounts ORDER BY balance DESC",
  );
  const liquid: AccountBalanceRecord[] = [];
  const registered: AccountBalanceRecord[] = [];
  const debt: AccountBalanceRecord[] = [];
  for (const row of rows) {
    const name = String(row.name ?? "");
    const balance = Number(row.balance ?? 0);
    if (["rrsp", "tfsa"].some((token) => name.toLowerCase().includes(token))) {
      registered.push(row);
    } else if (balance < 0) {
      debt.push(row);
    } else {
      liquid.push(row);
    }
  }
  return { liquid, registered, debt };
}
