import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/infrastructure/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

const financeBudgetSchema = z.object({
  date: z.string().optional(),
  weeklyLimit: z.number().positive().optional(),
});

const financeHistorySchema = z.object({
  month: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  account: z.string().optional(),
  category: z.string().optional(),
  onlyBudget: z.boolean().optional(),
  onlyReview: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const financeCategorizeDecisionSchema = z.object({
  id: z.number().int().positive().optional(),
  externalId: z.string().min(1).optional(),
  category: z.string().nullable().optional(),
  countsTowardBudget: z.boolean().nullable().optional(),
  descriptionClean: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

const financeReviewSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  decisions: z.array(financeCategorizeDecisionSchema).max(50).optional(),
});

const financeImportSchema = z.object({
  source: z.enum(["fintable_gsheet", "csv"]).optional(),
  dryRun: z.boolean().optional(),
  spreadsheetId: z.string().optional(),
  accountsGid: z.string().optional(),
  transactionsGid: z.string().optional(),
  csvText: z.string().optional(),
});

const financeForecastSchema = z.object({
  view: z.enum(["summary", "cashflow", "ar", "ap"]).optional(),
});

const financeManageSchema = z.object({
  action: z.enum([
    "add_expense",
    "add_receivable",
    "list_receivables",
    "check_receivables",
    "add_recurring",
    "set_recurring",
    "list_recurring",
    "list_recurring_candidates",
    "refresh_recurring",
    "delete_recurring",
    "add_payable",
    "list_payables",
    "pay_payable",
    "add_income_source",
    "list_income_sources",
    "add_fx_event",
    "list_fx_events",
  ]),
  postedDate: z.string().optional(),
  amount: z.number().optional(),
  currency: z.string().optional(),
  merchant: z.string().optional(),
  description: z.string().optional(),
  account: z.string().optional(),
  category: z.string().optional(),
  counts: z.boolean().optional(),
  note: z.string().optional(),
  counterparty: z.string().optional(),
  amountCad: z.number().optional(),
  earnedDate: z.string().optional(),
  expectedDate: z.string().optional(),
  status: z.string().optional(),
  notes: z.string().optional(),
  horizonDays: z.number().int().positive().max(365).optional(),
  today: z.string().optional(),
  name: z.string().optional(),
  matchKind: z.string().optional(),
  matchValue: z.string().optional(),
  intervalKind: z.string().optional(),
  intervalDays: z.number().int().positive().optional(),
  amountToleranceCad: z.number().min(0).optional(),
  graceDays: z.number().int().positive().optional(),
  nextExpectedDate: z.string().optional(),
  lastSeenDate: z.string().optional(),
  dueDate: z.string().optional(),
  certainty: z.enum(["confirmed", "expected", "speculative"]).optional(),
  id: z.number().int().positive().optional(),
  type: z.string().optional(),
  amountPerPeriod: z.number().optional(),
  period: z.string().optional(),
  billing: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  confirmed: z.boolean().optional(),
  guaranteedMonths: z.number().int().positive().optional(),
  date: z.string().optional(),
  amountFrom: z.number().optional(),
  currencyFrom: z.string().optional(),
  amountTo: z.number().optional(),
  currencyTo: z.string().optional(),
  method: z.string().optional(),
  noAutoSeed: z.boolean().optional(),
  seedLimit: z.number().int().positive().max(50).optional(),
  includeKnown: z.boolean().optional(),
  maxAgeDays: z.number().int().positive().max(3650).optional(),
});

export function buildFinanceTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  if (!ctx.featureConfig.isActive("finance")) {
    return [];
  }

  return [
    defineTool(
      async () =>
        traceSpan(
          "tool.finance_summary",
          async () => ctx.finance.summary(),
        ),
      {
        name: "finance_summary",
        description:
          "Show the current finance overview: budget status, review queue, receivables, and the imported Google Sheet source link.",
        schema: z.object({}),
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.finance_budget",
          async () => ctx.finance.budget({
            date: input.date,
            weeklyLimit: input.weeklyLimit,
          }),
          { attributes: input },
        ),
      {
        name: "finance_budget",
        description:
          "Show the weekly or fallback monthly budget snapshot, with rollover, pace, and optional limit override.",
        schema: financeBudgetSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.finance_history",
          async () => ctx.finance.history({
            month: input.month,
            fromDate: input.fromDate,
            toDate: input.toDate,
            account: input.account,
            category: input.category,
            onlyBudget: input.onlyBudget,
            onlyReview: input.onlyReview,
            limit: input.limit,
          }),
          { attributes: input },
        ),
      {
        name: "finance_history",
        description:
          "List transaction history with optional month/date/category/account filters, including budget-only or review-only views.",
        schema: financeHistorySchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.finance_review",
          async () => {
            if (input.decisions && input.decisions.length > 0) {
              return ctx.finance.categorize(input.decisions);
            }
            return ctx.finance.reviewQueue(input.limit ?? 10);
          },
          { attributes: input },
        ),
      {
        name: "finance_review",
        description:
          "Inspect the finance review queue or apply review decisions that set categories, budget counts, descriptions, and notes.",
        schema: financeReviewSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.finance_import",
          async () => ctx.finance.importTransactions({
            source: input.source,
            dryRun: input.dryRun,
            spreadsheetId: input.spreadsheetId,
            accountsGid: input.accountsGid,
            transactionsGid: input.transactionsGid,
            csvText: input.csvText,
          }),
          { attributes: input },
        ),
      {
        name: "finance_import",
        description:
          "Import finance transactions from the configured Fintable Google Sheet or caller-provided CSV text.",
        schema: financeImportSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.finance_manage",
          async () => {
            switch (input.action) {
              case "add_expense":
                return ctx.finance.addExpense({
                  postedDate: input.postedDate!,
                  amount: input.amount!,
                  currency: input.currency,
                  merchant: input.merchant,
                  description: input.description,
                  account: input.account,
                  category: input.category,
                  counts: input.counts,
                  note: input.note,
                });
              case "add_receivable":
                return ctx.finance.addReceivable({
                  counterparty: input.counterparty!,
                  amount: input.amount,
                  amountCad: input.amountCad,
                  currency: input.currency,
                  earnedDate: input.earnedDate!,
                  expectedDate: input.expectedDate!,
                  status: input.status,
                  notes: input.notes,
                });
              case "list_receivables":
                return ctx.finance.listReceivables(input.status);
              case "check_receivables":
                return ctx.finance.checkReceivables({
                  today: input.today,
                  horizonDays: input.horizonDays,
                });
              case "add_recurring":
                return ctx.finance.addRecurring({
                  name: input.name!,
                  matchKind: input.matchKind,
                  matchValue: input.matchValue!,
                  intervalKind: input.intervalKind,
                  intervalDays: input.intervalDays,
                  amountCad: input.amountCad!,
                  amountToleranceCad: input.amountToleranceCad,
                  currency: input.currency,
                  graceDays: input.graceDays,
                  nextExpectedDate: input.nextExpectedDate,
                  lastSeenDate: input.lastSeenDate,
                  status: input.status,
                  notes: input.notes,
                });
              case "set_recurring":
                return ctx.finance.setRecurring({
                  id: input.id,
                  name: input.name,
                  matchKind: input.matchKind,
                  matchValue: input.matchValue,
                  intervalKind: input.intervalKind,
                  intervalDays: input.intervalDays,
                  amountCad: input.amountCad,
                  amountToleranceCad: input.amountToleranceCad,
                  currency: input.currency,
                  graceDays: input.graceDays,
                  nextExpectedDate: input.nextExpectedDate,
                  lastSeenDate: input.lastSeenDate,
                  status: input.status,
                  notes: input.notes,
                });
              case "list_recurring":
                return ctx.finance.listRecurring();
              case "list_recurring_candidates":
                return ctx.finance.listRecurringCandidates({
                  today: input.today,
                  includeKnown: input.includeKnown,
                  maxAgeDays: input.maxAgeDays,
                });
              case "refresh_recurring":
                return ctx.finance.refreshRecurring({
                  today: input.today,
                  noAutoSeed: input.noAutoSeed,
                  seedLimit: input.seedLimit,
                });
              case "delete_recurring":
                return ctx.finance.deleteRecurring(input.id!);
              case "add_payable":
                return ctx.finance.addPayable({
                  counterparty: input.counterparty!,
                  description: input.description,
                  amount: input.amount!,
                  currency: input.currency,
                  amountCad: input.amountCad,
                  dueDate: input.dueDate!,
                  certainty: input.certainty,
                  category: input.category,
                  notes: input.notes,
                });
              case "list_payables":
                return ctx.finance.listPayables({
                  status: input.status,
                  certainty: input.certainty,
                });
              case "pay_payable":
                return ctx.finance.markPayablePaid(input.id!);
              case "add_income_source":
                return ctx.finance.addIncomeSource({
                  name: input.name!,
                  type: input.type,
                  currency: input.currency,
                  amountPerPeriod: input.amountPerPeriod!,
                  period: input.period,
                  billing: input.billing,
                  startDate: input.startDate!,
                  endDate: input.endDate,
                  confirmed: input.confirmed,
                  guaranteedMonths: input.guaranteedMonths,
                  notes: input.notes,
                });
              case "list_income_sources":
                return ctx.finance.listIncomeSources();
              case "add_fx_event":
                return ctx.finance.addFxEvent({
                  date: input.date!,
                  amountFrom: input.amountFrom!,
                  currencyFrom: input.currencyFrom,
                  amountTo: input.amountTo!,
                  currencyTo: input.currencyTo,
                  method: input.method,
                  notes: input.notes,
                });
              case "list_fx_events":
                return ctx.finance.listFxEvents();
              default:
                throw new Error(`Unsupported finance action: ${input.action}`);
            }
          },
          { attributes: input },
        ),
      {
        name: "finance_manage",
        description:
          "Manage finance state: add expenses, receivables, recurring items, payables, income sources, FX events, or list, edit, and refresh those records.",
        schema: financeManageSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.finance_forecast",
          async () => ctx.finance.forecast(input.view ?? "summary"),
          { attributes: input },
        ),
      {
        name: "finance_forecast",
        description:
          "Render the finance forecast summary, monthly cashflow, receivables view, or payables view.",
        schema: financeForecastSchema,
      },
    ),
  ];
}
