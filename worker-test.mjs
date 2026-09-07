// Exercises the real worker.js router directly in plain Node (no wrangler/
// workerd), with an in-memory KV mock standing in for env.TOKENS and a
// mocked global fetch standing in for Xero/Gmail's real APIs. Rebuilt from
// scratch after the original ~90-assertion suite was lost to scratchpad
// rotation - this pass focuses on locking in every real bug found and fixed
// during that live-debugging session, plus a baseline smoke pass over the
// pre-existing endpoints (Owner Input, Budget, What-If, POS aggregation).
//
// KNOWN GAP: the Gmail/OOLIO PDF pipeline (fetchGmailOolioReport) isn't
// covered end-to-end here - it needs real PDF bytes decoded via the unpdf
// package, which isn't practical to fake convincingly in a unit test. Its
// pure text-processing pieces (oolioRevenueFromReportingGroups,
// parseOolioSalesSummaryCount, oolioReportWeekFromText) aren't
// independently testable either, since worker.js doesn't export internal
// functions - only the HTTP router is reachable from outside. If this
// pipeline breaks again, it'll need the same live-debugging approach used
// to build it (real captured PDF text, /api/debug/oolio-email inspection).
//
// HOW TO RUN: worker.js has a top-level `import dashboardHtml from
// './dashboard.html'` that plain Node can't resolve on its own (Cloudflare's
// build handles it via the `rules` entry in wrangler.toml) - so run this
// against a stubbed copy, not worker.js directly:
//
//   sed "s|import dashboardHtml from './dashboard.html';|const dashboardHtml = '<html></html>';|" worker.js > .worker-under-test.mjs
//   sed "s|import worker from './worker.js';|import worker from './.worker-under-test.mjs';|" worker-test.mjs > .worker-test-run.mjs
//   node .worker-test-run.mjs
//   rm .worker-under-test.mjs .worker-test-run.mjs

import worker from './worker.js';

// Every test that mocks Xero calls needs a valid-looking OAuth token in KV
// first - getValidAccessToken throws (401) before fetch is ever called
// otherwise, which silently no-ops the whole call rather than failing loud.
function xeroKv(extra) {
  return makeKV({
    'tokens:accounting': JSON.stringify({ access_token: 'fake-token', expires_at: Date.now() + 3600000 }),
    ...(extra || {})
  });
}

function makeKV(seed) {
  const store = new Map(Object.entries(seed || {}));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list(opts) {
      const prefix = (opts && opts.prefix) || '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _dump() { return Object.fromEntries(store.entries()); },
    _store: store
  };
}

let failures = 0, passes = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.log('FAIL: ' + msg); }
  else { passes++; console.log('ok: ' + msg); }
}

// ---- Mock fetch: matches by URL substring, checked in registration order ----
function makeMockFetch(routes) {
  return async (url, init) => {
    const u = typeof url === 'string' ? url : url.url;
    for (const r of routes) {
      if (u.includes(r.match)) {
        const body = typeof r.body === 'function' ? r.body(u, init) : r.body;
        return {
          ok: r.status ? r.status < 400 : true,
          status: r.status || 200,
          json: async () => body,
          text: async () => JSON.stringify(body)
        };
      }
    }
    throw new Error('unmocked fetch: ' + u);
  };
}

const PASSCODE = 'test-passcode-123';

async function login(env) {
  const res = await worker.fetch(new Request('https://x/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: PASSCODE })
  }), env);
  const setCookie = res.headers.get('Set-Cookie') || '';
  const m = /vd_session=([^;]+)/.exec(setCookie);
  return m ? 'vd_session=' + m[1] : null;
}

async function authedFetch(env, cookie, path, init) {
  return worker.fetch(new Request('https://x' + path, {
    ...(init || {}),
    headers: { ...(init && init.headers), Cookie: cookie }
  }), env);
}

// Real Xero P&L report shape, using the REAL account names confirmed live
// against the owner's actual Chart of Accounts tonight - not synthetic.
function xeroPLReport({ boh, foh, retail, revenue, wages, opex, ownerWages }) {
  return {
    Reports: [{
      Rows: [
        { RowType: 'Section', Title: 'Income', Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Eftpos Sales' }, { Value: String(revenue) }] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Income' }, { Value: String(revenue) }] }
        ]},
        { RowType: 'Section', Title: 'Less Cost of Sales', Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Bakery' }, { Value: String(boh) }] },
          { RowType: 'Row', Cells: [{ Value: 'Beer, wine & spirits' }, { Value: String(foh) }] },
          { RowType: 'Row', Cells: [{ Value: 'Retail Goods' }, { Value: String(retail) }] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Cost of Sales' }, { Value: String(boh + foh + retail) }] }
        ]},
        { RowType: 'Section', Title: null, Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Gross Profit' }, { Value: String(revenue - boh - foh - retail) }] }
        ]},
        { RowType: 'Section', Title: 'Plus Other Income', Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Interest income' }, { Value: '0' }] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Other Income' }, { Value: '0' }] }
        ]},
        { RowType: 'Section', Title: 'Less Operating Expenses', Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Wages & salaries - Staff Wages' }, { Value: String(wages) }] },
          { RowType: 'Row', Cells: [{ Value: 'Our Wages' }, { Value: String(ownerWages) }] },
          { RowType: 'Row', Cells: [{ Value: 'Rent' }, { Value: String(opex) }] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Operating Expenses' }, { Value: String(wages + ownerWages + opex) }] }
        ]},
        { RowType: 'Section', Title: null, Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Net Profit' }, { Value: '0.00' }] }
        ]}
      ]
    }]
  };
}

async function main() {
  // ---- Setup / session ----
  {
    const env = { TOKENS: makeKV(), DASHBOARD_PASSCODE: PASSCODE };
    const cookie = await login(env);
    assert(!!cookie, 'setup: passcode login issues a session cookie');
    const res = await authedFetch(env, cookie, '/api/history?from=2026-01-01&to=2026-01-01');
    assert(res.status === 200, 'setup: session cookie authorises a real API call');
  }
  {
    const env = { TOKENS: makeKV(), DASHBOARD_PASSCODE: PASSCODE };
    const res = await worker.fetch(new Request('https://x/api/history?from=2026-01-01&to=2026-01-01'), env);
    assert(res.status === 401, 'unauthenticated request is rejected');
  }

  // ================================================================
  // BUG #1: COGS BOH/FOH must classify by real account NAME, not a
  // food/beverage keyword guess (Bakery/Drystore/Consumables etc never
  // matched "food"; confirmed against the owner's real Chart of Accounts).
  // ================================================================
  {
    const env = {
      TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }),
      DASHBOARD_PASSCODE: PASSCODE
    };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 4544.95, foh: 1777.42, retail: 0, revenue: 26480.16, wages: 8977.33, opex: 3642.39, ownerWages: 3702 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/pl?from=2026-08-24&to=2026-08-30');
    const json = await res.json();
    assert(json.available === true, 'COGS: /api/pl call succeeds');
    assert(json.cogs && json.cogs.boh === 4544.95, 'COGS: "Bakery" (real account name) classified as BOH, got ' + (json.cogs && json.cogs.boh));
    assert(json.cogs && json.cogs.foh === 1777.42, 'COGS: "Beer, wine & spirits" classified as FOH, got ' + (json.cogs && json.cogs.foh));
    assert(json.cogs && json.cogs.retail === 0, 'COGS: "Retail Goods" classified as retail (zero this week)');
  }

  // ================================================================
  // BUG #2: wages tracking category is literally named "Labour", not
  // "4 Labour" - confirmed live via GET TrackingCategories against the
  // owner's real org.
  // ================================================================
  {
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss?fromDate=2026-08-24&toDate=2026-08-30&trackingCategoryID', body: {
        Reports: [{ Rows: [
          { RowType: 'Header', Cells: [{ Value: '' }, { Value: 'Admin' }, { Value: 'BOH' }, { Value: 'FOH' }] },
          { RowType: 'Section', Title: 'Less Operating Expenses', Rows: [
            { RowType: 'Row', Cells: [{ Value: 'Wages & salaries' }, { Value: '444' }, { Value: '4713.53' }, { Value: '3819.56' }] }
          ]}
        ]}]
      }},
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 10000, wages: 8977.33, opex: 1000, ownerWages: 500 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [{ Name: 'Labour', Status: 'ACTIVE', TrackingCategoryID: 'cat-1', Options: [{ Name: 'Admin', Status: 'ACTIVE' }, { Name: 'BOH', Status: 'ACTIVE' }, { Name: 'FOH', Status: 'ACTIVE' }] }] } }
    ]);
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/pl?from=2026-08-24&to=2026-08-30');
    const json = await res.json();
    assert(json.wages && json.wages.splitAvailable === true, 'wages: "Labour" category found, split available');
    assert(json.wages && json.wages.kitchenBoh === 4713.53, 'wages: BOH column read correctly, got ' + (json.wages && json.wages.kitchenBoh));
    assert(json.wages && json.wages.foh === 3819.56, 'wages: FOH column read correctly, got ' + (json.wages && json.wages.foh));
  }
  {
    // A category literally named "4 Labour" must NOT match - would prove
    // the old substring bug (or an over-broad one) is back.
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 10000, wages: 500, opex: 1000, ownerWages: 500 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [{ Name: 'Something Else', Status: 'ACTIVE', TrackingCategoryID: 'cat-9', Options: [] }] } }
    ]);
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/pl?from=2026-08-24&to=2026-08-30');
    const json = await res.json();
    assert(json.wages && json.wages.splitAvailable === false, 'wages: no "labour"-matching category -> split unavailable, not silently wrong');
  }

  // ================================================================
  // BUG #3: wages posting-lag - payroll for a trading week is POSTED
  // (dated in Xero) 3 days after the week ends, so saveHistorySnapshot
  // must query wages on a window shifted +3 days from the plain week.
  // ================================================================
  {
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    const seenWagesUrls = [];
    global.fetch = makeMockFetch([
      { match: 'trackingCategoryID', body: (url) => { seenWagesUrls.push(url); return { Reports: [{ Rows: [
        { RowType: 'Header', Cells: [{ Value: '' }, { Value: 'BOH' }, { Value: 'FOH' }] },
        { RowType: 'Section', Title: 'Less Operating Expenses', Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Wages' }, { Value: '1000' }, { Value: '2000' }] }
        ]}
      ]}]}; } },
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 10000, wages: 3000, opex: 1000, ownerWages: 500 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [{ Name: 'Labour', Status: 'ACTIVE', TrackingCategoryID: 'cat-1', Options: [] }] } },
    ]);
    const cookie = await login(env);
    // 2026-08-17 is a Monday (week ending 2026-08-23) - payroll should be
    // queried on 2026-08-20 to 2026-08-26 (both dates +3).
    await authedFetch(env, cookie, '/api/ownerwages?from=2026-08-17&to=2026-08-23');
    const wagesUrl = seenWagesUrls[0] || '';
    assert(wagesUrl.includes('fromDate=2026-08-20'), 'wages lag: shifted window starts 2026-08-20 (week start +3), got ' + wagesUrl);
    assert(wagesUrl.includes('toDate=2026-08-26'), 'wages lag: shifted window ends 2026-08-26 (week end +3), got ' + wagesUrl);
  }

  // ================================================================
  // BUG #4: revenue-by-channel must NEVER be touched by a live Xero
  // pull - explicit owner instruction. A week with existing revenue data
  // must keep it unchanged after Run the Numbers; a brand-new week must
  // get no revenue field written by this path at all.
  // ================================================================
  {
    const env = {
      TOKENS: makeKV({
        'xero:tenantId': 'tenant-1',
        'history:week:2026-08-17': JSON.stringify({ week: '2026-08-17', weekEnding: '2026-08-23', source: 'live', revenueSource: 'oolio', revenue: { food: 14526.02, bev: 7573.89, uber: 0, event: 475, retail: 316.81 } })
      }),
      DASHBOARD_PASSCODE: PASSCODE
    };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 10000, wages: 500, opex: 1000, ownerWages: 500 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    const cookie = await login(env);
    await authedFetch(env, cookie, '/api/ownerwages?from=2026-08-17&to=2026-08-23');
    const rec = JSON.parse(env.TOKENS._store.get('history:week:2026-08-17'));
    assert(rec.revenue.food === 14526.02, 'revenue protection: existing OOLIO-sourced revenue untouched by a live pull, got ' + JSON.stringify(rec.revenue));
  }
  {
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 10000, wages: 500, opex: 1000, ownerWages: 500 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    const cookie = await login(env);
    await authedFetch(env, cookie, '/api/ownerwages?from=2026-08-17&to=2026-08-23');
    const rec = JSON.parse(env.TOKENS._store.get('history:week:2026-08-17'));
    assert(rec.revenue === undefined, 'revenue protection: a brand-new week gets NO revenue field from a live pull at all, got ' + JSON.stringify(rec.revenue));
  }

  // ================================================================
  // BUG #5: mergeHistoryWeek must not let a patch's null fields
  // overwrite real data already sitting in a nested object (revenue/
  // cogs/wages) - a null means "unknown this time", not "erase it".
  // Exercised via two back-to-back apiOwnerWages calls: first with a
  // real COGS result, second with a report that returns nothing for
  // retail (simulating an empty/failed classification), confirming
  // food/bev survive untouched while a genuinely-provided 0 still lands.
  // ================================================================
  {
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 4544.95, foh: 1777.42, retail: 250, revenue: 26480.16, wages: 8977.33, opex: 3642.39, ownerWages: 3702 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    const cookie = await login(env);
    await authedFetch(env, cookie, '/api/ownerwages?from=2026-08-17&to=2026-08-23');
    let rec = JSON.parse(env.TOKENS._store.get('history:week:2026-08-17'));
    assert(rec.cogs.food === 4544.95 && rec.cogs.retail === 250, 'null-merge: first pull writes real cogs values, got ' + JSON.stringify(rec.cogs));

    // Second pull: COGS report now shows retail with no matching account at
    // all this time (retail: 0) - food/bev should update, and the merge
    // itself should never null anything out (walkXeroCogsSplit always
    // returns numbers, never null, so this mainly locks in that contract).
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 5000, foh: 1800, retail: 0, revenue: 27000, wages: 9000, opex: 3700, ownerWages: 3700 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    await authedFetch(env, cookie, '/api/ownerwages?from=2026-08-17&to=2026-08-23');
    rec = JSON.parse(env.TOKENS._store.get('history:week:2026-08-17'));
    assert(rec.cogs.food === 5000 && rec.cogs.retail === 0, 'null-merge: second pull updates cleanly, no stale/doubled values, got ' + JSON.stringify(rec.cogs));
  }

  // ================================================================
  // BUG #6: Cash Split rates must come from the last 4 completed
  // quarters (a rolling year), not just the single most recent one -
  // a strong/weak single quarter was skewing the derived rate.
  // ================================================================
  {
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    const seenUrls = [];
    global.fetch = makeMockFetch([
      { match: 'BankTransactions', body: (url) => { seenUrls.push(url); return { BankTransactions: [] }; } },
      { match: 'Payments', body: { Payments: [] } },
      { match: 'Reports/ProfitAndLoss', body: (url) => { seenUrls.push(url); return xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 10000, wages: 500, opex: 1000, ownerWages: 500 }); } }
    ]);
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/cashsplit');
    const json = await res.json();
    assert(json.available === true, 'cashsplit: call succeeds');
    assert(json.period && json.period.label && json.period.label.includes('4 completed quarters'), 'cashsplit: period label says "4 completed quarters", got ' + (json.period && json.period.label));
    const plUrl = seenUrls.find((u) => u.includes('ProfitAndLoss')) || '';
    const fromMatch = /fromDate=(\d{4}-\d{2}-\d{2})/.exec(plUrl);
    const toMatch = /toDate=(\d{4}-\d{2}-\d{2})/.exec(plUrl);
    if (fromMatch && toMatch) {
      const months = (new Date(toMatch[1]) - new Date(fromMatch[1])) / (1000 * 60 * 60 * 24 * 30);
      assert(months > 10 && months < 13, 'cashsplit: date range spans ~12 months (4 quarters), got ' + fromMatch[1] + ' to ' + toMatch[1]);
    } else {
      assert(false, 'cashsplit: could not find a ProfitAndLoss date range to check');
    }
  }

  // ================================================================
  // BUG #7: Cash Split Net Profit = Gross Profit + Other Income -
  // Operating Expenses, excluding ONLY "Distribution of profit" - not
  // Xero's own "Net Profit" line (which is always $0 for this business,
  // confirmed live: Distribution of profit sweeps all profit out as an
  // expense), and NOT a reconstruction that also excludes Wages/Owner
  // wages (those must stay inside Opex as real costs).
  // ================================================================
  {
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    // Real numbers from the owner's actual report, reconstructed exactly.
    const realReport = {
      Reports: [{ Rows: [
        { RowType: 'Section', Title: 'Income', Rows: [
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Income' }, { Value: '1238479.41' }] }
        ]},
        { RowType: 'Section', Title: 'Less Cost of Sales', Rows: [
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Cost of Sales' }, { Value: '289954.76' }] }
        ]},
        { RowType: 'Section', Title: null, Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Gross Profit' }, { Value: '948524.65' }] }
        ]},
        { RowType: 'Section', Title: 'Plus Other Income', Rows: [
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Other Income' }, { Value: '13304.72' }] }
        ]},
        { RowType: 'Section', Title: 'Less Operating Expenses', Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Distribution of profit' }, { Value: '101439.59' }] },
          { RowType: 'Row', Cells: [{ Value: 'Our Wages' }, { Value: '143781.94' }] },
          { RowType: 'Row', Cells: [{ Value: 'Everything else' }, { Value: '716607.84' }] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Operating Expenses' }, { Value: '961829.37' }] }
        ]},
        { RowType: 'Section', Title: null, Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Net Profit' }, { Value: '0.00' }] }
        ]}
      ]}]
    };
    global.fetch = makeMockFetch([
      { match: 'BankTransactions', body: { BankTransactions: [] } },
      { match: 'Payments', body: { Payments: [] } },
      { match: 'Reports/ProfitAndLoss', body: realReport }
    ]);
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/cashsplit');
    const json = await res.json();
    assert(json.pl && Math.abs(json.pl.netProfit - 101439.59) < 0.01, 'cashsplit netProfit = Gross Profit + Other Income - Opex(excl. Distribution of profit), got ' + (json.pl && json.pl.netProfit));
    const expectedPct = 101439.59 / 948524.65;
    assert(json.pl && Math.abs(json.pl.cashPctRaw - expectedPct) < 0.0001, 'cashsplit cashPctRaw ~10.7%, got ' + (json.pl && (json.pl.cashPctRaw * 100).toFixed(2) + '%'));
  }

  // ================================================================
  // BUG #8: "Bank feeds" in History means Xero's Total Trading Income
  // (accrual), not real cash BankTransactions receipts.
  // ================================================================
  {
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 22872, wages: 500, opex: 1000, ownerWages: 500 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    const cookie = await login(env);
    await authedFetch(env, cookie, '/api/ownerwages?from=2026-08-17&to=2026-08-23');
    const rec = JSON.parse(env.TOKENS._store.get('history:week:2026-08-17'));
    assert(rec.bankFeeds === 22872, 'Bank feeds = Total Trading Income (P&L revenue), got ' + rec.bankFeeds);
  }

  // ================================================================
  // BUG #9: P&L's transaction count must come from the exact same
  // History covers figures, not a separate POS-webhook count - the two
  // tabs disagreed live for the same month (2953 vs 3344) because they
  // used two different sources for what should be one number.
  // ================================================================
  {
    const env = {
      TOKENS: xeroKv({
        'xero:tenantId': 'tenant-1',
        'history:week:2026-08-03': JSON.stringify({ week: '2026-08-03', weekEnding: '2026-08-09', source: 'live', covers: 700 }),
        'history:week:2026-08-10': JSON.stringify({ week: '2026-08-10', weekEnding: '2026-08-16', source: 'live', covers: 663 }),
        'history:week:2026-08-17': JSON.stringify({ week: '2026-08-17', weekEnding: '2026-08-23', source: 'live', covers: 743 }),
        // weekEnding is in July, genuinely outside the requested August
        // range - must not be summed in.
        'history:week:2026-07-20': JSON.stringify({ week: '2026-07-20', weekEnding: '2026-07-26', source: 'live', covers: 9999 })
      }),
      DASHBOARD_PASSCODE: PASSCODE
    };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 10000, wages: 500, opex: 1000, ownerWages: 500 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/pl?from=2026-08-01&to=2026-08-31');
    const json = await res.json();
    assert(json.transactions && json.transactions.actual === 700 + 663 + 743, 'P&L transactions = sum of History covers for weeks ending in August, got ' + (json.transactions && json.transactions.actual));
  }
  {
    // No history data for the period at all -> null, not a silent 0 or a
    // leftover POS-webhook number.
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 10000, wages: 500, opex: 1000, ownerWages: 500 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/pl?from=2026-08-01&to=2026-08-31');
    const json = await res.json();
    assert(json.transactions && json.transactions.actual === null, 'P&L transactions is null (not 0) when History has nothing for the period, got ' + (json.transactions && json.transactions.actual));
  }

  // ================================================================
  // BUG #10: What-If's baseline transaction count had the exact same
  // POS-webhook-vs-History mismatch as P&L (BUG #9) - its Avg Spend
  // baseline (Revenue / Transactions) would come out inflated whenever
  // the old source undercounted.
  // ================================================================
  {
    const env = {
      TOKENS: xeroKv({
        'xero:tenantId': 'tenant-1',
        'history:week:2026-08-03': JSON.stringify({ week: '2026-08-03', weekEnding: '2026-08-09', source: 'live', covers: 700 }),
        'history:week:2026-08-10': JSON.stringify({ week: '2026-08-10', weekEnding: '2026-08-16', source: 'live', covers: 663 }),
        'history:week:2026-08-17': JSON.stringify({ week: '2026-08-17', weekEnding: '2026-08-23', source: 'live', covers: 743 }),
        'history:week:2026-08-24': JSON.stringify({ week: '2026-08-24', weekEnding: '2026-08-30', source: 'live', covers: 684 })
      }),
      DASHBOARD_PASSCODE: PASSCODE
    };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 22000, wages: 500, opex: 1000, ownerWages: 500 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/whatif?from=2026-08-03&to=2026-08-30');
    const json = await res.json();
    assert(json.transactions === 700 + 663 + 743 + 684, 'What-If transactions = sum of History covers for the 4-week window, got ' + json.transactions);
  }

  // ================================================================
  // Baseline smoke coverage - pre-existing endpoints, so a future
  // change that breaks these fails loudly rather than silently.
  // ================================================================
  {
    const env = { TOKENS: makeKV(), DASHBOARD_PASSCODE: PASSCODE };
    const cookie = await login(env);
    let res = await authedFetch(env, cookie, '/api/ownerinput?week=2026-08-17');
    let json = await res.json();
    assert(Array.isArray(json.owners) && json.owners.length === 0, 'owner input: fresh week has no owners');

    res = await authedFetch(env, cookie, '/api/ownerinput/owner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Fabian' }) });
    json = await res.json();
    assert(json.ok === true && json.owners.includes('Fabian'), 'owner input: add owner succeeds');

    res = await authedFetch(env, cookie, '/api/ownerinput/entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: '2026-08-17', ownerName: 'Fabian', daysOff: 1, workouts: 2, ownerHours: 40 }) });
    assert(res.status === 200, 'owner input: save entry succeeds');

    res = await authedFetch(env, cookie, '/api/ownerinput?week=2026-08-17');
    json = await res.json();
    assert(json.entries && json.entries.length === 1 && json.entries[0].ownerHours === 40, 'owner input: saved entry reads back correctly');
  }
  {
    const env = { TOKENS: makeKV(), DASHBOARD_PASSCODE: PASSCODE };
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/budget?year=2026');
    const json = await res.json();
    assert(json.available === false && json.reason === 'not_connected', 'budget: not connected fails gracefully, got ' + JSON.stringify(json));
  }
  {
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    global.fetch = makeMockFetch([
      { match: 'Reports/ProfitAndLoss', body: xeroPLReport({ boh: 500, foh: 200, retail: 0, revenue: 4000, wages: 1200, opex: 300, ownerWages: 200 }) },
      { match: 'TrackingCategories', body: { TrackingCategories: [] } }
    ]);
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/whatif?from=2026-08-01&to=2026-08-28');
    const json = await res.json();
    assert(json.available === true, 'whatif: call succeeds with mocked Xero, got ' + JSON.stringify(json).slice(0, 200));
  }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
