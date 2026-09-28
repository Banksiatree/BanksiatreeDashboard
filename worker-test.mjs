// Exercises the real worker.js router directly in plain Node (no wrangler/
// workerd), with an in-memory KV mock standing in for env.TOKENS and a
// mocked global fetch standing in for Xero/Gmail's real APIs. Rebuilt from
// scratch after the original ~90-assertion suite was lost to scratchpad
// rotation - this pass focuses on locking in every real bug found and fixed
// during that live-debugging session, plus a baseline smoke pass over the
// pre-existing endpoints (Owner Input, Budget, What-If, POS aggregation).
//
// UPDATE: the Gmail/OOLIO PDF pipeline (fetchGmailOolioReport) IS now
// covered end-to-end (see the "oolio backlog" test below) - unpdf is a
// real installed dependency here, not mocked, so a small hand-built PDF
// (makeSimplePdf) round-trips through the actual getDocumentProxy/
// extractText call exactly like a real emailed report would. Only the
// mocked layer is Gmail's own HTTP API (messages.list/get, attachments.get)
// and the PDF content itself (synthetic numbers, not a captured real
// report) - the parsing/merge code underneath is exercised for real.
// worker.js still doesn't export internal functions, so this all runs
// through the real HTTP router (/api/gmail/check, worker.scheduled()),
// same as everything else in this file.
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

// Same idea as xeroKv, for Gmail's own OAuth token.
function gmailKv(extra) {
  return makeKV({
    'tokens:gmail': JSON.stringify({ access_token: 'fake-gmail-token', expires_at: Date.now() + 3600000 }),
    ...(extra || {})
  });
}

function ddmmyyyy(iso) {
  const [y, m, d] = iso.split('-');
  return d + '/' + m + '/' + y;
}

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Hand-built minimal one-page PDF (uncompressed content stream, one row of
// Tj calls) - a real PDF unpdf's getDocumentProxy/extractText can actually
// decode, not a fake byte blob. Verified standalone that extractText round-
// trips these lines back out in order, one per '\n'.
function makeSimplePdf(lines) {
  const fontSize = 10, lineHeight = 12, top = 700;
  let content = 'BT /F1 ' + fontSize + ' Tf\n';
  lines.forEach((line, i) => {
    const y = top - i * lineHeight;
    const esc = String(line).replace(/([()\\])/g, '\\$1');
    content += '1 0 0 1 50 ' + y + ' Tm (' + esc + ') Tj\n';
  });
  content += 'ET';
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xrefStart = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF';
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

// Matches the real "Reporting Groups.pdf" layout parseOolioReportingGroupsPdf
// expects: a "From:"/"To:" header (Australian date order) and a header row
// containing both "Reporting Group" and "Quantity", then one data row per
// group with its 6 trailing money columns.
function oolioReportingGroupsPdf(fromIso, toIso, rows) {
  const lines = [
    'Reporting Groups',
    'From: ' + ddmmyyyy(fromIso) + ' 00:00',
    'To: ' + ddmmyyyy(toIso) + ' 23:59',
    'Reporting Group Quantity Gross Sales Discount Surcharges Net Sales Taxes Net Sales ex Tax'
  ];
  rows.forEach((r) => {
    lines.push(r.name + ' ' + r.qty + ' $' + r.gross.toFixed(2) + ' $' + r.discount.toFixed(2) + ' $' + r.surcharge.toFixed(2) + ' $' + r.net.toFixed(2) + ' $' + r.tax.toFixed(2) + ' $' + r.netExTax.toFixed(2));
  });
  lines.push('Created By: test');
  return makeSimplePdf(lines);
}

// Matches "Sales Summary.pdf": the literal "Sales Summary" header, then the
// first integer-followed-by-$amount pair anywhere after it is the count.
function oolioSalesSummaryPdf(count) {
  return makeSimplePdf(['Sales Summary', 'The Banksia Tree Cafe', count + ' $1000.00 $0.00 $0.00 $1000.00 $0.00 $1000.00']);
}

function gmailMessageFull(from, subject, attachments) {
  return {
    payload: {
      headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }],
      parts: attachments.map((a) => ({ filename: a.filename, body: { attachmentId: a.attachmentId } }))
    }
  };
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
    assert(Array.isArray(rec.opexLines) && rec.opexLines.length === 1 && rec.opexLines[0].label === 'Rent' && rec.opexLines[0].value === 3642.39,
      'opex breakdown: a live pull captures itemised opexLines (Rent), not just the total, got ' + JSON.stringify(rec.opexLines));

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
    // ProfitAndLoss is now fetched per-quarter (fetchXeroPLOverRange, cached
    // the same way as GST below) rather than one 12-month call, so each
    // individual call should span ~3 months, not ~12 - and there should be
    // exactly 4 of them (one per quarter), covering the full rolling year
    // between them.
    const plUrls = seenUrls.filter((u) => u.includes('ProfitAndLoss'));
    assert(plUrls.length === 4, 'cashsplit: ProfitAndLoss fetched once per quarter (4 calls), got ' + plUrls.length);
    const fromMatch = /fromDate=(\d{4}-\d{2}-\d{2})/.exec(plUrls[0] || '');
    const toMatch = /toDate=(\d{4}-\d{2}-\d{2})/.exec(plUrls[0] || '');
    if (fromMatch && toMatch) {
      const months = (new Date(toMatch[1]) - new Date(fromMatch[1])) / (1000 * 60 * 60 * 24 * 30);
      assert(months > 2 && months < 4, 'cashsplit: each ProfitAndLoss call spans ~1 quarter (~3 months), got ' + fromMatch[1] + ' to ' + toMatch[1]);
    } else {
      assert(false, 'cashsplit: could not find a ProfitAndLoss date range to check');
    }
  }

  // ================================================================
  // BUG #6b: widening GST to 4 quarters made Cash Split page through
  // ~4x more BankTransactions/Payments every single load, tripping
  // Xero's own rate limit live (confirmed: HTTP 429). A completed
  // quarter's G1/1A/1B never changes once the quarter is over, so each
  // quarter must be cached and a second load must not re-fetch any
  // quarter it already has.
  //
  // BUG #6c: the COGS/Cash rate section (ProfitAndLoss) widened to the
  // same 4-quarter window but never got the same caching - it was still
  // fetching fresh, uncached, on every load ("COGS/Cash rate: HTTP 429"
  // reported live even after the GST fix shipped). Same fix, same test
  // shape: cold load = 1 ProfitAndLoss call per quarter, warm load = 0.
  // ================================================================
  {
    const env = { TOKENS: xeroKv({ 'xero:tenantId': 'tenant-1' }), DASHBOARD_PASSCODE: PASSCODE };
    let gstCallCount = 0, plCallCount = 0;
    global.fetch = makeMockFetch([
      { match: 'BankTransactions', body: () => { gstCallCount++; return { BankTransactions: [] }; } },
      { match: 'Payments', body: () => { gstCallCount++; return { Payments: [] }; } },
      { match: 'Reports/ProfitAndLoss', body: () => { plCallCount++; return xeroPLReport({ boh: 100, foh: 100, retail: 0, revenue: 10000, wages: 500, opex: 1000, ownerWages: 500 }); } }
    ]);
    const cookie = await login(env);
    await authedFetch(env, cookie, '/api/cashsplit');
    const firstLoadCalls = gstCallCount;
    assert(firstLoadCalls === 16, 'cashsplit: first (cold-cache) load makes 4 Xero calls per quarter x 4 quarters = 16, got ' + firstLoadCalls);
    assert(plCallCount === 4, 'cashsplit: first (cold-cache) load makes 1 ProfitAndLoss call per quarter x 4 quarters = 4, got ' + plCallCount);

    gstCallCount = 0; plCallCount = 0;
    await authedFetch(env, cookie, '/api/cashsplit');
    assert(gstCallCount === 0, 'cashsplit: second load re-fetches nothing - every quarter already cached, got ' + gstCallCount + ' calls');
    assert(plCallCount === 0, 'cashsplit: second load re-fetches no ProfitAndLoss either - every quarter already cached, got ' + plCallCount + ' calls');
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
    // Real numbers from the owner's actual (annual) report, divided by 4:
    // apiCashSplit now fetches ProfitAndLoss per-quarter and sums the 4
    // calls (fetchXeroPLOverRange, cached the same way as GST), and this
    // mock returns the same body for every quarter regardless of its
    // date range - so each "quarter" here carries exactly a quarter's
    // share of the real annual figures, and the 4 identical quarters sum
    // back to the real annual totals asserted below.
    const quarterReport = {
      Reports: [{ Rows: [
        { RowType: 'Section', Title: 'Income', Rows: [
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Income' }, { Value: '309619.8525' }] }
        ]},
        { RowType: 'Section', Title: 'Less Cost of Sales', Rows: [
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Cost of Sales' }, { Value: '72488.69' }] }
        ]},
        { RowType: 'Section', Title: null, Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Gross Profit' }, { Value: '237131.1625' }] }
        ]},
        { RowType: 'Section', Title: 'Plus Other Income', Rows: [
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Other Income' }, { Value: '3326.18' }] }
        ]},
        { RowType: 'Section', Title: 'Less Operating Expenses', Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Distribution of profit' }, { Value: '25359.8975' }] },
          { RowType: 'Row', Cells: [{ Value: 'Our Wages' }, { Value: '35945.485' }] },
          { RowType: 'Row', Cells: [{ Value: 'Everything else' }, { Value: '179151.96' }] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total Operating Expenses' }, { Value: '240457.3425' }] }
        ]},
        { RowType: 'Section', Title: null, Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Net Profit' }, { Value: '0.00' }] }
        ]}
      ]}]
    };
    global.fetch = makeMockFetch([
      { match: 'BankTransactions', body: { BankTransactions: [] } },
      { match: 'Payments', body: { Payments: [] } },
      { match: 'Reports/ProfitAndLoss', body: quarterReport }
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
  // BUG #11: staff hours and notes must reach History immediately when
  // saved from Owner Input, not only the next time a Xero pull happens
  // to run for that week - owner reported hours "not saving", which was
  // really "saved, but never propagated" since the two only used to sync
  // at Run-the-Numbers time. Covers both a genuinely brand-new week (no
  // history:week: record at all yet) and an existing live week (must not
  // clobber its other fields).
  // ================================================================
  {
    const env = { TOKENS: makeKV(), DASHBOARD_PASSCODE: PASSCODE };
    const cookie = await login(env);
    await authedFetch(env, cookie, '/api/ownerinput/staffhours', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: '2026-09-07', staffHours: 231 }) });
    let rec = JSON.parse(env.TOKENS._store.get('history:week:2026-09-07'));
    assert(rec && rec.wages && rec.wages.hours === 231, 'staff hours reach a brand-new week\'s History record immediately, got ' + JSON.stringify(rec));

    await authedFetch(env, cookie, '/api/ownerinput/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: '2026-09-07', notes: 'quiet week' }) });
    rec = JSON.parse(env.TOKENS._store.get('history:week:2026-09-07'));
    assert(rec.notes === 'quiet week', 'notes reach History immediately too, got ' + rec.notes);
    assert(rec.wages && rec.wages.hours === 231, 'saving notes afterward does not clobber the hours saved moments earlier, got ' + JSON.stringify(rec.wages));
  }
  {
    // An existing live week with real wages/cogs already on it - staff
    // hours saved afterward must land without disturbing anything else.
    const env = {
      TOKENS: makeKV({
        'history:week:2026-08-31': JSON.stringify({ week: '2026-08-31', weekEnding: '2026-09-06', source: 'live', wages: { kitchen: 4000, foh: 3000, total: 7500 }, cogs: { food: 2000, bev: 800, retail: 0 } })
      }),
      DASHBOARD_PASSCODE: PASSCODE
    };
    const cookie = await login(env);
    await authedFetch(env, cookie, '/api/ownerinput/staffhours', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: '2026-08-31', staffHours: 245.5 }) });
    const rec = JSON.parse(env.TOKENS._store.get('history:week:2026-08-31'));
    assert(rec.wages.hours === 245.5, 'staff hours land on an already-live week, got ' + rec.wages.hours);
    assert(rec.wages.kitchen === 4000 && rec.wages.total === 7500, 'that week\'s existing wages figures are untouched, got ' + JSON.stringify(rec.wages));
    assert(rec.cogs.food === 2000, 'that week\'s existing cogs is untouched too, got ' + JSON.stringify(rec.cogs));
  }

  // ================================================================
  // BUG #11b: the one-time backfill must retroactively push EVERY
  // already-entered ownerinput:staffhours/notes key into History, not
  // just newly-saved ones - owner reported months of previously-entered
  // hours missing from History entirely (only one stray week per month
  // showing, wherever a Xero pull happened to run after hours were
  // typed in).
  // ================================================================
  {
    const env = {
      TOKENS: makeKV({
        'ownerinput:staffhours:2026-08-03': JSON.stringify({ staffHours: 240 }),
        'ownerinput:staffhours:2026-08-10': JSON.stringify({ staffHours: 255 }),
        'ownerinput:staffhours:2026-09-07': JSON.stringify({ staffHours: 231 }),
        'ownerinput:notes:2026-08-03': JSON.stringify({ notes: 'busy long weekend' }),
        // Already has real wages/cogs from a live Xero pull - backfill
        // must add hours without disturbing them.
        'history:week:2026-08-10': JSON.stringify({ week: '2026-08-10', weekEnding: '2026-08-16', source: 'live', wages: { kitchen: 4000, foh: 3000, total: 7000 } })
      }),
      DASHBOARD_PASSCODE: PASSCODE
    };
    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/ownerinput/backfill-history');
    const json = await res.json();
    assert(json.ok === true && json.hoursBackfilled === 3, 'backfill reports 3 weeks of hours pushed, got ' + JSON.stringify(json));
    assert(json.notesBackfilled === 1, 'backfill reports 1 week of notes pushed, got ' + json.notesBackfilled);

    const w1 = JSON.parse(env.TOKENS._store.get('history:week:2026-08-03'));
    assert(w1.wages.hours === 240 && w1.notes === 'busy long weekend', 'a week with no prior History record gets both fields backfilled, got ' + JSON.stringify(w1));

    const w2 = JSON.parse(env.TOKENS._store.get('history:week:2026-08-10'));
    assert(w2.wages.hours === 255 && w2.wages.total === 7000, 'a week already live gets hours added without losing its real wages total, got ' + JSON.stringify(w2.wages));

    const w3 = JSON.parse(env.TOKENS._store.get('history:week:2026-09-07'));
    assert(w3.wages.hours === 231, 'a September week gets backfilled too, got ' + JSON.stringify(w3.wages));
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

  // ================================================================
  // BUG #12: fetchGmailOolioReport used to only ever look at the single
  // newest labelled email and stop there - if even one week's check was
  // skipped, an older unprocessed week's report was ignored permanently,
  // even though it was sitting right there in Gmail under the same label
  // (confirmed live: real report emails existed the whole time, "Check
  // for OOLIO report now" just never looked at them). Now scans the
  // whole search window and merges every not-yet-processed week found,
  // oldest first. Runs the REAL PDF parse path (unpdf, not mocked) -
  // only Gmail's own HTTP API and the PDF content are faked.
  //
  // Also covers BUG #12b, found immediately after #12 shipped live: a
  // skip's own full detail used to only survive in debug:oolio-email:
  // latest if it happened to be the LAST candidate processed - a later
  // SUCCESS in the same run silently overwrote it, so the one email that
  // actually needed diagnosing was invisible while a fine one sat in its
  // place. Oldest-of-all "gm-x" here is deliberately unparsable and
  // gets processed FIRST (oldest-first order), with two real successes
  // processed after it in the same run.
  // ================================================================
  {
    const env = { TOKENS: gmailKv(), DASHBOARD_PASSCODE: PASSCODE };
    const badPdf = makeSimplePdf([
      'Reporting Groups',
      'Reporting Group Quantity Gross Sales Discount Surcharges Net Sales Taxes Net Sales ex Tax',
      'Food 10 $100.00 $0.00 $0.00 $100.00 $9.09 $90.91',
      'Created By: test'
    ]); // no From:/To: line at all -> oolioReportWeekFromText can't read a week
    const rgPdfA = oolioReportingGroupsPdf('2026-08-03', '2026-08-09', [
      { name: 'Food', qty: 500, gross: 10000, discount: 200, surcharge: 0, net: 9800, tax: 890, netExTax: 8910 },
      { name: 'Drink', qty: 300, gross: 4000, discount: 100, surcharge: 0, net: 3900, tax: 354, netExTax: 3546 }
    ]);
    const ssPdfA = oolioSalesSummaryPdf(612);
    const rgPdfB = oolioReportingGroupsPdf('2026-08-17', '2026-08-23', [
      { name: 'Food', qty: 707, gross: 16766.72, discount: 788.26, surcharge: 0.58, net: 15979.04, tax: 1453.02, netExTax: 14526.02 },
      { name: 'Drink', qty: 1151, gross: 8736.40, discount: 419.00, surcharge: 0, net: 8317.40, tax: 743.51, netExTax: 7573.89 }
    ]);
    const ssPdfB = oolioSalesSummaryPdf(684);

    let attachmentFetches = 0;
    global.fetch = makeMockFetch([
      // Newest-first, as Gmail returns it: gm-b (newest), gm-noise, gm-a, gm-x (oldest).
      { match: '/gmail/v1/users/me/messages?', body: { messages: [{ id: 'gm-b' }, { id: 'gm-noise' }, { id: 'gm-a' }, { id: 'gm-x' }] } },
      { match: '/messages/gm-b?format=full', body: gmailMessageFull('Oolio Reports <reports@oolio.com>', 'Sun 23/08/26: Weekly Sales summary', [{ filename: 'Reporting Groups.pdf', attachmentId: 'att-rg-b' }, { filename: 'Sales Summary.pdf', attachmentId: 'att-ss-b' }]) },
      { match: '/messages/gm-a?format=full', body: gmailMessageFull('Oolio Reports <reports@oolio.com>', 'Sun 09/08/26: Weekly Sales summary', [{ filename: 'Reporting Groups.pdf', attachmentId: 'att-rg-a' }, { filename: 'Sales Summary.pdf', attachmentId: 'att-ss-a' }]) },
      { match: '/messages/gm-noise?format=full', body: gmailMessageFull('Oolio Reports <reports@oolio.com>', 'Sun 23/08/26: Dashboard sales', [{ filename: 'Dashboard.pdf', attachmentId: 'att-dash' }]) },
      { match: '/messages/gm-x?format=full', body: gmailMessageFull('Oolio Reports <reports@oolio.com>', 'Weird one-off: Weekly Sales summary', [{ filename: 'Reporting Groups.pdf', attachmentId: 'att-rg-x' }]) },
      { match: '/attachments/att-rg-b', body: () => { attachmentFetches++; return { data: bytesToBase64Url(rgPdfB) }; } },
      { match: '/attachments/att-ss-b', body: () => { attachmentFetches++; return { data: bytesToBase64Url(ssPdfB) }; } },
      { match: '/attachments/att-rg-a', body: () => { attachmentFetches++; return { data: bytesToBase64Url(rgPdfA) }; } },
      { match: '/attachments/att-ss-a', body: () => { attachmentFetches++; return { data: bytesToBase64Url(ssPdfA) }; } },
      { match: '/attachments/att-rg-x', body: () => { attachmentFetches++; return { data: bytesToBase64Url(badPdf) }; } }
    ]);

    const cookie = await login(env);
    const res = await authedFetch(env, cookie, '/api/gmail/check', { method: 'POST' });
    const json = await res.json();
    assert(json.merged === true && json.weeks && json.weeks.length === 2, 'oolio backlog: one check catches up BOTH skipped weeks, not just the newest, got ' + JSON.stringify(json.weeks && json.weeks.map((w) => w.week)));
    assert(json.weeks[0] && json.weeks[0].week === '2026-08-03' && json.weeks[1] && json.weeks[1].week === '2026-08-17', 'oolio backlog: weeks land in chronological order, got ' + JSON.stringify((json.weeks || []).map((w) => w.week)));

    const recA = JSON.parse(env.TOKENS._store.get('history:week:2026-08-03'));
    const recB = JSON.parse(env.TOKENS._store.get('history:week:2026-08-17'));
    assert(recA.revenue.food === 8910 && recA.covers === 612, 'oolio backlog: older skipped week (Aug 3) actually merged with real parsed figures, got ' + JSON.stringify(recA.revenue) + ' covers=' + recA.covers);
    assert(recB.revenue.food === 14526.02 && recB.covers === 684, 'oolio backlog: newer week (Aug 17) also merged correctly, got ' + JSON.stringify(recB.revenue) + ' covers=' + recB.covers);

    assert(json.skipped && json.skipped.length === 1 && json.skipped[0].reason === 'could not read a Mon-Sun week from the report', 'oolio backlog: the unparsable one is reported as skipped with the right reason, got ' + JSON.stringify(json.skipped));
    assert(json.skipped[0].textSnippet && json.skipped[0].textSnippet.includes('Reporting Group'), 'oolio backlog: the skip includes its own raw text right in the response, got ' + JSON.stringify(json.skipped[0].textSnippet));

    const skippedRecords = JSON.parse(env.TOKENS._store.get('debug:oolio-email:skipped'));
    assert(skippedRecords.length === 1 && skippedRecords[0].parsedWeek === null, 'oolio backlog: the skip\'s FULL debug record survives even though two real successes were processed after it in the same run, got ' + JSON.stringify(skippedRecords));
    const latestRecord = JSON.parse(env.TOKENS._store.get('debug:oolio-email:latest'));
    assert(latestRecord.parsedWeek === '2026-08-17', 'oolio backlog: debug:oolio-email:latest still reflects the true last-processed (successful) candidate, got ' + latestRecord.parsedWeek);

    const callsAfterFirstCheck = attachmentFetches;
    await worker.scheduled({}, env, {});
    assert(attachmentFetches === callsAfterFirstCheck, 'oolio backlog: the next (unforced) poll does not re-download/re-merge already-processed weeks, got ' + (attachmentFetches - callsAfterFirstCheck) + ' extra attachment fetches');
  }

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
