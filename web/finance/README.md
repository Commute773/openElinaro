# OpenElinaro finance dashboard workspace

This directory now contains two parts:

- a Bun JSON API server in `web/finance/server.ts`
- a React/TypeScript/Vite client in `web/finance/src`

The dashboard reads and writes the same finance data used by the runtime tools: budget snapshots,
transactions, review decisions, receivables, payables, recurring items, imports, and forecasts.
There is no separate dashboard data store or dashboard-owned business logic. `FinanceService` remains
the single source of truth; the Bun server is only a thin HTTP transport over that service so the
browser can use it.

Recent finance-service additions that matter for the dashboard:

- Fintable account imports now persist `account_balance_snapshots` in the finance DB.
- A CAD balance jump greater than `1000` on the Wealthsimple non-registered account is recorded as
  inferred client income in `transactions` because Fintable currently misses brokerage cashflow rows
  for that account.
- Matching pending Liminal receivables are auto-cleared when that inferred income is recorded.
- Recurring expenses are first-class finance objects in `FinanceService`, with agent-editable
  fields for rule matching, interval, tolerance, status, notes, and expected dates.
- Recurring rule status is user-owned SSOT. Refresh updates observed `last_seen` / `next_expected`
  data when transactions match, but it does not auto-halt a rule just because the feed missed a
  charge or the latest payment has not landed yet.
- The backend exposes recurring candidates derived from repeated transaction patterns so the
  agent can promote high-confidence recurring spend into tracked rules instead of inventing a
  dashboard-only model.
- The overview tab is intentionally glance-first: line-by-line cash math for `amount you have`,
  `taxes you need reserved`, `what is left now`, then the same breakdown for the next `30/60` days
  and `end of year`.
- Those `30/60` day projection rows combine dated receivables, dated outflows, and conservative
  forecast income from `income_sources`, and they subtract both recurring expenses and tax reserve
  needed on that forecast income, plus the configured weekly budget envelope, so future contract
  income is visible without pretending gross income is free cash.
- Current tax backpay is shown once as a separate subtraction from the horizon projection, rather
  than being mixed into the future-income tax reserve line.
- The overview is intentionally one-column and drill-down: each balance line expands to show the
  underlying accounts, receivables, payables, recurring charges, or forecast-month rows behind the
  total.
- The end-of-year projection supports both conservative and optimistic forecast scenarios while
  keeping the same current-tax-backpay subtraction model.
- RRSP balances are excluded from that glance math, while non-registered balances remain part of
  usable cash when they are positive.
- Tax display is split deliberately: `open tax payables` are booked AP items, while `tax to reserve`
  is an estimated current-year reserve derived from received income and the conservative current tax rate.
- The overview explicitly compares that estimated reserve against the actual `Tax` account balance and
  flags when the tax account is underfunded.

## Run

### API server

```bash
bun run finance:api
```

Default port: `3001`

### Vite client (development)

```bash
bun run finance:dev
```

Default port: `5173`

Vite proxies `/api/*` to the Bun server on `http://localhost:3001`.

### Production-style local build

```bash
bun run finance:build
bun run finance:api
```

When `web/finance/dist/` exists, the Bun server serves the built React app from `/` and the JSON API
from `/api/*` in the same process. If `dist/` does not exist, `/` returns a build hint instead of a
broken page.

Startup enables SQLite WAL mode plus a `busy_timeout` so short-lived concurrent access is less likely
to fail immediately. If startup reports that the port is already in use, stop the previous
`bun web/finance/server.ts` process or choose another `PORT`.

## Optional environment variables

- `PORT` — override the listening port.
- `OPENELINARO_ROOT` — override the repo root used for path resolution.
- `OPENELINARO_FINANCE_DB_PATH` — repo-local path to the SQLite finance database.
- `OPENELINARO_FINANCE_FORECAST_PATH` — repo-local path to the forecast JSON config.

The server resolves finance paths relative to the repo root and rejects values that escape the repository.

## Type-checking

```bash
bun run check
```

That runs the root TypeScript check plus the finance dashboard workspace project file.

## Routes

### Static UI

- `/` — built React dashboard when `dist/` exists
- `/assets/*` — Vite build output

### API

- `GET /api/health`
- `GET /api/finance/metadata`
- `GET /api/finance/summary`
- `GET /api/finance/overview`
- `GET /api/finance/signals`
- `GET /api/finance/budget?date=...&weeklyLimit=...&periods=...`
- `GET /api/finance/spending-breakdown?...transaction filters...`
- `GET /api/finance/transactions?...transaction filters...`
- `GET /api/finance/transactions/aggregates?...transaction filters...`
- `GET /api/finance/review?limit=...`
- `POST /api/finance/review`
- `GET /api/finance/accounts`
- `GET /api/finance/receivables?today=...&horizonDays=...&status=...`
- `GET /api/finance/payables?today=...&status=...`
- `GET /api/finance/recurring?today=...&refresh=...&noAutoSeed=...&seedLimit=...`
- `POST /api/finance/recurring/refresh?today=...&noAutoSeed=...&seedLimit=...`
- `GET /api/finance/income-sources`
- `GET /api/finance/fx`
- `GET /api/finance/fx/events`
- `GET /api/finance/import-runs?limit=...`
- `POST /api/finance/import`
- `POST /api/finance/settings`
- `GET /api/finance/forecast/summary`
- `GET /api/finance/forecast/cashflow`
- `GET /api/finance/forecast/tax`
- `GET /api/finance/what-if?purchaseAmountCad=...&date=...&countsTowardBudget=...`
- `POST /api/finance/what-if`

### POST payloads

`POST /api/finance/review`

```json
{
  "decisions": [
    {
      "id": 123,
      "category": "Food/Groceries",
      "countsTowardBudget": true,
      "descriptionClean": "IGA groceries",
      "note": "Reviewed from dashboard"
    }
  ]
}
```

`POST /api/finance/what-if`

```json
{
  "purchaseAmountCad": 250,
  "date": "2026-03-17",
  "countsTowardBudget": true
}
```

`POST /api/finance/settings`

```json
{
  "timezone": "UTC",
  "weeklyLimitCad": 700,
  "monthlyLimitCad": 700,
  "weeklyStartDate": "2026-02-01",
  "fxUsdCad": 1.365,
  "spreadsheetId": "YOUR_SPREADSHEET_ID",
  "accountsGid": "0",
  "transactionsGid": "0"
}
```

`POST /api/finance/import`

```json
{
  "source": "csv",
  "dryRun": true,
  "csvText": "Date,Description,Amount\n2026-03-17,Sample,-25.00"
}
```
