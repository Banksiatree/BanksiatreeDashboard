/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      /* accounting.banktransactions.read + accounting.payments.read added
         for the Cash Split tab's GST/PAYG rate, calculated from real
         BankTransactions/Payments (see fetchXeroCashBasisGst below) - no
         BAS/Activity Statement API exists to pull a report from (confirmed
         against Xero's full official OpenAPI spec, not guessed - see that
         function's comment). Note this app is on Xero's new granular-scope
         system (created after 2 March 2026): the older, broader
         "accounting.transactions.read" scope is invalid for apps like this
         one and Xero's OAuth screen rejects it outright with
         error=invalid_scope - it had to be split into these two specific
         ones instead. Any already-connected org needs to Reconnect on the
         Connections screen once before a new scope takes effect - the old
         token was issued without it. */
      /* accounting.budgets.read added for the P&L/Budget tabs' Budget
         Manager pull (GET Budgets). accounting.settings.read added so
         classifyAccount (see below) can read the Chart of Accounts (GET
         Accounts) - the reliable way to tell Revenue/COGS/Wages/Opex
         accounts apart, replacing an earlier attempt that read an
         undocumented report-cell field and didn't work. Any already-
         connected org needs to Reconnect once more before either new scope
         takes effect. */
      scopes: 'offline_access accounting.reports.profitandloss.read accounting.banktransactions.read accounting.payments.read accounting.budgets.read accounting.settings.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'
    },
    async status(env, h) {
      const tokens = await h.getTokens();
      if (!tokens) return { connected: false };
      const conns = await h.fetchJson('https://api.xero.com/connections');
      const tenant = Array.isArray(conns) ? conns[0] : null;
      return {
        connected: !!tenant,
        org: tenant ? tenant.tenantName : null,
        sandbox: !!(tenant && /demo company/i.test(tenant.tenantName || '')),
        lastSync: null
      };
    },
    async fetchRange(env, h, q) {
      const tenantId = await xeroTenantId(env, h);
      /* Revenue and the rest of the P&L are queried on DIFFERENT windows, per
         the owner's explicit instruction: Revenue is tracked via Xero's bank
         feed, which lags a trading day behind, so it's queried Tue-Mon to
         land on the right deposits. COGS/Wages/Overheads are recorded in
         Xero on their own accrual dates (bills, payroll), no lag, so they're
         queried on the true Mon-Sun trading week - the same q.from/q.to
         OOLIO uses. q.from/q.to here ARE that true Mon-Sun week. */
      const revenueQ = { from: shiftIsoDate(q.from, 1), to: shiftIsoDate(q.to, 1) };
      const [revenueResult, expenseResult] = await Promise.all([
        fetchXeroPL(h, tenantId, revenueQ.from, revenueQ.to),
        fetchXeroPL(h, tenantId, q.from, q.to)
      ]);
      return {
        revenue: revenueResult.revenue,
        cogs: expenseResult.cogs,
        wagesSuper: expenseResult.wagesSuper,
        overheads: expenseResult.overheads
      };
    },
    async fetchMonthly(env, h, q) {
      const tenantId = await xeroTenantId(env, h);
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months, revenue: [], cogs: [], wagesSuper: [], overheads: [] };
      /* Same Tue-Mon-for-Revenue vs Mon-Sun-for-everything-else split as
         fetchRange, just per calendar month instead of per week. Two P&L
         calls per month (revenue window + expense window), all months and
         both windows fetched in parallel. */
      const results = await Promise.all(months.map(async (mo) => {
        const [y, m] = mo.split('-').map(Number);
        const monthFrom = mo + '-01';
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const monthTo = mo + '-' + String(lastDay).padStart(2, '0');
        const revFrom = shiftIsoDate(monthFrom, 1);
        const revTo = shiftIsoDate(monthTo, 1);
        try {
          const [revenueResult, expenseResult] = await Promise.all([
            fetchXeroPL(h, tenantId, revFrom, revTo),
            fetchXeroPL(h, tenantId, monthFrom, monthTo)
          ]);
          return {
            revenue: revenueResult.revenue,
            cogs: expenseResult.cogs,
            wagesSuper: expenseResult.wagesSuper,
            overheads: expenseResult.overheads
          };
        } catch (e) { return null; }
      }));
      for (const r of results) {
        out.revenue.push(r ? r.revenue : null);
        out.cogs.push(r ? r.cogs : null);
        out.wagesSuper.push(r ? r.wagesSuper : null);
        out.overheads.push(r ? r.overheads : null);
      }
      return out;
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    configured: true,
    auth: null,
    mode: 'export', /* OOLIO has no self-serve GET/reporting API - fed by CSV export (fallback ladder rung 4, guided upload)
                        AND, once set up in OOLIO, by their signed order.complete webhook
                        (POST /api/webhook/oolio, see apiWebhookOolio below) - both write
                        the same KV day-store. fetchRange also reconciles against per-event
                        markers written by the webhook (see writeOolioEventMarker below). */
    oauth: {},
    async status(env, h) {
      const ls = await lastSync(env, 'pos');
      return { connected: !!ls, org: 'OOLIO Sales Feed (CSV upload)', sandbox: false, lastSync: ls };
    },
    async fetchRange(env, h, q) {
      /* Reconciled against per-event markers (see writeOolioEventMarker) day
         by day, taking whichever is higher - the running total can lose a
         count when two DIFFERENT webhook deliveries land at the same instant
         (KV has no atomic increment), the markers can't. Scoped to fetchRange
         only (This week/Last week/etc, always a short range) rather than
         fetchMonthly, to keep the 24-month trend on its existing fast path. */
      const dates = eachDate(q.from, q.to);
      const [blobRaws, markerCounts] = await Promise.all([
        Promise.all(dates.map((d) => env.TOKENS.get('data:pos:' + d))),
        Promise.all(dates.map((d) => countOolioEventMarkers(env, d)))
      ]);
      let total = 0;
      dates.forEach((d, i) => {
        let blobCount = 0;
        if (blobRaws[i]) { try { blobCount = JSON.parse(blobRaws[i]).count || 0; } catch (e) {} }
        total += Math.max(blobCount, markerCounts[i]);
      });
      return { count: total };
    },
    async fetchMonthly(env, h, q) {
      const r = await h.monthlyIngested(q.fromMonth, q.toMonth);
      return { months: r.months, count: r.byMonth.map((m) => (m ? (m.count || 0) : null)) };
    },
    /* OOLIO Sales Feed CSV columns (confirmed from a real export):
       Order No., Type, Date/Time, Store, Created By, Gross Sales, Discounts,
       Surcharges, Net Sales, Taxes, Net Sales ex Tax, Tips, Payment Surcharges,
       Cash Rounding, Total Collected, Receipt
       No Status column - a transaction counts as completed unless it's an
       exact duplicate row (re-exported overlap) or a true all-zero row
       (Gross Sales, Net Sales and Total Collected all $0.00). */
    async parseExport(env, h, raw) {
      const rows = parseCsv(raw.text);
      if (!rows.length) return [];
      const header = rows[0].map((c) => c.trim());
      const idx = (name) => header.indexOf(name);
      const iDateTime = idx('Date/Time');
      const iGross = idx('Gross Sales');
      const iNet = idx('Net Sales');
      const iTotal = idx('Total Collected');
      if (iDateTime < 0 || iGross < 0 || iNet < 0 || iTotal < 0) {
        throw new Error('unexpected OOLIO export columns');
      }
      const seen = new Set();
      const byDate = {};
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < header.length) continue;
        const key = r.join('\u0001');
        if (seen.has(key)) continue; /* exact duplicate row - skip */
        seen.add(key);
        if (r[iGross] === '$0.00' && r[iNet] === '$0.00' && r[iTotal] === '$0.00') continue; /* all-zero row */
        const isoDate = oolioDateToIso(r[iDateTime]);
        if (!isoDate) continue;
        byDate[isoDate] = (byDate[isoDate] || 0) + 1;
      }
      return Object.entries(byDate).map(([date, count]) => ({ date, count }));
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
};

/* ----------------------------------------------------------------------------
   Xero helpers: tenant id lookup (cached in KV - avoids a /connections call
   on every metrics request) and the P&L section walker.
---------------------------------------------------------------------------- */
async function xeroTenantId(env, h) {
  const cached = env.TOKENS ? await env.TOKENS.get('xero:tenantId') : null;
  if (cached) return cached;
  const conns = await h.fetchJson('https://api.xero.com/connections');
  const tenant = Array.isArray(conns) ? conns[0] : null;
  if (!tenant) { const e = new Error('no Xero tenant'); e.status = 401; throw e; }
  if (env.TOKENS) await env.TOKENS.put('xero:tenantId', tenant.tenantId, { expirationTtl: 3600 });
  return tenant.tenantId;
}

/* Wage/super keyword match, per capability-matrix.md. "Our Wages", "Owner
   Super Expense" and "Distribution of Profit" are the owner's own
   equity-style drawings, not operating wages or overheads, so all three are
   excluded entirely rather than counted as wagesSuper or overheads.
   CORRECTED to match the owner's real chart of accounts (confirmed against
   an actual P&L export) - the owner's wage account is literally named "Our
   Wages", not "Owner Wages and Salaries" as first assumed, which is why
   Wage % was running ~40pts too high every week: owner's wages were being
   counted as staff wage cost instead of excluded. The bookkeeper has since
   also split super into separate "Owner Super Expense" (excluded, same as
   wages) and "Staff Super Expense" (a real wage cost - matches the general
   WAGE_KEYWORD_RE below, no separate rule needed). */
const WAGE_KEYWORD_RE = /wages|salaries|superannuation|super|payroll|annual leave|long service|workcover/i;
const OWNER_WAGE_RE = /^our\s+wages$/i;
const OWNER_SUPER_RE = /owner['’]?s?\s+super(annuation)?(\s+expense)?/i;
const DISTRIBUTION_OF_PROFIT_RE = /distribution\s+of\s+profit/i;

function xeroCellValue(row, periodIndex) {
  const c = row.Cells && row.Cells[periodIndex + 1];
  if (!c) return 0;
  const v = parseFloat(String(c.Value || '0').replace(/[^0-9.\-]/g, ''));
  return isFinite(v) ? v : 0;
}
function findXeroSummary(section) {
  for (const row of section.Rows || []) {
    if (row.RowType === 'SummaryRow') return row;
    if (row.RowType === 'Section') { const s = findXeroSummary(row); if (s) return s; }
  }
  return null;
}
function walkXeroOpex(section, periodIndex, acc) {
  for (const row of section.Rows || []) {
    if (row.RowType === 'Row') {
      const label = (row.Cells && row.Cells[0] && row.Cells[0].Value) || '';
      const val = xeroCellValue(row, periodIndex);
      if (DISTRIBUTION_OF_PROFIT_RE.test(label)) continue; /* excluded entirely */
      if (OWNER_WAGE_RE.test(label)) continue; /* excluded entirely */
      if (OWNER_SUPER_RE.test(label)) continue; /* excluded entirely */
      if (WAGE_KEYWORD_RE.test(label)) acc.wagesSuper += val;
      else acc.overheads += val;
    } else if (row.RowType === 'Section') {
      walkXeroOpex(row, periodIndex, acc);
    }
  }
}
function walkXeroPL(reportRows, periodIndex) {
  let revenue = 0, cogs = 0;
  const opexAcc = { wagesSuper: 0, overheads: 0 };
  for (const row of reportRows) {
    if (row.RowType !== 'Section') continue;
    const title = (row.Title || '').toLowerCase();
    /* Cost of Sales checked FIRST and revenue matching explicitly excludes
       it - both titles can contain the word "sales", so order/exclusion
       here matters to avoid COGS being miscounted as Revenue. */
    if (title.includes('cost of sales')) {
      const s = findXeroSummary(row);
      cogs += s ? xeroCellValue(s, periodIndex) : 0;
    } else if (!title.includes('other') && (title.includes('income') || title.includes('revenue') || title.includes('trading income'))) {
      const s = findXeroSummary(row);
      revenue += s ? xeroCellValue(s, periodIndex) : 0;
    } else if (title.includes('operating expenses') || title === 'expenses' || title.includes('less operating expenses')) {
      walkXeroOpex(row, periodIndex, opexAcc);
    }
  }
  return { revenue, cogs, wagesSuper: opexAcc.wagesSuper, overheads: opexAcc.overheads };
}

/* Issues one Xero P&L call for a date range and returns the parsed figures.
   Used twice per period by the accounting adapter (once for Revenue's Tue-
   Mon window, once for COGS/Wages/Overheads' Mon-Sun window). */
async function fetchXeroPL(h, tenantId, from, to) {
  const url = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=' + from + '&toDate=' + to;
  const data = await h.fetchJson(url, { headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' } });
  const rows = (data && data.Reports && data.Reports[0] && data.Reports[0].Rows) || [];
  return walkXeroPL(rows, 0);
}

/* ----------------------------------------------------------------------------
   P&L tab (banksia-dashboard-spec.md #3.2). Xero has no public API for saved/
   custom report layouts ("Profit and Loss - Weekly KPI (COGS/WAGES)" only
   exist as report-designer layouts in the Xero UI, not fetchable by name or
   ID - confirmed against Xero's own developer forum, an open unimplemented
   feature request). Same underlying ledger though, so this replicates the
   same figures via the plain Reports/ProfitAndLoss endpoint:
     - Wages split (Kitchen/BOH, FOH, Owner): the "4 Labour" tracking
       category IS fetchable - trackingCategoryID returns one column per
       tracking option, covering the whole P&L.
     - COGS split (FOH/BOH/Retail): no tracking category confirmed for this
       one, so it's a keyword/account-code match on the Cost of Sales rows,
       with anything unmatched landing in a visible "uncategorised" bucket
       rather than being silently guessed into FOH or BOH.
   dashboard.html computes every derived figure (status colour, catch-up
   gaps, transaction targets) from the raw numbers this returns - same rule
   as the rest of the file (see dashboard.html's own header comment).
---------------------------------------------------------------------------- */

const COGS_RETAIL_RE = /5-3600|retail/i;
const COGS_BOH_RE = /food|kitchen/i;
const COGS_FOH_RE = /beverage|\bbar\b|wine|beer|liquor|drinks?/i;

function walkXeroCogsSplit(section, periodIndex, acc) {
  for (const row of section.Rows || []) {
    if (row.RowType === 'Row') {
      const label = (row.Cells && row.Cells[0] && row.Cells[0].Value) || '';
      const value = xeroCellValue(row, periodIndex);
      let bucket;
      if (COGS_RETAIL_RE.test(label)) bucket = 'retail';
      else if (COGS_BOH_RE.test(label)) bucket = 'boh';
      else if (COGS_FOH_RE.test(label)) bucket = 'foh';
      else bucket = 'uncategorised';
      acc.buckets[bucket] += value;
      acc.lines.push({ label, value, bucket });
    } else if (row.RowType === 'Section') {
      walkXeroCogsSplit(row, periodIndex, acc);
    }
  }
}

/* Splits Operating Expenses into: owner's own equity-style drawings
   (excluded from every other bucket, same OWNER_WAGE_RE/OWNER_SUPER_RE/
   DISTRIBUTION_OF_PROFIT_RE as walkXeroOpex - becomes the waterfall's
   "Owner wages" line), staff wages (WAGE_KEYWORD_RE), and everything else
   (the Opex line-item list the P&L tab's "Opex total" dropdown shows -
   whatever new accounts the bookkeeper adds later show up here
   automatically, nothing to hardcode). */
function walkXeroOpexDetail(section, periodIndex, acc) {
  for (const row of section.Rows || []) {
    if (row.RowType === 'Row') {
      const label = (row.Cells && row.Cells[0] && row.Cells[0].Value) || '';
      const value = xeroCellValue(row, periodIndex);
      if (DISTRIBUTION_OF_PROFIT_RE.test(label) || OWNER_WAGE_RE.test(label) || OWNER_SUPER_RE.test(label)) {
        acc.ownerWages += value;
        acc.ownerWagesLines.push({ label, value });
      } else if (WAGE_KEYWORD_RE.test(label)) {
        acc.wagesSuperExclOwner += value;
        acc.wageLines.push({ label, value });
      } else {
        acc.opexTotal += value;
        acc.opexLines.push({ label, value });
      }
    } else if (row.RowType === 'Section') {
      walkXeroOpexDetail(row, periodIndex, acc);
    }
  }
}

function walkXeroPLSplit(reportRows, periodIndex) {
  let revenue = 0;
  const cogsAcc = { buckets: { foh: 0, boh: 0, retail: 0, uncategorised: 0 }, lines: [] };
  const opexAcc = { opexLines: [], opexTotal: 0, wageLines: [], wagesSuperExclOwner: 0, ownerWages: 0, ownerWagesLines: [] };
  for (const row of reportRows) {
    if (row.RowType !== 'Section') continue;
    const title = (row.Title || '').toLowerCase();
    if (title.includes('cost of sales')) {
      walkXeroCogsSplit(row, periodIndex, cogsAcc);
    } else if (!title.includes('other') && (title.includes('income') || title.includes('revenue') || title.includes('trading income'))) {
      const s = findXeroSummary(row);
      revenue += s ? xeroCellValue(s, periodIndex) : 0;
    } else if (title.includes('operating expenses') || title === 'expenses' || title.includes('less operating expenses')) {
      walkXeroOpexDetail(row, periodIndex, opexAcc);
    }
  }
  return { revenue, cogs: cogsAcc, opex: opexAcc };
}

/* Same plain report call fetchXeroPL uses, just returning the fuller split
   structure walkXeroPLSplit builds instead of walkXeroPL's flat totals. */
async function fetchXeroPLSplit(h, tenantId, from, to) {
  const url = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=' + from + '&toDate=' + to;
  const data = await h.fetchJson(url, { headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' } });
  const rows = (data && data.Reports && data.Reports[0] && data.Reports[0].Rows) || [];
  return walkXeroPLSplit(rows, 0);
}

/* Tracking category lookup, cached in KV like xeroTenantId - avoids a
   TrackingCategories call on every P&L fetch. Case-insensitive substring
   match on Name (e.g. "4 Labour"), only considers ACTIVE categories. */
async function xeroTrackingCategoryId(env, h, tenantId, nameSubstring) {
  const cacheKey = 'xero:trackingcat:' + nameSubstring.toLowerCase();
  const cached = env.TOKENS ? await env.TOKENS.get(cacheKey) : null;
  if (cached) return cached;
  const data = await h.fetchJson('https://api.xero.com/api.xro/2.0/TrackingCategories', { headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' } });
  const cats = (data && data.TrackingCategories) || [];
  const needle = nameSubstring.toLowerCase();
  const match = cats.find((c) => c.Status === 'ACTIVE' && (c.Name || '').toLowerCase().includes(needle));
  if (!match) return null;
  if (env.TOKENS) await env.TOKENS.put(cacheKey, match.TrackingCategoryID, { expirationTtl: 3600 });
  return match.TrackingCategoryID;
}

const WAGE_OWNER_OPTION_RE = /admin/i;
const WAGE_BOH_OPTION_RE = /boh|kitchen|back/i;
const WAGE_FOH_OPTION_RE = /foh|front/i;

function walkXeroWageColumns(section, columnCount, sums) {
  for (const row of section.Rows || []) {
    if (row.RowType === 'Row') {
      const label = (row.Cells && row.Cells[0] && row.Cells[0].Value) || '';
      if (!WAGE_KEYWORD_RE.test(label) || OWNER_WAGE_RE.test(label) || OWNER_SUPER_RE.test(label) || DISTRIBUTION_OF_PROFIT_RE.test(label)) continue;
      for (let i = 0; i < columnCount; i++) sums[i] += xeroCellValue(row, i);
    } else if (row.RowType === 'Section') {
      walkXeroWageColumns(row, columnCount, sums);
    }
  }
}

/* Reports/ProfitAndLoss with trackingCategoryID (no trackingOptionID)
   returns ONE period but a column PER tracking option instead of a single
   total column - the Header row's cells (after the label column) name each
   option. Wage-keyword rows are summed per column, then each column is
   matched to a display bucket by keyword; anything that doesn't match
   Admin/BOH/FOH keeps its own literal Xero option name rather than being
   dropped, same "nothing silently goes missing" rule as the Opex lines. */
async function fetchXeroWagesSplit(h, tenantId, from, to, trackingCategoryId) {
  const url = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?fromDate=' + from + '&toDate=' + to + '&trackingCategoryID=' + trackingCategoryId;
  const data = await h.fetchJson(url, { headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' } });
  const report = data && data.Reports && data.Reports[0];
  const rows = (report && report.Rows) || [];
  const headerRow = rows.find((r) => r.RowType === 'Header');
  const headerCells = (headerRow && headerRow.Cells) || [];
  const optionNames = headerCells.slice(1).map((c) => c.Value || 'Unassigned');
  if (!optionNames.length) return null;
  const sums = optionNames.map(() => 0);
  for (const row of rows) {
    if (row.RowType !== 'Section') continue;
    const title = (row.Title || '').toLowerCase();
    if (title.includes('operating expenses') || title === 'expenses' || title.includes('less operating expenses')) {
      walkXeroWageColumns(row, optionNames.length, sums);
    }
  }
  const buckets = { kitchenBoh: 0, foh: 0, owner: 0, other: {} };
  optionNames.forEach((name, i) => {
    const val = sums[i];
    if (WAGE_OWNER_OPTION_RE.test(name)) buckets.owner += val;
    else if (WAGE_BOH_OPTION_RE.test(name)) buckets.kitchenBoh += val;
    else if (WAGE_FOH_OPTION_RE.test(name)) buckets.foh += val;
    else buckets.other[name] = (buckets.other[name] || 0) + val;
  });
  return buckets;
}

/* Chart of Accounts, cached in KV (~1hr - it rarely changes and both the
   P&L and Budget tabs need it on every fetch) same TTL-caching pattern as
   xeroTenantId. This is the RELIABLE way to classify an account
   (Revenue/COGS/Wages/Opex) - Xero tags every account with a Type
   (confirmed against Xero's own OpenAPI spec: SALES/REVENUE, DIRECTCOSTS,
   OVERHEADS/EXPENSE, plus balance-sheet types this app doesn't care about).
   Replaces an earlier attempt that read an account-id field off
   Reports/ProfitAndLoss cells, which doesn't reliably carry one. */
async function fetchXeroAccounts(env, h, tenantId) {
  const cacheKey = 'xero:accounts';
  if (env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  }
  const data = await h.fetchJson('https://api.xero.com/api.xro/2.0/Accounts', { headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' } });
  const accounts = (data && data.Accounts) || [];
  if (env.TOKENS) await env.TOKENS.put(cacheKey, JSON.stringify(accounts), { expirationTtl: 3600 });
  return accounts;
}

/* 'revenue'|'cogs'|'wages'|'owner'|'opex', or null (excluded - balance
   sheet accounts, Other Income). Same OWNER_WAGE_RE/OWNER_SUPER_RE/
   DISTRIBUTION_OF_PROFIT_RE/WAGE_KEYWORD_RE that already govern this
   classification everywhere else in the file - one rule, not a second one
   that could drift out of sync. */
function classifyAccount(account) {
  const type = account.Type || '';
  const name = account.Name || '';
  if (type === 'SALES' || type === 'REVENUE') return 'revenue';
  if (type === 'DIRECTCOSTS') return 'cogs';
  if (type === 'OVERHEADS' || type === 'EXPENSE') {
    if (DISTRIBUTION_OF_PROFIT_RE.test(name) || OWNER_WAGE_RE.test(name) || OWNER_SUPER_RE.test(name)) return 'owner';
    if (WAGE_KEYWORD_RE.test(name)) return 'wages';
    return 'opex';
  }
  return null;
}

/* AccountID -> bucket, and AccountID -> Name (the latter for the Budget
   tab's Opex line-item labels). Shared by apiPL's budget section and
   apiBudget. */
function buildAccountBucketMap(accounts) {
  const bucketMap = {}, nameMap = {};
  accounts.forEach((a) => {
    const bucket = classifyAccount(a);
    if (!bucket) return;
    bucketMap[a.AccountID] = bucket;
    nameMap[a.AccountID] = a.Name;
  });
  return { bucketMap, nameMap };
}

/* Budget Manager (whole-of-business only - Xero's Budget Manager has no
   tracking-category split, per the spec). GET Budgets with no BudgetID
   returns the default Overall Budget: BudgetLines keyed by AccountID, each
   with a monthly BudgetBalances array. Split into a raw fetch and a pure
   per-month bucketing function so both the P&L tab (sums whichever months
   fall in its requested range) and the Budget tab (exposes all 12 months
   of a year) share the same underlying code. */
/* Two calls, not one - confirmed against Xero's own OpenAPI spec (its
   official example response for the plain list call shows BudgetLines: []
   on every budget, even real approved ones with real data): GET /Budgets
   only ever returns budget METADATA (BudgetID, Type, Description, Status),
   never populated BudgetLines - you have to follow up with GET
   /Budgets/{BudgetID} for the one budget that matters to actually get its
   line items. This was the real reason the table stayed empty even after
   the Chart-of-Accounts fix (which was correct on its own, just fetching
   from an endpoint that can never have data). Picks the Type:'OVERALL'
   budget (matches the spec's whole-of-business-only requirement); falls
   back to the first budget in the list if none is explicitly OVERALL. */
async function fetchXeroBudgetLines(h, tenantId, debugOut) {
  const listData = await h.fetchJson('https://api.xero.com/api.xro/2.0/Budgets', { headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' } });
  const list = (listData && listData.Budgets) || [];
  if (debugOut) debugOut.budgetList = list.map((b) => ({ BudgetID: b.BudgetID, Type: b.Type, Description: b.Description, Status: b.Status }));
  if (!list.length) return [];
  const chosen = list.find((b) => b.Type === 'OVERALL') || list[0];
  const detailData = await h.fetchJson('https://api.xero.com/api.xro/2.0/Budgets/' + chosen.BudgetID, { headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' } });
  const detail = (detailData && detailData.Budgets && detailData.Budgets[0]) || (detailData && detailData.Budgets);
  return (detail && detail.BudgetLines) || [];
}

/* bucketMap/nameMap from buildAccountBucketMap. Returns { 'YYYY-MM':
   {revenue,cogs,wages,opex,ownerPay,opexLines:[{label,value}],matched},
   ... } for every month any matched line has a balance for - matched
   counts how many balances actually resolved to a bucket, so the caller
   can tell a genuinely-zero budget apart from the bucketing not working.
   opexLines is the Budget tab's line-item detail, one entry per budgeted
   opex account for that month - mirrors the P&L tab's own Opex dropdown. */
/* BudgetBalance.Period is documented as looking like "2019-08", but Xero's
   own OpenAPI spec flags it x-is-msdate - the same ".NET-wrapped"
   /Date(1234567890000+0000)/ format parseXeroApiDate already handles for
   other endpoints in this file, not a plain "YYYY-MM" string. Handles all
   three shapes actually seen in the wild (wrapped date, YYYY-MM-DD, bare
   YYYY-MM) rather than betting on the docs being right about just one. */
function xeroPeriodMonth(period) {
  if (!period) return null;
  const s = String(period);
  const m = /\/Date\((\d+)/.exec(s);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 7);
  return null;
}

function bucketBudgetLinesByMonth(lines, bucketMap, nameMap) {
  const byMonth = {};
  for (const line of lines) {
    const bucket = bucketMap[line.AccountID];
    if (!bucket) continue;
    const label = (nameMap && nameMap[line.AccountID]) || 'Unknown account';
    for (const bal of line.BudgetBalances || []) {
      const month = xeroPeriodMonth(bal.Period);
      if (!month) continue;
      if (!byMonth[month]) byMonth[month] = { revenue: 0, cogs: 0, wages: 0, opex: 0, ownerPay: 0, opexLines: [], matched: 0 };
      /* Number(...) not a bare || fallback - Xero's own example response
         for this field shows it quoted ("1000") even though the schema
         types it as a number, so coerce defensively rather than risk
         string concatenation. */
      const amt = Number(bal.Amount) || 0;
      const key = bucket === 'owner' ? 'ownerPay' : bucket;
      byMonth[month][key] = (byMonth[month][key] || 0) + amt;
      if (bucket === 'opex') byMonth[month].opexLines.push({ label, value: amt });
      byMonth[month].matched++;
    }
  }
  return byMonth;
}

/* Thin wrapper kept for apiPL: sums whichever months in byMonth fall in
   [from,to] into one range total, same shape apiPL has always depended on. */
async function fetchXeroBudget(h, tenantId, from, to, bucketMap, nameMap) {
  const lines = await fetchXeroBudgetLines(h, tenantId);
  const byMonth = bucketBudgetLinesByMonth(lines, bucketMap, nameMap);
  const fromMonth = from.slice(0, 7), toMonth = to.slice(0, 7);
  const totals = { revenue: 0, cogs: 0, wages: 0, opex: 0, ownerPay: 0 };
  let matchedLines = 0;
  for (const [month, vals] of Object.entries(byMonth)) {
    if (month < fromMonth || month > toMonth) continue;
    for (const b of ['revenue', 'cogs', 'wages', 'opex', 'ownerPay']) { totals[b] += vals[b] || 0; }
    matchedLines += vals.matched;
  }
  totals.netProfit = totals.revenue - totals.cogs - totals.wages - totals.opex;
  return { totals, matchedLines, totalLines: lines.length };
}

/* GET /api/pl - powers the P&L tab. Every section is fetched independently
   and wrapped in its own try/catch (same "one source failing never breaks
   the rest of the payload" rule as apiCashSplit) - a Budget Manager hiccup
   should never blank out the actual figures, and vice versa. Every derived
   figure (status colour, catch-up gaps, transaction targets) is left to
   dashboard.html, same rule as the rest of the app: the Worker supplies raw
   data, the dashboard computes metrics. */
async function apiPL(env, url) {
  const adapter = ADAPTERS.accounting;
  if (!adapter || !adapter.configured) return json({ available: false, reason: 'not_configured' });

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return json({ error: 'bad range' }, 400);
  }

  const h = makeHelpers(env, 'accounting');
  let tenantId;
  try {
    tenantId = await xeroTenantId(env, h);
  } catch (err) {
    return json({ available: false, reason: 'not_connected', error: plainError(err.status || 401) });
  }

  const revFrom = shiftIsoDate(from, 1);
  const revTo = shiftIsoDate(to, 1);

  const errors = {};
  let split = null;
  try {
    split = await fetchXeroPLSplit(h, tenantId, from, to);
  } catch (err) { errors.pl = plainError(err.status || 500); }

  let revenueOnly = null;
  try {
    revenueOnly = (await fetchXeroPLSplit(h, tenantId, revFrom, revTo)).revenue;
  } catch (err) { errors.revenue = plainError(err.status || 500); }

  let wagesSplit = null;
  try {
    const trackingCategoryId = await xeroTrackingCategoryId(env, h, tenantId, '4 labour');
    if (trackingCategoryId) wagesSplit = await fetchXeroWagesSplit(h, tenantId, from, to, trackingCategoryId);
  } catch (err) { errors.wages = plainError(err.status || 500); }

  let transactions = null;
  try {
    const posAdapter = ADAPTERS.pos;
    if (posAdapter && posAdapter.configured) {
      const spanDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
      if (spanDays > 35) {
        /* fetchRange reads day-by-day (a KV get AND a KV list-scan per
           date - see its own comment) - fine for a week/month, but blows
           past Cloudflare's per-invocation subrequest limit over a
           multi-month span like "All completed months this year".
           fetchMonthly instead reads one pre-aggregated total per month
           (monthagg:pos:<YYYY-MM>) - exactly the fast path it was built
           for (see the "Trend queries" comment above it). from/to are
           always month-aligned for any period long enough to hit this
           branch, so summing whole months is exact, not approximate. */
        const r = await posAdapter.fetchMonthly(env, h, { fromMonth: from.slice(0, 7), toMonth: to.slice(0, 7) });
        transactions = r.count.reduce((sum, c) => sum + (c || 0), 0);
      } else {
        const r = await posAdapter.fetchRange(env, h, { from, to });
        transactions = r.count;
      }
    }
  } catch (err) { errors.transactions = plainError(err.status || 500); }

  let budget = null;
  if (split) {
    try {
      const accounts = await fetchXeroAccounts(env, h, tenantId);
      const { bucketMap, nameMap } = buildAccountBucketMap(accounts);
      const b = await fetchXeroBudget(h, tenantId, from, to, bucketMap, nameMap);
      budget = { available: b.matchedLines > 0, ...b.totals, matchedLines: b.matchedLines, totalLines: b.totalLines };
    } catch (err) { errors.budget = plainError(err.status || 500); }
  }

  await noteSync(env, 'accounting');
  return json({
    available: true,
    period: { from, to },
    revenue: { actual: revenueOnly },
    transactions: { actual: transactions },
    cogs: split ? { ...split.cogs.buckets, total: split.cogs.buckets.foh + split.cogs.buckets.boh + split.cogs.buckets.retail + split.cogs.buckets.uncategorised, lines: split.cogs.lines } : null,
    wages: split ? {
      splitAvailable: !!wagesSplit,
      kitchenBoh: wagesSplit ? wagesSplit.kitchenBoh : null,
      foh: wagesSplit ? wagesSplit.foh : null,
      owner: wagesSplit ? wagesSplit.owner : null,
      other: wagesSplit ? wagesSplit.other : null,
      unassigned: wagesSplit ? null : split.opex.wagesSuperExclOwner,
      total: split.opex.wagesSuperExclOwner
    } : null,
    opex: split ? { lines: split.opex.opexLines, total: split.opex.opexTotal } : null,
    ownerWages: split ? { actual: split.opex.ownerWages, lines: split.opex.ownerWagesLines } : null,
    netProfit: split ? { actual: (revenueOnly || 0) - split.cogs.buckets.foh - split.cogs.buckets.boh - split.cogs.buckets.retail - split.cogs.buckets.uncategorised - split.opex.wagesSuperExclOwner - split.opex.opexTotal - split.opex.ownerWages } : null,
    budget,
    errors
  });
}

/* GET /api/budget?year=YYYY - powers the Budget tab (banksia-dashboard-
   spec.md #3.3): a read-only, whole-of-business, month-by-month view of
   Xero's Budget Manager for the given calendar year (Jan-Dec, not the
   business's July-June financial year - the spec is explicit that this tab
   mirrors the old spreadsheet's Jan-Dec Budget tab). Targets only, no
   actuals/variance here - that's the P&L tab. Account classification comes
   straight from the Chart of Accounts (fetchXeroAccounts/classifyAccount),
   independent of any date range, so unlike the P&L tab's budget section
   this needs no separate actuals call just to build the bucket map. */
async function apiBudget(env, url) {
  const adapter = ADAPTERS.accounting;
  if (!adapter || !adapter.configured) return json({ available: false, reason: 'not_configured' });

  const year = url.searchParams.get('year');
  if (!year || !/^\d{4}$/.test(year)) return json({ error: 'bad year' }, 400);

  const h = makeHelpers(env, 'accounting');
  let tenantId;
  try {
    tenantId = await xeroTenantId(env, h);
  } catch (err) {
    return json({ available: false, reason: 'not_connected', error: plainError(err.status || 401) });
  }

  const errors = {};
  let byMonth = {}, totalLines = 0, accountsFetched = 0, debug = null;
  try {
    const accounts = await fetchXeroAccounts(env, h, tenantId);
    accountsFetched = accounts.length;
    const { bucketMap, nameMap } = buildAccountBucketMap(accounts);
    const debugOut = {};
    const lines = await fetchXeroBudgetLines(h, tenantId, debugOut);
    byMonth = bucketBudgetLinesByMonth(lines, bucketMap, nameMap);
    totalLines = lines.length;
    /* TEMP diagnostic - this exact pipeline (account classification, then
       matching budget lines to it) has been wrong three times already on
       assumptions that looked right in the docs but weren't in practice.
       If it's STILL not matching, surface the raw shape directly instead
       of guessing again. Remove once a real org has confirmed
       budgetAvailable:true. */
    if (accountsFetched === 0 || totalLines === 0 || Object.keys(byMonth).length === 0) {
      debug = {
        accountsFetched,
        totalBudgetLines: totalLines,
        budgetList: debugOut.budgetList || null,
        sampleAccount: accounts[0] || null,
        sampleBudgetLine: (lines && lines[0]) || null,
        sampleBudgetBalance: (lines && lines[0] && lines[0].BudgetBalances && lines[0].BudgetBalances[0]) || null
      };
    }
  } catch (err) {
    errors.budget = plainError(err.status || 500);
    errors.budgetDebug = String((err && err.message) || err) + (err && err.body ? (' | body=' + String(err.body).slice(0, 300)) : '');
  }

  const months = [];
  let matchedLines = 0;
  for (let m = 1; m <= 12; m++) {
    const key = year + '-' + String(m).padStart(2, '0');
    const v = byMonth[key];
    if (v) matchedLines += v.matched;
    const netProfit = v ? (v.revenue - v.cogs - v.wages - v.opex) : null;
    months.push({
      month: key,
      revenue: v ? v.revenue : null,
      cogs: v ? v.cogs : null,
      wages: v ? v.wages : null,
      opex: v ? v.opex : null,
      opexLines: v ? v.opexLines : [],
      ownerPay: v ? v.ownerPay : null,
      netProfit,
      actualProfit: (v && netProfit != null) ? netProfit - v.ownerPay : null
    });
  }

  await noteSync(env, 'accounting');
  return json({
    available: true,
    year,
    months,
    budgetAvailable: matchedLines > 0,
    totalLines,
    debug,
    errors
  });
}

/* ----------------------------------------------------------------------------
   Cash Split tab: GST/PAYG rate calculated directly from real ledger
   transactions - not from a BAS/Activity Statement report. That report
   simply has no public API (confirmed by searching Xero's complete,
   official OpenAPI specification - every product, every endpoint - for
   "BAS", "IAS" and "Activity Statement" and finding nothing; two earlier
   attempts at named report endpoints both turned out not to exist). Xero's
   Activity Statements screen is a UI-only feature.

   What IS real and does exist (checked the same way, against the same
   spec): BankTransactions and Payments, both genuine, documented endpoints.
   This owner's BAS uses the CASH accounting method (confirmed from their
   real Activity Statement screen), so GST is recognised when money actually
   moves, not when something is invoiced - which these two endpoints
   together cover completely, with no overlap between them:
     - BankTransactions (Type RECEIVE/SPEND): money coded directly to the
       bank account without going through an invoice - the normal path for
       a cafe's day-to-day till/EFTPOS deposits and card-charged expenses.
       These carry their own Total/TotalTax directly, no calculation needed.
     - Payments (PaymentType ACCRECPAYMENT/ACCPAYPAYMENT): money applied to
       a sales invoice or a supplier bill. The payment itself has no GST
       split, so its GST is prorated by the paid amount's share of the
       underlying invoice/bill's Total - the standard way partial payments
       are handled for cash-basis GST.

   Deliberately scoped to the last FULLY COMPLETED quarter, never the
   current one in progress: you can't lodge a BAS for a quarter that hasn't
   ended, so the previous quarter is always either already lodged or ready
   to be - a stable, checkable answer. The current quarter is a moving
   target with every new transaction, which is exactly the kind of
   in-progress estimate this deliberately avoids.

   NOT YET VERIFIED against this owner's real numbers - built from Xero's
   real API surface (not guessed, unlike the two earlier BAS attempts
   tonight), but the only real test is comparing its output for the last
   completed quarter against the actual finalised figure on the owner's own
   Activity Statement screen before this is trusted.
---------------------------------------------------------------------------- */

/* Xero's JSON dates come back as either "/Date(1717200000000+0000)/" (the
   classic .NET format, still used by the Accounting API) or a plain
   YYYY-MM-DD string, depending on endpoint - handles both. */
function parseXeroApiDate(s) {
  if (!s) return null;
  const m = /\/Date\((\d+)/.exec(s);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}
function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

/* The last fully completed calendar quarter (never the current one) - see
   the block comment above for why. */
function lastCompletedQuarter() {
  const now = new Date();
  const q = Math.floor(now.getUTCMonth() / 3);
  const startOfThisQuarter = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  const endOfPrevQuarter = new Date(startOfThisQuarter.getTime() - 86400000);
  const startOfPrevQuarter = new Date(Date.UTC(endOfPrevQuarter.getUTCFullYear(), endOfPrevQuarter.getUTCMonth() - 2, 1));
  return {
    from: startOfPrevQuarter.toISOString().slice(0, 10),
    to: endOfPrevQuarter.toISOString().slice(0, 10)
  };
}

/* Pages through a Xero list endpoint (BankTransactions/Payments both work
   the same way: up to 100 per page, `page` query param, 1-indexed). The
   `where` clause is sent as an optimisation, but the real, authoritative
   date-range check happens client-side on every item's own date field
   regardless - so even if Xero's `where` date syntax turns out to be
   subtly wrong, results stay correct, just less efficient to fetch. Sorted
   newest-first, so this can stop as soon as it walks past `from`. */
async function fetchXeroPaged(h, tenantId, path, whereClause, dateField, from, to) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams();
    if (whereClause) params.set('where', whereClause);
    params.set('order', dateField + ' DESC');
    params.set('page', String(page));
    const url = 'https://api.xero.com/api.xro/2.0/' + path + '?' + params.toString();
    const data = await h.fetchJson(url, { headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' } });
    const items = data[path] || [];
    if (!items.length) break;
    let wentPastRange = false;
    for (const item of items) {
      const iso = parseXeroApiDate(item[dateField]);
      if (!iso || iso > to) continue;
      if (iso < from) { wentPastRange = true; break; }
      out.push(item);
    }
    if (wentPastRange || items.length < 100) break;
  }
  return out;
}

/* Calculates G1/1A/1B for a date range from real transactions - see the
   block comment above for the full method. Known scope gap: doesn't include
   RECEIVE-OVERPAYMENT/RECEIVE-PREPAYMENT/SPEND-OVERPAYMENT/SPEND-PREPAYMENT
   bank transaction types, only plain RECEIVE/SPEND - if the validation
   check against a real completed quarter is off, that's the first thing to
   extend. */
async function fetchXeroCashBasisGst(h, tenantId, from, to) {
  const dateWhere = 'Date >= DateTime(' + from.split('-').map(Number).join(',') + ') && Date <= DateTime(' + to.split('-').map(Number).join(',') + ')';

  const [bankReceive, bankSpend, invoicePayments, billPayments] = await Promise.all([
    fetchXeroPaged(h, tenantId, 'BankTransactions', dateWhere + ' && Type=="RECEIVE"', 'Date', from, to),
    fetchXeroPaged(h, tenantId, 'BankTransactions', dateWhere + ' && Type=="SPEND"', 'Date', from, to),
    fetchXeroPaged(h, tenantId, 'Payments', dateWhere + ' && PaymentType=="ACCRECPAYMENT"', 'Date', from, to),
    fetchXeroPaged(h, tenantId, 'Payments', dateWhere + ' && PaymentType=="ACCPAYPAYMENT"', 'Date', from, to)
  ]);

  let g1 = 0, oneA = 0, oneB = 0;
  for (const bt of bankReceive) { g1 += bt.Total || 0; oneA += bt.TotalTax || 0; }
  for (const bt of bankSpend) { oneB += bt.TotalTax || 0; }
  for (const p of invoicePayments) {
    const amt = p.Amount || 0;
    g1 += amt;
    const inv = p.Invoice;
    if (inv && inv.Total) oneA += amt * ((inv.TotalTax || 0) / inv.Total);
  }
  for (const p of billPayments) {
    const amt = p.Amount || 0;
    const bill = p.Invoice; /* Xero's Payment schema calls a paid bill "Invoice" too - same object shape, Type ACCPAY */
    if (bill && bill.Total) oneB += amt * ((bill.TotalTax || 0) / bill.Total);
  }

  return {
    g1: round2(g1), oneA: round2(oneA), oneB: round2(oneB),
    gstPct: g1 !== 0 ? (oneA - oneB) / g1 : 0,
    counts: { bankReceive: bankReceive.length, bankSpend: bankSpend.length, invoicePayments: invoicePayments.length, billPayments: billPayments.length }
  };
}

/* ----------------------------------------------------------------------------
   GET /api/cashsplit - powers the Cash Split tab. Live GST%/COGS%/Cash% for
   the most recent BAS period, so the owner only has to type in the one
   number Xero can never supply: what actually landed in the bank this week.
   Per-section try/catch (gst vs pl), same "one source failing never breaks
   the rest of the payload" approach as fetchSlot - a missing/unparsable BAS
   report shouldn't also hide COGS/Cash, and vice versa.
---------------------------------------------------------------------------- */
async function apiCashSplit(env) {
  const adapter = ADAPTERS.accounting;
  if (!adapter || !adapter.configured) return json({ available: false, reason: 'not_configured' });

  const h = makeHelpers(env, 'accounting');
  let tenantId;
  try {
    tenantId = await xeroTenantId(env, h);
  } catch (err) {
    return json({ available: false, reason: 'not_connected', error: plainError(err.status || 401) });
  }

  /* Last fully completed quarter, always - see fetchXeroCashBasisGst's block
     comment for why. Same period is used for the COGS/Cash P&L figures
     below too, so all three rates come from the one consistent, stable,
     already-closed quarter rather than an in-progress one. */
  const period = lastCompletedQuarter();
  period.label = period.from + ' to ' + period.to + ' (last completed quarter)';

  let gst = null, gstError = null;
  try {
    const bas = await fetchXeroCashBasisGst(h, tenantId, period.from, period.to);
    gst = { pct: bas.gstPct, g1: bas.g1, oneA: bas.oneA, oneB: bas.oneB, counts: bas.counts };
  } catch (err) {
    /* TEMP: appending raw diagnostic detail after the friendly message while
       this is still being validated against the owner's real numbers -
       trim back to plainError(...) alone once confirmed working. */
    const debugBits = [];
    debugBits.push('status=' + (err && err.status));
    debugBits.push('msg=' + String((err && err.message) || err).slice(0, 150));
    if (err && err.body) debugBits.push('xeroBody=' + String(err.body).slice(0, 400));
    if (err && err.debug) debugBits.push(err.debug);
    gstError = plainError(err.status || 500) + '  [DEBUG: ' + debugBits.join(' | ') + ']';
  }

  let pl = null, plError = null;
  try {
    const r = await fetchXeroPL(h, tenantId, period.from, period.to);
    const netRevenue = r.revenue - r.cogs;
    const netProfit = netRevenue - r.wagesSuper - r.overheads;
    const cogsPct = r.revenue ? r.cogs / r.revenue : 0;
    const cashPctRaw = netRevenue ? netProfit / netRevenue : 0;
    pl = {
      revenue: r.revenue, cogs: r.cogs, wagesSuper: r.wagesSuper, overheads: r.overheads,
      netRevenue, netProfit, cogsPct,
      cashPctRaw, cashPct: Math.max(cashPctRaw, 0.01), cashFloored: cashPctRaw < 0.01
    };
  } catch (err) {
    plError = plainError(err.status || 500);
  }

  await noteSync(env, 'accounting');
  return json({
    available: true,
    period,
    gst: gst ? { ...gst, error: null } : { error: gstError || 'unavailable' },
    pl: pl ? { ...pl, error: null } : { error: plError || 'unavailable' }
  });
}

/* ----------------------------------------------------------------------------
   OOLIO helpers: a small quoted-CSV line parser (commas can appear inside
   quoted fields, e.g. the "30 June 2026, 02:54 pm" Date/Time column) and the
   "30 June 2026" -> "2026-06-30" date converter.
---------------------------------------------------------------------------- */
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, ''); /* strip BOM */
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      /* skip - handled by \n */
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}
const OOLIO_MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function oolioDateToIso(dateTimeStr) {
  /* Handles both "30 June 2026, 02:54 pm" and "09 Aug 2026, 03:04 pm" -
     OOLIO exports use full month names in some reports and abbreviated
     3-letter names in others, so match on the first 3 letters either way. */
  const m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec((dateTimeStr || '').trim());
  if (!m) return null;
  const mo = OOLIO_MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  return m[3] + '-' + mo + '-' + m[1].padStart(2, '0');
}

/* ----------------------------------------------------------------------------
   OOLIO webhook (Svix-signed, at-least-once delivery). See POST /api/webhook/oolio
   in the router and processOolioWebhookEvent() below.
   Secret: OOLIO_WEBHOOK_SECRET (the "whsec_..." value OOLIO/Svix issues per
   endpoint - set via `wrangler secret put OOLIO_WEBHOOK_SECRET`).
---------------------------------------------------------------------------- */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
}
const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 300; /* 5 minutes, standard Svix guidance */

/* Verifies svix-id / svix-timestamp / svix-signature against the raw request
   body per Svix's scheme: HMAC-SHA256("{id}.{timestamp}.{body}") using the
   secret after its "whsec_" prefix (base64) as the raw key, base64-encoded
   (standard, not url-safe), compared against any of the space-delimited
   "v1,<sig>" values in svix-signature (there can be more than one during
   secret rotation). Returns true/false; never throws. */
async function verifyOolioWebhook(secretRaw, svixId, svixTimestamp, rawBody, svixSignatureHeader) {
  if (!secretRaw || !svixId || !svixTimestamp || !rawBody || !svixSignatureHeader) return false;
  const tsNum = parseInt(svixTimestamp, 10);
  if (!isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > SVIX_TIMESTAMP_TOLERANCE_SECONDS) return false;
  try {
    const secretB64 = secretRaw.replace(/^whsec_/, '');
    const keyBytes = base64ToBytes(secretB64);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signedContent = svixId + '.' + svixTimestamp + '.' + rawBody;
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
    const expected = bytesToB64(sigBuf);
    const candidates = svixSignatureHeader.split(' ').map((p) => p.trim()).filter(Boolean);
    for (const c of candidates) {
      const comma = c.indexOf(',');
      const sig = comma >= 0 ? c.slice(comma + 1) : c;
      if (timingSafeEqual(sig, expected)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

/* Idempotency: a delivery (and its retries) share the same svix-id. Returns
   true if this id was already processed (caller should skip re-counting but
   still return 2xx), false the first time (and marks it seen). */
async function webhookAlreadySeen(env, id) {
  if (!env.TOKENS) return false;
  const key = 'webhookseen:oolio:' + id;
  const existing = await env.TOKENS.get(key);
  if (existing) return true;
  await env.TOKENS.put(key, '1', { expirationTtl: 172800 }); /* 48h - comfortably covers the ~24h retry window */
  return false;
}

/* Read-modify-write a single numeric field for one day's stored row. Used by
   the webhook (one event at a time) alongside saveIngestedRows (whole-day
   overwrite, used by CSV upload) - both write the same data:<source>:<date>
   KV row, so a later CSV upload for a day will overwrite whatever the
   webhook had accumulated for that day (intended for backfills/corrections,
   not routine double-entry). NOTE: KV has no atomic increment, so two
   webhook deliveries landing in the same instant could race; at this venue's
   volume that's an acceptable, documented limitation rather than a Durable
   Object-backed counter. (incrementIngestedField itself lives down in the
   ingest-storage section below, alongside saveIngestedRows/monthlyIngested,
   since it also has to keep the monthly aggregate in sync.) */

/* Permanent, uniquely-keyed marker per accepted webhook event - written
   ALONGSIDE incrementIngestedField's running total, not instead of it (the
   running total still feeds monthagg/the trend chart - see fetchMonthly,
   left untouched). Two different events always write two different keys,
   so unlike the running total these can never lose a count to a race - see
   the reconciliation in the pos adapter's fetchRange above. */
async function writeOolioEventMarker(env, date, eventId) {
  await env.TOKENS.put('evtpos:' + date + ':' + eventId, '1');
}
async function countOolioEventMarkers(env, date) {
  let count = 0, cursor;
  const prefix = 'evtpos:' + date + ':';
  for (;;) {
    const page = await env.TOKENS.list(cursor ? { prefix, cursor } : { prefix });
    count += page.keys.length;
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return count;
}

/* Handles one already-signature-verified OOLIO webhook event. Only
   order.complete increments the day's transaction count - order.refunded is
   intentionally ignored (per kpi-spec.md: refunds never reduce the count),
   and any other/unknown type is ignored too. Uses data.createdAt (order
   creation time) for the trading date, matching how the CSV export's
   Date/Time column was interpreted; pos data is stored and read on the true
   trading date with no shift - OOLIO has no reporting lag, so nothing needs
   correcting here. (Xero's own lag is handled inside the accounting
   adapter's fetchRange/fetchMonthly, which query two separate windows.)
   eventId (the same id apiWebhookOolio already dedupes deliveries on) is
   used to key this event's marker - see writeOolioEventMarker above. */
async function processOolioWebhookEvent(env, evt, eventId) {
  if (!evt || evt.type !== 'order.complete' || !evt.data) return;
  const createdAt = evt.data.createdAt;
  if (!createdAt || typeof createdAt !== 'string' || createdAt.length < 10) return;
  const date = createdAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  await incrementIngestedField(env, 'pos', date, 'count', 1);
  if (eventId) await writeOolioEventMarker(env, date, eventId);
}

/* POST /api/webhook/oolio - public (no dashboard session).
   OOLIO's support first described Svix-signed delivery (svix-id/timestamp/
   signature + a whsec_ secret), but when this endpoint was actually
   configured they confirmed THIS integration sends unsigned - "it doesn't
   need a signing key, data flows direct". So verification here is
   opportunistic, not required: if a secret is configured AND the request
   carries svix headers, the signature is checked and bad ones are rejected;
   otherwise the payload is trusted and processed as-is (this endpoint's
   only real protection, absent signing, is that its URL isn't published
   anywhere public). Idempotency falls back to data.id alone (an order
   should only ever be counted once) when there's no svix-id to key off.
   CHANGED from data.id + data.status: that combination let the same order
   be counted more than once if OOLIO fires order.complete again with a
   different status for it later (e.g. completed, then some other terminal
   status) - each status value produced a different dedupe key, so the
   second delivery wasn't recognised as the same order and got counted
   again. Confirmed as a real, observed problem (a real week's count ran 7
   over OOLIO's own number), not theoretical - not yet re-confirmed against
   a live week under this fix, so treat the same way as everything else
   this session: check a real day's count against OOLIO again once this is
   live for a few days.
   Must ack quickly (a slow non-2xx risks OOLIO treating it as failed) and
   be safe against being called more than once for the same event. */
async function apiWebhookOolio(env, request) {
  const rawBody = await request.text();
  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');
  const secret = env.OOLIO_WEBHOOK_SECRET;

  if (secret && svixId && svixTimestamp && svixSignature) {
    const ok = await verifyOolioWebhook(secret, svixId, svixTimestamp, rawBody, svixSignature);
    if (!ok) return json({ error: 'invalid signature' }, 401);
  }

  let evt;
  try { evt = JSON.parse(rawBody); } catch (e) { return json({ error: 'bad json' }, 400); }

  const dedupeId = svixId || ((evt && evt.data && evt.data.id) ? evt.data.id : null);
  if (dedupeId && (await webhookAlreadySeen(env, dedupeId))) return json({ ok: true, duplicate: true });

  try {
    await processOolioWebhookEvent(env, evt, dedupeId);
    await noteSync(env, 'pos');
  } catch (e) {
    /* Already marked "seen" above (when we had a dedupeId), so a processing
       bug here won't cause endless retries to double count - but do surface
       a 500 so OOLIO's dashboard shows the failed delivery for us to
       investigate. */
    return json({ error: 'processing failed' }, 500);
  }
  return json({ ok: true });
}

/* ----------------------------------------------------------------------------
   Owner Input tab (banksia-dashboard-spec.md #3.1). Unlike Settings/Manual
   Entry (both localStorage, per-device), this data has to be visible across
   every owner's own device - the wage split needs everyone's hours for the
   week together, not just whichever device is open - so it lives in KV,
   behind these endpoints, same TOKENS namespace everything else uses.

   Keys:
     sys:owners                              -> JSON array of owner names
     ownerinput:entry:<weekMonday>:<slug>     -> { ownerName, daysOff,
                                                    workouts, ownerHours,
                                                    updatedAt }
                                                  one key per owner per week
                                                  so two owners saving in the
                                                  same week never clobber
                                                  each other
     ownerinput:staffhours:<weekMonday>       -> { staffHours, updatedAt }
                                                  one shared figure per week,
                                                  last write wins (same
                                                  low-friction rule as
                                                  everything else here)

   "Pay drawn" (the other half of the wage-rate formula, alongside the hours
   entered here) is deliberately NOT a field on this tab - the spec's field
   list is days off/workouts/owner hours/staff hours only, no typed-in
   dollar figure, which means it's the same Xero figure already pulled for
   the P&L tab's "Owner wages" line. apiOwnerWages below reuses
   fetchXeroPLSplit (built for P&L) rather than re-deriving it.
---------------------------------------------------------------------------- */
function slugify(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
async function getOwnersList(env) {
  const raw = await env.TOKENS.get('sys:owners');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
async function getOwnerWeekEntries(env, week) {
  const prefix = 'ownerinput:entry:' + week + ':';
  const out = [];
  let cursor;
  for (;;) {
    const page = await env.TOKENS.list(cursor ? { prefix, cursor } : { prefix });
    const raws = await Promise.all(page.keys.map((k) => env.TOKENS.get(k.name)));
    raws.forEach((raw) => { if (raw) { try { out.push(JSON.parse(raw)); } catch (e) {} } });
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

/* GET /api/ownerinput?week=<mondayISO> - cheap KV-only read (owners list +
   that week's entries + staff hours), no external API call, safe to
   auto-load on tab open. */
async function apiOwnerInputGet(env, url) {
  const week = url.searchParams.get('week');
  if (!week || !WEEK_RE.test(week)) return json({ error: 'bad week' }, 400);
  const [owners, entries, staffHoursRaw] = await Promise.all([
    getOwnersList(env),
    getOwnerWeekEntries(env, week),
    env.TOKENS.get('ownerinput:staffhours:' + week)
  ]);
  let staffHours = null;
  if (staffHoursRaw) { try { staffHours = JSON.parse(staffHoursRaw); } catch (e) {} }
  return json({ owners, entries, staffHours });
}

/* POST /api/ownerinput/entry - body {week, ownerName, daysOff, workouts,
   ownerHours}. Upserts one owner's entry for that week; editable any time,
   re-saving just overwrites the same key. */
async function apiOwnerInputEntry(env, request) {
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const week = body && body.week, ownerName = body && String(body.ownerName || '').trim();
  if (!week || !WEEK_RE.test(week) || !ownerName) return json({ ok: false, error: 'bad request' }, 400);
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const entry = {
    ownerName,
    daysOff: num(body.daysOff),
    workouts: num(body.workouts),
    ownerHours: num(body.ownerHours),
    updatedAt: new Date().toISOString()
  };
  await env.TOKENS.put('ownerinput:entry:' + week + ':' + slugify(ownerName), JSON.stringify(entry));
  return json({ ok: true });
}

/* POST /api/ownerinput/staffhours - body {week, staffHours}. Shared weekly
   figure, not tied to a specific owner. */
async function apiOwnerInputStaffHours(env, request) {
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const week = body && body.week;
  if (!week || !WEEK_RE.test(week)) return json({ ok: false, error: 'bad request' }, 400);
  const n = parseFloat(body.staffHours);
  const record = { staffHours: isFinite(n) ? n : 0, updatedAt: new Date().toISOString() };
  await env.TOKENS.put('ownerinput:staffhours:' + week, JSON.stringify(record));
  return json({ ok: true });
}

/* POST /api/ownerinput/owner - body {name}. Grows the simple name picker;
   not a real login/auth system, so anyone with the dashboard link can add
   one - matches the whole dashboard's already-open, unlisted-URL model. */
async function apiOwnerInputAddOwner(env, request) {
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const name = String((body && body.name) || '').trim();
  if (!name || name.length > 60) return json({ ok: false, error: 'bad name' }, 400);
  const owners = await getOwnersList(env);
  if (!owners.some((o) => o.toLowerCase() === name.toLowerCase())) {
    owners.push(name);
    await env.TOKENS.put('sys:owners', JSON.stringify(owners));
  }
  return json({ ok: true, owners });
}

/* GET /api/ownerwages?from=&to= - the "Run the Numbers" pull for this tab.
   Deliberately narrow: reuses fetchXeroPLSplit (already built for P&L) and
   returns just the one figure this tab displays, rather than re-fetching
   everything P&L/Cash Split already pull independently on their own
   buttons - the spec leaves "exact scope of what Run the Numbers fetches"
   open (see banksia-dashboard-spec.md #5), and every tab so far has its own
   independent on-demand trigger rather than one shared orchestrator. */
async function apiOwnerWages(env, url) {
  const adapter = ADAPTERS.accounting;
  if (!adapter || !adapter.configured) return json({ available: false, reason: 'not_configured' });
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!from || !to || !WEEK_RE.test(from) || !WEEK_RE.test(to)) return json({ error: 'bad range' }, 400);

  const h = makeHelpers(env, 'accounting');
  let tenantId;
  try {
    tenantId = await xeroTenantId(env, h);
  } catch (err) {
    return json({ available: false, reason: 'not_connected', error: plainError(err.status || 401) });
  }
  try {
    const split = await fetchXeroPLSplit(h, tenantId, from, to);
    await noteSync(env, 'accounting');
    return json({ available: true, actual: split.opex.ownerWages });
  } catch (err) {
    return json({ available: false, error: plainError(err.status || 500) });
  }
}

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Coalesces concurrent refresh attempts for the same source. Xero (and most
   OAuth providers that rotate refresh tokens) invalidates the old refresh
   token the instant it's used - so if two callers both see an expiring
   token and both fire a refresh with the SAME refresh_token, only one can
   succeed; the other gets rejected and (before this fix) would surface as a
   broken/incorrect period. This became reachable once apiMetrics started
   fetching cur/prev/yoy concurrently instead of one-at-a-time. */
const _refreshInFlight = new Map(); /* source -> Promise<accessToken> */

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  if (_refreshInFlight.has(source)) return _refreshInFlight.get(source);

  const doRefresh = (async () => {
    /* Re-check under the "lock" - another concurrent caller may have already
       completed the refresh while we were waiting our turn. */
    const latest = await getTokens(env, source);
    if (latest && latest.access_token && latest.expires_at && Date.now() < latest.expires_at - skewMs) {
      return latest.access_token;
    }
    const cfg = adapter.oauth || {};
    if (!latest || !latest.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
    const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
      grant_type: 'refresh_token',
      refresh_token: latest.refresh_token
    }, env));
    if (!res.ok) {
      /* refresh failed: force a reconnect rather than silently serving stale data */
      const e = new Error('refresh failed'); e.status = 401; throw e;
    }
    const fresh = await res.json();
    const updated = {
      ...latest,
      access_token: fresh.access_token,
      /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
      refresh_token: fresh.refresh_token || latest.refresh_token,
      expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
    };
    await saveTokens(env, source, updated);
    return updated.access_token;
  })();

  _refreshInFlight.set(source, doRefresh);
  try {
    return await doRefresh;
  } finally {
    _refreshInFlight.delete(source);
  }
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        const e = new Error('HTTP ' + res.status);
        e.status = res.status;
        e.body = bodyText;
        throw e;
      }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn\u2019t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn\u2019t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn\u2019t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads/webhook-increments overwrite/adjust in place
   (idempotent; re-ingesting a corrected export is safe and expected).

   PERFORMANCE: the dashboard requests a 24-month trend on every page load
   (see dashboard.html's trendStart calc). Summing 24 months of individual
   day rows on every load - up to ~730 sequential KV reads - was the actual
   cause of "the dashboard is so slow", especially on Connections/first load.
   Fix: keep a running monthly aggregate at monthagg:<source>:<YYYY-MM>,
   updated by the same small delta whenever a day's numbers change (whether
   from a whole-day CSV overwrite or a single webhook increment). A 24-month
   trend then costs 24 fast KV reads instead of hundreds. */

async function getMonthAgg(env, source, monthKey) {
  const raw = await env.TOKENS.get('monthagg:' + source + ':' + monthKey);
  return raw ? JSON.parse(raw) : null;
}
async function putMonthAgg(env, source, monthKey, agg) {
  await env.TOKENS.put('monthagg:' + source + ':' + monthKey, JSON.stringify(agg));
}
/* Applies a small delta to a month's running aggregate. isNewDay marks the
   first time this date has ever had data, so the month's "has any data"
   flag (_days) is only incremented once per date, not once per write. */
async function adjustMonthAgg(env, source, date, isNewDay, fieldDeltas) {
  const monthKey = date.slice(0, 7);
  const agg = (await getMonthAgg(env, source, monthKey)) || { _days: 0 };
  if (isNewDay) agg._days = (agg._days || 0) + 1;
  for (const [k, v] of Object.entries(fieldDeltas)) {
    if (typeof v === 'number' && isFinite(v) && v !== 0) agg[k] = (agg[k] || 0) + v;
  }
  await putMonthAgg(env, source, monthKey, agg);
}

/* One-time (or safe-to-rerun) repair: rebuilds EVERY month's aggregate from
   the actual stored daily rows, by listing all data:<source>:* keys. Needed
   because monthagg only started being maintained going forward from when it
   was introduced - any day rows written before that deploy have no matching
   aggregate contribution until this runs. Safe to run anytime (e.g. after a
   bulk CSV upload) since it always recomputes from the real daily data
   rather than trusting whatever aggregate currently exists. */
async function backfillMonthAgg(env, source) {
  const prefix = 'data:' + source + ':';
  const totals = {}; /* monthKey -> { _days, ...fields } */
  let cursor;
  do {
    const listOpts = cursor ? { prefix, cursor } : { prefix };
    const page = await env.TOKENS.list(listOpts);
    const validKeys = page.keys
      .map((k) => ({ name: k.name, date: k.name.slice(prefix.length) }))
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k.date));
    /* Read every day's value in this page IN PARALLEL - reading them one at
       a time here was the actual reason the repair button used to hang. */
    const raws = await Promise.all(validKeys.map((k) => env.TOKENS.get(k.name)));
    validKeys.forEach((k, i) => {
      const raw = raws[i];
      if (!raw) return;
      let row;
      try { row = JSON.parse(raw); } catch (e) { return; }
      const monthKey = k.date.slice(0, 7);
      if (!totals[monthKey]) totals[monthKey] = { _days: 0 };
      totals[monthKey]._days++;
      for (const [f, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) totals[monthKey][f] = (totals[monthKey][f] || 0) + v;
      }
    });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const months = Object.keys(totals);
  await Promise.all(months.map((mo) => putMonthAgg(env, source, mo, totals[mo])));
  return { source, monthsRebuilt: months.length, months };
}


/* Whole-day overwrite (CSV upload path). Computes the delta against
   whatever was there before so the month aggregate stays correct even when
   a day is re-uploaded with corrected numbers. */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    const key = 'data:' + source + ':' + r.date;
    const oldRaw = await env.TOKENS.get(key);
    const oldRow = oldRaw ? JSON.parse(oldRaw) : null;
    const isNewDay = !oldRow;
    const deltas = {};
    for (const f of new Set([...(oldRow ? Object.keys(oldRow) : []), ...Object.keys(clean)])) {
      const oldV = oldRow && typeof oldRow[f] === 'number' ? oldRow[f] : 0;
      const newV = typeof clean[f] === 'number' ? clean[f] : 0;
      if (newV !== oldV) deltas[f] = newV - oldV;
    }
    await env.TOKENS.put(key, JSON.stringify(clean));
    await adjustMonthAgg(env, source, r.date, isNewDay, deltas);
    saved++;
  }
  return saved;
}

/* Single-field increment (webhook path). */
async function incrementIngestedField(env, source, date, field, delta) {
  const key = 'data:' + source + ':' + date;
  const raw = await env.TOKENS.get(key);
  const isNewDay = !raw;
  const row = raw ? JSON.parse(raw) : {};
  row[field] = (typeof row[field] === 'number' ? row[field] : 0) + delta;
  await env.TOKENS.put(key, JSON.stringify(row));
  await adjustMonthAgg(env, source, date, isNewDay, { [field]: delta });
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Used for single-period queries (This
   week, Last month, etc - typically <=31 days), so reads all days in the
   range IN PARALLEL rather than one at a time. Returns
   { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const dates = eachDate(from, to);
  const raws = await Promise.all(dates.map((date) => env.TOKENS.get('data:' + source + ':' + date)));
  const sums = {};
  let daysWithData = 0, lastDate = null;
  dates.forEach((date, i) => {
    const raw = raws[i];
    if (!raw) return;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  });
  return { sums, daysWithData, lastDate };
}

/* Trend queries (up to 24 months, see dashboard.html): reads the monthly
   aggregate directly - one fast KV read per month - instead of re-summing
   every day in every month on every dashboard load. */
async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const aggs = await Promise.all(months.map((mo) => getMonthAgg(env, source, mo)));
  const byMonth = aggs.map((agg) => {
    if (!agg || !agg._days) return null;
    const { _days, ...rest } = agg;
    return rest;
  });
  return { months, byMonth };
}


/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2})_(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

/* Xero's Revenue (bank-feed driven, so it lags a trading day) and its
   COGS/Wages/Overheads (accrual-dated bills/payroll, no lag) are queried on
   two DIFFERENT windows - see the accounting adapter's fetchRange/
   fetchMonthly, which handle this internally with two P&L calls. OOLIO/pos
   is always queried on the plain, unshifted trading-day range (it's the
   point of sale - there's no lag to correct for). So fetchSlot itself needs
   no per-source date adjustment; every adapter gets the same q.from/q.to. */
function shiftIsoDate(s, days) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function fetchSlot(env, q, debugOut) {
  /* One period slot: pull each configured source; null where unavailable.
     debugOut (optional, TEMP - see apiMetrics) collects why, if it fails. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
      if (debugOut) {
        debugOut[source] = {
          status: err && err.status,
          message: String((err && err.message) || err).slice(0, 200),
          body: err && err.body ? String(err.body).slice(0, 400) : null
        };
      }
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    /* These three were previously awaited one after another - each one doing
       a live Xero call plus KV reads - which serialised their latency. They
       don't depend on each other, so run them concurrently. */
    const curDebug = {}; /* TEMP diagnostic - see apiMetrics's debug field below */
    const [curOut, prevOut, yoyOut] = await Promise.all([
      fetchSlot(env, { ...base, ...cur }, curDebug),
      prev ? fetchSlot(env, { ...base, ...prev }) : Promise.resolve(null),
      yoy ? fetchSlot(env, { ...base, ...yoy }) : Promise.resolve(null)
    ]);
    periods.cur = curOut;
    periods.prev = prevOut;
    periods.yoy = yoyOut;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    /* TEMP diagnostic snapshot - what date range "cur" (usually "this week")
       actually resolved to server-side, and why any source came back null,
       if it did. Remove this whole block (and the debug: line below, and the
       debugOut plumbing in fetchSlot above) once the zero-figures issue is
       confirmed fixed. */
    data = {
      generatedAt: new Date().toISOString(), periods: periods, trend: trendOut,
      debug: {
        curRangeRequested: cur,
        curRevenueRangeUsed: { from: shiftIsoDate(cur.from, 1), to: shiftIsoDate(cur.to, 1) },
        curErrors: curDebug
      }
    };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: data.periods,
    trend: data.trend,
    debug: data.debug
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);
    if (path === '/api/webhook/oolio' && request.method === 'POST') return apiWebhookOolio(env, request);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    if (path === '/api/cashsplit' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiCashSplit(env);
    }
    if (path === '/api/pl' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiPL(env, url);
    }
    if (path === '/api/ownerinput' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiOwnerInputGet(env, url);
    }
    if (path === '/api/ownerinput/entry' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiOwnerInputEntry(env, request);
    }
    if (path === '/api/ownerinput/staffhours' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiOwnerInputStaffHours(env, request);
    }
    if (path === '/api/ownerinput/owner' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiOwnerInputAddOwner(env, request);
    }
    if (path === '/api/ownerwages' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiOwnerWages(env, url);
    }
    if (path === '/api/budget' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiBudget(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    if (path === '/api/backfill-monthagg' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source') || 'pos';
      if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
      try {
        const result = await backfillMonthAgg(env, source);
        return json({ ok: true, ...result });
      } catch (e) {
        /* Surface the real reason instead of letting an uncaught exception
           turn into a generic Cloudflare error page that breaks the
           frontend's JSON parsing and shows a useless "check your
           connection" message. */
        return json({ ok: false, error: 'backfill failed', message: String((e && e.message) || e) }, 500);
      }
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
