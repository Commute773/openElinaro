import { z } from "zod";

export const DEFAULT_FINANCE_SETTINGS: Record<string, string> = {
  "budget.monthly_limit_cad": "700",
  "budget.weekly_limit_cad": "700",
  "budget.weekly_start_date": "2026-02-01",
  timezone: "UTC",
  "import.fintable.spreadsheet_id": "YOUR_SPREADSHEET_ID",
  "import.fintable.accounts_gid": "0",
  "import.fintable.transactions_gid": "0",
  "import.fintable.sheet_url":
    "https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID/edit#gid=0",
  "fx.usdcad": "1.365",
};

const DEFAULT_FEDERAL_BRACKETS: Array<[number | null, number]> = [
  [57375, 0.15],
  [57375, 0.205],
  [63132, 0.26],
  [75532, 0.29],
  [null, 0.33],
];

const DEFAULT_QC_BRACKETS: Array<[number | null, number]> = [
  [52055, 0.14],
  [52050, 0.19],
  [21895, 0.24],
  [null, 0.2575],
];

export const DEFAULT_FINANCE_FORECAST_CONFIG = {
  version: 2,
  year: 2026,
  note: "Reference data only. All state (income, expenses, AR/AP) lives in finance.db.",
  tax: {
    filing_status: "sole_proprietor",
    province: "QC",
    installments: false,
    installment_note: "No installments 2026. Full tax owing at year-end.",
    federal_brackets_2025: DEFAULT_FEDERAL_BRACKETS,
    federal_personal_amount: 16211,
    qc_brackets_2025: DEFAULT_QC_BRACKETS,
    qc_personal_amount: 18056,
    qc_federal_abatement: 0.165,
    qpp_rate: 0.128,
    qpp_max_pensionable: 71300,
    qpp_exemption: 3500,
    qpp2_rate: 0.08,
    qpp2_ceiling: 81200,
    qpip_rate: 0.00878,
    qpip_max_insurable: 98000,
    fss_rate: 0.01,
  },
  deductions: {
    alimony_monthly_cad: 0,
    alimony_end_date: "2099-12-31",
    home_office_pct: 0,
    mortgage_biweekly_cad: 0,
    rrsp_planned: 0,
    business_expenses_annual_cad: 0,
    notes: "Reference-only defaults. Configure deductions for your own finances.",
  },
};

const bracketSchema = z.tuple([z.number().positive().nullable(), z.number().positive()]);

export const FinanceForecastConfigSchema = z.object({
  version: z.number().int().positive().default(2),
  year: z.number().int().positive().default(2026),
  note: z.string().default("Reference data only. All state (income, expenses, AR/AP) lives in finance.db."),
  tax: z.object({
    filing_status: z.string().min(1).default("sole_proprietor"),
    province: z.string().min(1).default("QC"),
    installments: z.boolean().default(false),
    installment_note: z.string().default("No installments 2026. Full tax owing at year-end."),
    federal_brackets_2025: z.array(bracketSchema).default(DEFAULT_FINANCE_FORECAST_CONFIG.tax.federal_brackets_2025),
    federal_personal_amount: z.number().nonnegative().default(16211),
    qc_brackets_2025: z.array(bracketSchema).default(DEFAULT_FINANCE_FORECAST_CONFIG.tax.qc_brackets_2025),
    qc_personal_amount: z.number().nonnegative().default(18056),
    qc_federal_abatement: z.number().nonnegative().default(0.165),
    qpp_rate: z.number().nonnegative().default(0.128),
    qpp_max_pensionable: z.number().nonnegative().default(71300),
    qpp_exemption: z.number().nonnegative().default(3500),
    qpp2_rate: z.number().nonnegative().default(0.08),
    qpp2_ceiling: z.number().nonnegative().default(81200),
    qpip_rate: z.number().nonnegative().default(0.00878),
    qpip_max_insurable: z.number().nonnegative().default(98000),
    fss_rate: z.number().nonnegative().default(0.01),
  }).default(DEFAULT_FINANCE_FORECAST_CONFIG.tax),
  deductions: z.object({
    alimony_monthly_cad: z.number().nonnegative().default(0),
    alimony_end_date: z.string().min(1).default("2099-12-31"),
    home_office_pct: z.number().nonnegative().default(0),
    mortgage_biweekly_cad: z.number().nonnegative().default(0),
    rrsp_planned: z.number().nonnegative().default(0),
    business_expenses_annual_cad: z.number().nonnegative().default(0),
    notes: z.string().default("Reference-only defaults. Configure deductions for your own finances."),
  }).default(DEFAULT_FINANCE_FORECAST_CONFIG.deductions),
}).default(DEFAULT_FINANCE_FORECAST_CONFIG);

export type FinanceForecastConfig = z.infer<typeof FinanceForecastConfigSchema>;

export const DEFAULT_FINANCE = {
  enabled: true,
  dbPath: "finance/finance.db",
  forecastConfigPath: "finance/forecast-config.json",
  defaults: {
    settings: DEFAULT_FINANCE_SETTINGS,
    forecast: DEFAULT_FINANCE_FORECAST_CONFIG,
  },
};

export const FinanceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().min(1).default("finance/finance.db"),
  forecastConfigPath: z.string().min(1).default("finance/forecast-config.json"),
  defaults: z.object({
    settings: z.record(z.string(), z.string()).default(DEFAULT_FINANCE_SETTINGS),
    forecast: FinanceForecastConfigSchema.default(DEFAULT_FINANCE_FORECAST_CONFIG),
  }).default(DEFAULT_FINANCE.defaults),
}).default(DEFAULT_FINANCE);

export type FinanceConfig = z.infer<typeof FinanceConfigSchema>;
