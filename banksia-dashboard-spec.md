# The Banksia Tree — Consolidated Dashboard Spec

Status: agreed, not yet built. Build happens in Claude Code, one tab at a time, against the
existing live system — no new project.

## 1. Where this lives

- Extends the existing live dashboard: https://banksiatreedashboard.steep-mode-7ecc.workers.dev/
- GitHub repo: `Banksiatree/BanksiatreeDashboard`
- Hosting: Cloudflare Worker, deployed via `wrangler deploy`, connected to the repo for CI/CD
- Storage: existing KV namespace (`TOKENS`)
- Secrets already in place: `ACCOUNTING_CLIENT_ID` / `ACCOUNTING_CLIENT_SECRET` (Xero OAuth),
  `INGEST_TOKEN` (Oolio webhook)
- No login gate. Decided: stays open, no Cloudflare Access/Zero Trust. Relies on the URL being
  unlisted.
- The old standalone rebuild attempt (`kp-itracking-bankiatree` on Vercel /
  `Banksiatree/KPItrackingBankiatree` on GitHub) is left alone for now — not merged, not deleted,
  not archived. Revisit later.

## 2. Core rule: nothing pulls live except on demand

Xero and Oolio are only queried when someone presses **Run the Numbers**. No auto-refresh, no
polling, no background cron pulling data on a timer. This is a deliberate cost/simplicity choice
(Cloudflare + API usage). Exact scope of what a single "Run the Numbers" press fetches (i.e.
whether it's one combined pull or per-tab pulls) is left to whatever is fastest and cheapest to
build — decide at build time.

## 3. Tabs

Build order: **P&L first**, then the others, one at a time, each needing sign-off before starting
the next.

### 3.1 Owner Input (+ Run the Numbers)

- Fields per entry: days off, workouts, owner hours worked, staff hours worked (totals only, not
  per-staff-member detail).
- Multiple owners. Identity via a simple name picker (not a real login/auth system).
- Owner hourly wage is derived from hours worked and pay drawn.
- When more than one owner logs hours in the same period, wage is split by each owner's share of
  total hours worked.
- Entries are editable any time, not locked after saving.
- Personal stats (days off, workouts) are owner-only — not a staff-facing feature.
- Stored only inside the new dashboard (not written back to the Google Sheet).
- This tab also carries the **Run the Numbers** button that triggers the Xero/Oolio pull for
  everything else.

### 3.2 P&L

Layout mirrors the existing spreadsheet's order:

Revenue → Transactions (monthly) → COGS (dropdown split: FOH / BOH / Retail) → Wages (dropdown
split: Kitchen/BOH, FOH, Owner) → Opex total (dropdown showing each line item) → Owner wages →
true net profit left over.

- Every line shows a status against its KPI or budget target (on track / over / under). Colour
  coding, red/green/amber-style.
- A **catch-up panel**: e.g. "250 extra transactions needed this month to hit target", "$X more
  revenue needed", "drop COGS by 2%". Catch-up math is **prorated to today** (not full month vs
  actual-to-date, but scaled to how much of the period has elapsed).
- Period selector: choose **all completed months this calendar year**, **last month**, or **this
  month**.
- Budget comparison is against **whole-of-business totals only** (Xero Budget Manager doesn't
  split by tracking category, so budget targets aren't split FOH/BOH/Retail even though actuals
  are).
- "Add lines" means pulling in more Xero account lines as they appear — e.g. if the bookkeeper
  creates a new account like "Liquor licence" that isn't in the current mapping. Any unmapped
  line is auto-dumped into the Opex catch-all so nothing silently goes missing.
- Data sources: Xero saved custom reports "Profit and Loss - Weekly KPI (COGS)" and "Profit and
  Loss - Weekly KPI (WAGES)", using the existing "4 Labour" tracking category (splits
  Admin/BOH/FOH already) and the "Retail Goods" account (5-3600, sits under Direct Costs,
  confirmed as its own grouping separate from food/bev COGS — verified directly in the Xero
  chart of accounts).
- KPI/budget target thresholds per line (what counts as "on track" vs "over") are deferred —
  different rule per line, to be defined when this tab is actually wired up.

### 3.3 Budget

- Read-only view of Xero's Budget Manager. No editing here — to change a target, change it in
  Xero.
- Shown as **monthly figures across the year** (Jan–Dec), matching the structure of the old
  Budget tab in the spreadsheet.
- Whole-of-business totals only (no Admin/BOH/FOH split — this is a Xero Budget Manager
  limitation, not a design choice).
- Also includes the same operational assumptions the old sheet had feeding those $ figures:
  weeks in month, covers/transactions target, average spend target.
- This tab shows targets only. It does **not** show variance/actual-vs-budget — that comparison
  lives on the P&L tab.

### 3.4 History

- One-time import of everything currently in the "TBT 2026 KPI Tracker" and "TBT 2025 KPI
  Tracker" Google Sheet tabs, including personal stats — only 2025 and 2026 data is relevant
  (older years in the sheet are ignored).
- Any known 2025 date bugs in the sheet get auto-detected and fixed during import, not manually
  patched beforehand.
- After the import, the Sheet is not written to again. New history only accumulates going
  forward whenever **Run the Numbers** is pressed — no background/scheduled writes.
- View supports both: drilling into an individual past week, and a trend view across weeks
  /months.
- The Google Sheet itself isn't retired immediately — Fabian will retire it in his own time once
  he's comfortable the new system has everything.

### 3.5 What-If calculator

- Inputs: Avg Spend/Transaction in **$**, Transactions as a **raw number**, everything else
  (COGS%, wage%, opex%) as **%**.
- Mechanism replicates the sheet's existing "Key KPI Relationships" block on the "TBT 2026 KPI
  Tracker" tab (cells C16:C18 = Labour/F&B/Overheads $, D16:D18 = their %, G12:G14 = the 5
  editable "pink cell" KPI inputs) — same relationships, same 5 inputs, translated into the new
  dashboard.
- Baseline for calculations: the last 4 completed weeks.
- Live calculator only — no saving/naming scenarios.

## 4. Confirmed / verified this round

- Retail COGS already has its own Xero grouping: account `5-3600 Retail Goods`, under Direct
  Costs, separate from all food and beverage COGS accounts. No new Xero setup needed.
- No login gate is being added — the dashboard stays open at its current URL.
- The throwaway Vercel/GitHub rebuild attempt is left untouched for now.

## 5. Still open (deferred on purpose, revisit at build time)

- Exact per-line KPI/budget tolerance rules for the P&L colour coding.
- Exact scope of what a single "Run the Numbers" press fetches, optimised for speed/cost.
- When to actually retire the Google Sheet.
