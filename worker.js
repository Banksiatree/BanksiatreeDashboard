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
/* PATCHED: trend caching decoupled from period caching + hard request ceiling
   (see apiMetrics below) - fixes multi-minute "stuck loading" on any period
   other than whichever one happened to already be cached. */

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
      scopes: 'offline_access accounting.reports.profitandloss.read accounting.settings.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'   /* Xero's token endpoint wants HTTP Basic client auth */
    },

    /* Which connected tenant (organisation) are we using? Xero's /connections
       endpoint can return several; we use the first and surface its name so the
       owner can confirm it's their business. Cached in KV for a few minutes -
       a single dashboard load calls this adapter up to 5x (current period,
       comparison period, year-on-year, plus the trend chart), and re-fetching
       from Xero every time was making loads slow or appear to hang. */
    async _tenant(env, h) {
      const cacheKey = 'xerotenant:cache';
      if (env.TOKENS) {
        const cached = await env.TOKENS.get(cacheKey);
        if (cached) { try { return JSON.parse(cached); } catch (e) {} }
      }
      const conns = await h.fetchJson('https://api.xero.com/connections', {}, {});
      if (!Array.isArray(conns) || !conns.length) { const e = new Error('no tenants'); e.status = 401; throw e; }
      const tenant = conns[0];
      if (env.TOKENS) { try { await env.TOKENS.put(cacheKey, JSON.stringify(tenant), { expirationTtl: 600 }); } catch (e) {} }
      return tenant;
    },

    async status(env, h) {
      let tenant;
      try { tenant = await this._tenant(env, h); }
      catch (e) { return { connected: false }; }
      return {
        connected: true,
        org: tenant.tenantName || null,
        sandbox: /demo company/i.test(tenant.tenantName || ''),
        lastSync: null
      };
    },

    /* Walk the P&L report JSON per capability-matrix.md's documented shape:
       Reports[0].Rows[] with RowType Section (Title + nested Rows) / SummaryRow.
       Returns { revenue, cogs, wagesSuper, overheads } for ONE period column. */
    _walkReport(reportJson, periodIndex) {
      const cellNum = (cells, idx) => {
        if (!cells || !cells[idx]) return 0;
        const v = parseFloat(String(cells[idx].Value).replace(/,/g, ''));
        return isFinite(v) ? v : 0;
      };
      const WAGE_RE = /wages|salaries|superannuation|super|payroll|annual leave|long service|workcover/i;
      /* Confirmed with the owner at reconciliation (kpi-spec.md #5): "Owner
         Wages and Salaries" is the owner's own profit distribution, not a
         rostered labour cost, so it's excluded from Wage % even though it
         matches the general keyword pattern above. */
      const WAGE_EXCLUDE_RE = /owner.*(wages|salaries)|(wages|salaries).*owner/i;
      /* Confirmed with the owner: "Distribution of Profit" also sits inside
         Operating Expenses in their chart of accounts but is a profit
         distribution, not a real overhead - excluded from Overheads too. */
      const PROFIT_DIST_RE = /distribution of profit|profit distribution/i;
      let revenue = null, cogs = null, wagesSuper = 0, opexTotal = null, ownerPayInOpex = 0, profitDistInOpex = 0;
      const report = reportJson && reportJson.Reports && reportJson.Reports[0];
      const rows = (report && report.Rows) || [];
      const amountCol = 1 + periodIndex; /* Cells[0] = label, one amount column per period thereafter */

      function walkSection(section) {
        const title = (section.Title || '').toLowerCase();
        const isIncome = /income|revenue/.test(title) && !/other income/.test(title);
        const isCogs = /cost of sales/.test(title);
        const isOpex = /operating expenses/.test(title);
        let sectionWages = 0;
        (section.Rows || []).forEach((r) => {
          if (r.RowType === 'Row' && isOpex) {
            const label = (r.Cells && r.Cells[0] && r.Cells[0].Value) || '';
            if (WAGE_EXCLUDE_RE.test(label)) { ownerPayInOpex += cellNum(r.Cells, amountCol); }
            else if (PROFIT_DIST_RE.test(label)) { profitDistInOpex += cellNum(r.Cells, amountCol); }
            else if (WAGE_RE.test(label)) { sectionWages += cellNum(r.Cells, amountCol); }
          }
          if (r.RowType === 'SummaryRow') {
            const total = cellNum(r.Cells, amountCol);
            if (isIncome) revenue = (revenue || 0) + total;
            else if (isCogs) cogs = (cogs || 0) + total;
            else if (isOpex) opexTotal = (opexTotal || 0) + total;
          }
        });
        if (isOpex) wagesSuper += sectionWages;
      }
      rows.forEach((r) => { if (r.RowType === 'Section') walkSection(r); });

      const overheads = (opexTotal == null) ? null : (opexTotal - wagesSuper - ownerPayInOpex - profitDistInOpex);
      return {
        revenue: revenue,
        cogs: cogs,
        wagesSuper: wagesSuper,
        overheads: overheads
      };
    },

    async fetchRange(env, h, q) {
      const tenant = await this._tenant(env, h);
      const url = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss'
        + '?fromDate=' + q.from + '&toDate=' + q.to;
      const json = await h.fetchJson(url, {
        headers: { 'Xero-Tenant-Id': tenant.tenantId, 'Accept': 'application/json' }
      }, {});
      return this._walkReport(json, 0);
    },

    /* Xero's `periods` param is capped at 12; split any longer request into
       ≤12-period calls and stitch the results together, month by month. */
    async fetchMonthly(env, h, q) {
      const tenant = await this._tenant(env, h);
      const allMonths = [];
      let [y, m] = q.fromMonth.split('-').map(Number);
      const [ey, em] = q.toMonth.split('-').map(Number);
      while (y < ey || (y === ey && m <= em)) {
        allMonths.push(y + '-' + String(m).padStart(2, '0'));
        m++; if (m > 12) { m = 1; y++; }
        if (allMonths.length > 60) break; /* safety cap, mirrors monthList() */
      }

      const out = { months: allMonths, revenue: [], cogs: [], wagesSuper: [], overheads: [] };
      for (let i = 0; i < allMonths.length; i += 12) {
        const chunk = allMonths.slice(i, i + 12);
        const toDate = chunk[chunk.length - 1] + '-28'; /* safe day-of-month for the report's end date */
        const url = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss'
          + '?toDate=' + toDate + '&periods=' + (chunk.length - 1) + '&timeframe=MONTH';
        let json;
        try {
          json = await h.fetchJson(url, { headers: { 'Xero-Tenant-Id': tenant.tenantId, 'Accept': 'application/json' } }, {});
        } catch (e) {
          chunk.forEach(() => { out.revenue.push(null); out.cogs.push(null); out.wagesSuper.push(null); out.overheads.push(null); });
          continue;
        }
        /* Xero returns columns oldest-to-newest matching `periods`+1 (current + N prior) */
        for (let p = 0; p < chunk.length; p++) {
          const vals = this._walkReport(json, chunk.length - 1 - p);
          out.revenue.push(vals.revenue);
          out.cogs.push(vals.cogs);
          out.wagesSuper.push(vals.wagesSuper);
          out.overheads.push(vals.overheads);
        }
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
    oauth: {},
    mode: 'export', /* OOLIO has no self-serve API for a single venue; real-time
       access goes through Doshii, a partner integration platform built for
       ongoing channel partners (delivery apps etc.), not a quick one-off
       connection - so this uses the guided-upload rung instead: the owner
       downloads OOLIO's own Sales Feed CSV (Back Office > Reports > Sales
       Feed) whenever they like and drops it on the Connections screen. */
    async status(env, h) {
      const ls = await lastSync(env, 'pos');
      return { connected: !!ls, org: ls ? 'OOLIO (uploaded reports)' : null, sandbox: false, lastSync: ls };
    },
    async fetchRange(env, h, q) {
      const r = await h.readIngested(q.from, q.to);
      if (!r.daysWithData) throw new NotConfigured('pos');
      return { count: r.sums.count || 0 };
    },
    async fetchMonthly(env, h, q) {
      const r = await h.monthlyIngested(q.fromMonth, q.toMonth);
      return { months: r.months, count: r.byMonth.map((m) => m ? (m.count || 0) : null) };
    },
    /* Parse OOLIO's "Sales Feed" CSV export (Back Office > Reports > Sales
       Feed > download icon). The export has NO Status column - "Order
       Status" is a filter on the report screen itself, not an exported
       field - so the owner filters to Completed only (unticking Voided and
       Refunded) before exporting, and every row in the file is one
       completed transaction (kpi-spec.md #2). Dates are written like
       "05 July 2026, 02:30 pm"; the Date/Time column is matched loosely.

       ALSO handles a one-off historical backfill: a "SaleID,SaleNo,SaleDate,..."
       export from the venue's previous POS (Lightspeed Restaurant O-Series),
       covering the months before OOLIO went live. Same upload path, same
       source key ('pos') - the header shape tells the two formats apart, so
       nothing on the Connections screen needs to change. Only ever supplies
       a transaction COUNT, same as OOLIO - dollar figures still come from Xero. */
    async parseExport(env, h, raw) {
      const firstLine = (raw.text.replace(/^﻿/, '').split(/\r\n|\n|\r/)[0] || '').toLowerCase();
      if (firstLine.includes('saleid') && firstLine.includes('saledate')) {
        return parseLightspeedHistory(raw.text);
      }
      const lines = raw.text.replace(/^﻿/, '').split(/\r\n|\n|\r/).filter((l) => l.trim().length);
      if (lines.length < 2) throw new Error('empty export');
      const parseCsvLine = (line) => {
        const out = []; let cur = ''; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (inQ) {
            if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
            else cur += c;
          } else {
            if (c === '"') inQ = true;
            else if (c === ',') { out.push(cur); cur = ''; }
            else cur += c;
          }
        }
        out.push(cur);
        return out.map((s) => s.trim());
      };
      const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
      const findCol = (...keywords) => header.findIndex((h) => keywords.some((k) => h.includes(k)));
      const dateCol = findCol('date');
      const orderCol = findCol('order no', 'order number', 'order #');
      if (dateCol === -1) throw new Error('unrecognised export - missing a Date/Time column');
      const statusCol = findCol('status'); /* used only if present, e.g. a future export format */

      const MONTHS = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
        july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
      const parseDateCell = (cell) => {
        let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(cell); /* ISO, just in case */
        if (m) return m[1] + '-' + m[2] + '-' + m[3];
        m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(cell); /* "05 July 2026, 02:30 pm" */
        if (m) {
          const mon = MONTHS[m[2].toLowerCase()];
          if (mon) return m[3] + '-' + mon + '-' + m[1].padStart(2, '0');
        }
        m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(cell); /* DD/MM/YYYY fallback */
        if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
        return null;
      };

      /* Reconciled against the owner's own OOLIO Sales Summary total (the
         check kpi-spec.md #2 requires): a completed-transaction count of 760
         for a sample week matched only when excluding (a) rows where every
         dollar figure is exactly $0.00 (voided orders) and (b) exact
         duplicate rows (same order number, date/time and figures repeated -
         an export quirk, not a second transaction). Negative-amount rows DO
         count - OOLIO's own total includes them. */
      const seenRows = new Set();
      const byDate = {};
      for (let i = 1; i < lines.length; i++) {
        const cells = parseCsvLine(lines[i]);
        if (cells.length <= dateCol) continue;
        if (orderCol !== -1 && !cells[orderCol]) continue; /* skip blank/artifact rows */
        if (statusCol !== -1) { /* only filter by status if the column actually exists */
          const status = (cells[statusCol] || '').toLowerCase();
          if (status && status !== 'completed') continue;
        }
        /* "All zero" row (every $-looking cell parses to 0) = a voided order */
        const rowIsAllZero = cells.every((c) => {
          if (!/^-?\$?[\d,]*\.?\d+$/.test(c)) return true; /* non-money cell, ignore */
          return parseFloat(c.replace(/[$,]/g, '')) === 0;
        });
        if (rowIsAllZero) continue;
        const rowKey = cells.join('|');
        if (seenRows.has(rowKey)) continue; /* exact duplicate row - export quirk, not a second transaction */
        seenRows.add(rowKey);
        const date = parseDateCell(cells[dateCol] || '');
        if (!date) continue;
        byDate[date] = (byDate[date] || 0) + 1;
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

/* Parse a Lightspeed Restaurant O-Series sale-history export (columns:
   SaleID,SaleNo,SaleDate,SiteName,TerminalName,CustomerName,Operator,Notes,
   LinkedSaleID,Net Amount,Tax Amount,Tip,Total). One-off historical backfill
   for the months before OOLIO went live - see the pos adapter's parseExport.
   Rules (mirroring the OOLIO parser so counts are consistent across sources):
     - a row where Total is exactly 0 is a void/comp/staff item, not a sale -
       excluded (same treatment as OOLIO's "all zero" rows).
     - a row with a negative Total is a refund against an earlier sale (see
       LinkedSaleID) but is still its own completed transaction, so it counts -
       same call as OOLIO's "negative rows do count".
     - SaleDate is "YYYY-MM-DD HH:MM:SS"; only the date part is used. */
function parseLightspeedHistory(text) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/).filter((l) => l.trim().length);
  if (lines.length < 2) throw new Error('empty export');
  const parseCsvLine = (line) => {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const dateCol = header.indexOf('saledate');
  const totalCol = header.indexOf('total');
  if (dateCol === -1 || totalCol === -1) throw new Error('unrecognised Lightspeed export - missing SaleDate or Total');
  const byDate = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length <= dateCol || cells.length <= totalCol) continue;
    const total = parseFloat(cells[totalCol]);
    if (!isFinite(total) || total === 0) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(cells[dateCol] || '');
    if (!m) continue;
    const date = m[1] + '-' + m[2] + '-' + m[3];
    byDate[date] = (byDate[date] || 0) + 1;
  }
  return Object.entries(byDate).map(([date, count]) => ({ date, count }));
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

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
   console.log('[fetchWithTimeout] START ' + url + ' t=' + Date.now());
  /* 55s per call: a single P&L report for a FULL financial year (e.g. Last
     financial year) is a much bigger Xero-side computation than a week or
     a fresh month. 15s, then 28s, both still cut it off before Xero could
     finish for a busy year of trading - that's why only the short periods
     (this/last week, this month, this FY while it's brand new) were coming
     back with data. Cloudflare Workers only meter CPU time, never time spent
     waiting on a network response (confirmed: HTTP-triggered Workers have no
     wall-clock duration cap while the client stays connected), so a longer
     wait here costs nothing while idle - there's no platform reason to keep
     this tight. */
  const timer = setTimeout(() => ctrl.abort(), ms || 55000);
  try {
    const res = await fetch(url, { ...(init || {}), signal: ctrl.signal }); console.log('[fetchWithTimeout] END status=' + res.status + ' t=' + Date.now()); return res;
  } catch (e) {
    console.log('[fetchWithTimeout] CATCH ' + (e && e.message) + ' t=' + Date.now()); if (e && e.name === 'AbortError') { const te = new Error('upstream timed out'); te.status = 504; throw te; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getValidAccessToken(env, source) {
   console.log('[getValidAccessToken] ENTRY ' + source + ' t=' + Date.now());
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  console.log('[getValidAccessToken] ' + source + ' expiry-check expires_at=' + tokens.expires_at + ' now=' + Date.now()); if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  console.log('[getValidAccessToken] ' + source + ' REFRESH START t=' + Date.now()); const res = await fetchWithTimeout(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  console.log('[getValidAccessToken] ' + source + ' refresh response received t=' + Date.now()); if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
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
        return fetchWithTimeout(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
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
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0' } });
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
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You’ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
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
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
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
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
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
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
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

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn’t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn’t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it’s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn’t be read. Check it’s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[:_](\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2})[:_](\d{4}-\d{2})$/.exec(s);
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

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source in parallel; null where unavailable. */
  const sources = ['accounting', 'pos', 'rostering'];
  const results = await Promise.all(sources.map(async (source) => {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) return null;
    try {
      const h = makeHelpers(env, source);
      const val = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
      return val;
    } catch (err) {
      return null; /* per-source failure never breaks the whole payload */
    }
  }));
  const out = {};
  sources.forEach((source, i) => { out[source] = results[i]; });
  return out;
}

/* A promise that resolves to `fallback` after `ms` if `p` hasn't settled yet -
   a hard ceiling so one slow upstream call can never leave the dashboard
   spinning forever. The underlying work in `p` keeps running in the
   background (its own KV/cache writes still land when it finishes), but the
   HTTP response to the browser is never held hostage waiting for it. */
function withCeiling(p, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/* Periods (cur/prev/yoy) change with every period the owner picks, so they
   get a short cache - the owner expects near-live money numbers.
   Trend is a 24-month lookback that barely changes between two dashboard
   loads a few minutes apart, and is by far the most expensive thing this
   Worker asks Xero for (up to two 12-month Profit & Loss reports, which can
   genuinely take Xero a while to compute for a busy venue). It used to share
   a single cache entry keyed on the WHOLE query string, so every time the
   owner switched periods it silently re-ran that full 24-month recompute
   from scratch - the likely cause of multi-minute "stuck loading" on
   anything other than whichever period happened to be cached already.
   Caching it separately, keyed only on its own (fixed) range, means it is
   computed live once and then reused across every period the owner picks
   for the next half hour. */
const PERIODS_CACHE_TTL = 120;   /* seconds: brief cache for the picked period's numbers */
const TREND_CACHE_TTL = 1800;    /* seconds: trend barely moves load to load - reuse it */
/* Ceilings are PER SLOT, not shared across cur/prev/yoy - a slow "last financial
   year" prev-period report must never be able to null out an already-finished
   "cur" period just because they were awaited together. 60s comfortably covers
   one 55s Xero call plus a little overhead - a full financial year's P&L is
   the single biggest report this Worker ever asks Xero for, and 32s was still
   cutting it off before Xero could finish. The trend ceiling is longer again
   because it can be up to two sequential yearly report calls (up to 24 months,
   chunked 12 at a time) - but it only runs once every 30 minutes thanks to its
   own cache, so the extra wait is rarely felt. */
const REQUEST_CEILING_MS = 60000;
const TREND_CEILING_MS = 90000;

/* Hard OUTER ceiling wrapping the whole metrics lookup: no matter what hangs
   inside (a slow/broken Xero connections check, a stuck refresh-token
      exchange, anything at all upstream) the browser always gets a real,
         final response within this time - never an endless spinner. This is a
            safety net on top of the per-slot ceilings above, not a replacement for
               them. */
const OVERALL_CEILING_MS = 45000;
async function apiMetrics(env, url) {
     const outcome = await withCeiling(apiMetricsInner(env, url), OVERALL_CEILING_MS, 'TIMEOUT');
     if (outcome === 'TIMEOUT') {
            return json({
                     error: 'timeout',
                     plain: 'Still working on that - one of your connections is responding slowly right now. Try again in a moment.'
            }, 503);
     }
     return outcome;
}

async function apiMetricsInner(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
   const __t0 = Date.now(); console.log('[apiMetricsInner] START t=' + __t0);
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
   console.log('[apiMetricsInner] sourceStatus Promise.all START t=' + (Date.now() - __t0));
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
     ]);
   console.log('[apiMetricsInner] sourceStatus Promise.all END t=' + (Date.now() - __t0));

  const force = url.searchParams.get('refresh') === '1';

  /* ---- Periods (cur/prev/yoy): short-lived cache, keyed on just these ranges ---- */
  const periodsCacheKey = 'periodscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', tz, rollover
  ].join('|');
  let periods = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(periodsCacheKey);
    if (cached) { try { periods = JSON.parse(cached); } catch (e) { periods = null; } }
  }
  if (!periods) {
    /* Each slot gets its OWN ceiling (see the constant's comment above) - a
       slow prev-year report can no longer null out a cur-period that already
       came back fine, which is what was happening to Last financial year. */
    const [curOut, prevOut, yoyOut] = await Promise.all([
      withCeiling(fetchSlot(env, { ...base, ...cur }), REQUEST_CEILING_MS, null),
      prev ? withCeiling(fetchSlot(env, { ...base, ...prev }), REQUEST_CEILING_MS, null) : Promise.resolve(null),
      yoy ? withCeiling(fetchSlot(env, { ...base, ...yoy }), REQUEST_CEILING_MS, null) : Promise.resolve(null)
    ]);
    periods = { cur: curOut, prev: prevOut, yoy: yoyOut };
    if (env.TOKENS && curOut) {
      try { await env.TOKENS.put(periodsCacheKey, JSON.stringify(periods), { expirationTtl: PERIODS_CACHE_TTL }); } catch (e) {}
    }
  }

  /* ---- Trend: long-lived cache, keyed ONLY on the trend range (same for
     every period the owner picks) so switching periods reuses it instead of
     recomputing two 12-month Xero reports every time. ---- */
  let trendOut = null;
  if (trend) {
    const trendCacheKey = 'trendcache:' + [trend.fromMonth, trend.toMonth, tz, rollover].join('|');
    if (!force && env.TOKENS) {
      const cached = await env.TOKENS.get(trendCacheKey);
      if (cached) { try { trendOut = JSON.parse(cached); } catch (e) { trendOut = null; } }
    }
    if (!trendOut) {
      const months = monthList(trend.fromMonth, trend.toMonth);
      const trendSources = ['accounting', 'pos'];
      const live = Promise.all(trendSources.map(async (source) => {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) return null;
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          return alignSeries(months, series);
        } catch (err) { return null; }
      }));
      const trendResults = await withCeiling(live, TREND_CEILING_MS, trendSources.map(() => null));
      trendOut = { months };
      trendSources.forEach((source, i) => { trendOut[source] = trendResults[i]; });
      /* Only cache a trend that actually got real accounting data - an
         all-null result (e.g. the ceiling fired) should be retried on the
         very next load, not locked in for 30 minutes. */
      if (env.TOKENS && trendOut.accounting) {
        try { await env.TOKENS.put(trendCacheKey, JSON.stringify(trendOut), { expirationTtl: TREND_CACHE_TTL }); } catch (e) {}
      }
    }
  }

  return json({
    generatedAt: new Date().toISOString(),
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: periods,
    trend: trendOut
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

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
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
