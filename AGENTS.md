# Repository Guidelines

## Project Structure & Module Organization

This repository is a Node.js/Express backend for a Shopee marketplace and warehouse analytics service. The entry point is `server.js`, which loads configuration, registers API routes, initializes services, and starts cron jobs.

- `src/routes/`: Express routes grouped by feature, such as `authRoutes.js` and `syncRoutes.js`.
- `src/controllers/`: Request handlers for each route group.
- `src/services/`: Business logic, external API access, sync workflows, analytics, and AI integrations.
- `src/middleware/` and `src/utils/`: Shared auth, Prisma, cookie, and request helper utilities.
- `src/cron/`: Scheduled sync jobs.
- `prisma/schema.prisma`: SQLite-backed Prisma data model.
- `test_*.js` and `test-*.js`: Standalone verification scripts.

## Build, Test, and Development Commands

```bash
npm install
```

```bash
npm run dev
```

`npm start` runs the same command for production-style startup. The server defaults to `http://localhost:5000` unless `PORT` is set.

```bash
npm run prisma:generate
```

```bash
npm run prisma:migrate:deploy
```

`prisma:db:push` no longer exists and must not be reintroduced — see constraint 5 below.

```bash
npm run test:ai
```

Mocked regression suite for the AI feature (retry/quota classification, response
envelope). Makes zero live Gemini calls — safe to run any time. `npm run docs:ai` prints
a terminal-readable explainer of the AI feature; the full reference is
`docs/AI_SERVICE.md`.

## Coding Style & Naming Conventions

Use CommonJS modules (`require`, `module.exports`) and two-space indentation. Keep filenames feature-based: routes end in `Routes.js`, controllers in `Controller.js`, and services in `Service.js`. Use `camelCase` for variables and functions, `PascalCase` for classes or constructors, and uppercase names for static constants.

Prefer thin controllers that validate inputs and delegate business logic to `src/services/`. Keep database access through the existing Prisma helper instead of creating new clients.

## Testing Guidelines

There is no centralized npm test script yet. Run verification scripts directly with Node, for example:

```bash
node test_auth_m2.js
node test_e2e_verification.js
node test-ai-suite.js
```

Name new test scripts with the existing `test_*.js` or `test-*.js` pattern. Keep tests self-contained, use isolated ports for Express servers, and clean up Prisma records.

## Commit & Pull Request Guidelines

The current history uses short, plain-English commit messages such as `fix feature` and `Initial commit`. Continue with concise imperative messages, such as `add sync status endpoint`.

Pull requests should include a short summary, affected API areas, database or Prisma changes, and verification commands run. Include response examples when changing API output consumed by the frontend.

## Security & Configuration Tips

Keep secrets out of Git. `.env` and SQLite database files are ignored; use variables such as `DATABASE_URL`, `PORT`, and `JWT_SECRET` locally. Do not commit Shopee cookies, warehouse credentials, Gemini API keys, or database backups. When changing auth or sync behavior, verify both protected and unauthenticated routes.

---

# Hard Constraints — Data Validity

Everything above describes *how* to write code here. This section describes what the code
is **not allowed to produce**. These are rules, not suggestions: each traces to a defect
found in the audit that produced the current state of this repo.

The project's absolute requirement is that **no fabricated data reaches the web UI**.

### 1. Never render an unmeasured figure as `0`

A value with no source must be `null`, and the UI must show an explicit status with a
reason. `0` reads as "no problems" — that is a lie to the user.

Follow the pattern already in `src/services/snapshotService.js`:

```js
discrepanciesCount: reconciliationTrust.reliable
  ? number(reconciliationStats?.discrepanciesCount)
  : null,
```

### 2. Never present a constant as analysis

No hardcoded value may be surfaced as if it were computed or AI-generated. If the source
does not exist yet, say "not available" — do not fill the gap with a guess.

### 3. No performance claim without before/after measurement

Measure against the real database: `prisma/dev.db.before-audit-20260804.bak` (68 MB,
26,212 warehouse items, 148,533 reconciliation rows). Copy it first — never benchmark
against a live database.

### 4. Optimisation must not change output

Capture the old output across several parameter combinations, rewrite, then diff field by
field. `getWarehouseSnapshot` was verified this way across 11 cases: default, paging,
search, per-warehouse, four sort orders, type filter, limit 100, team filter. Every field
must match before committing.

### 5. Never use `prisma db push` on a database holding data

Use `prisma migrate`. The full baselining procedure is in `prisma/migrations/README.md`.

Renaming a model without `@@map` under `db push` **drops the underlying table** — and
`StockReconciliation` holds ~148k audit rows. The `prisma:db:push` script was removed for
this reason; do not add it back.

### 6. Migrations must be additive

`DROP TABLE` may appear only inside a `RedefineTables` block, preceded by the
`INSERT … SELECT` that copies the rows. A `DROP TABLE` outside such a block loses data.
Read the generated SQL before applying it.

### 7. Run `npx prisma generate` after every schema change

The generator writes to the non-standard path `node_modules/.prisma/client-active`
(`prisma/schema.prisma:9`) and never refreshes itself. A stale client makes a new model
surface as `undefined` at runtime.

### 8. Never run a real Shopee sync without explicit user permission

A sync calls the Seller Center API on the user's shop. That is an outward-facing action —
ask first.

### 9. Supplementary writes must fail soft

If you add a write that is secondary to the main flow, wrap it so its failure cannot take
the parent down. Reference: `src/services/shopeeService.js:466` (order summary) and the
variation write inside `persistProducts`.

### 10. Do not add work outside the plan

If you find a new problem, record it and report it. Do not start on it.

---

# State & Remaining Work

## Already done — do not redo

Verify with `git log`.

**Correctness** — cross-product data leak from `OR: [{sku}, {}]`; sessions surviving
refresh; async rejections routed to error middleware; failed responses no longer cached;
fabricated AI content removed; unmeasured zeros replaced with `null` throughout.

**Schema & sync** — migrations baseline (`prisma/migrations/0_init` + README); Shopee
listing variations persisted (`ShopeeListingVariation`) with fail-soft writes; mapping
schema added (`ProductMapping`, `ProductMappingComponent`) — **deliberately not read by
anything yet**.

**Performance & reliability** — `getWarehouseSnapshot` paged in SQL (default page
4,188 ms → 365 ms, response 5.85 MB → 36 KB, output identical across 11 parameter
combinations); catalog filtering moved server-side so `pagination.total` reflects the
filter; the product-metrics `take` cap lifted; the stock-movement N+1 replaced with a
batched `createMany`; the full delete-and-reinsert of the warehouse table replaced with a
stale-id diff; `/optimization/*` reduced to a single shared snapshot; task ordering moved
to `src/utils/taskOrdering.js` so status sorts by priority rather than alphabetically.

**Removed rather than faked** — the store-health metrics (`chatResponseRate`,
`fulfillmentSpeed`, `storeRating`, `cancellationRate`) had no source and were dropped from
the contract instead of being filled with constants. That is the correct resolution.

**Marketplace intelligence wired** — `getMarketplaceInsights` no longer returns
`activeAdCampaigns: []` / `productSignals: []`. Campaigns come from the persisted ads
snapshot and signals from `shopeeInsightsService.buildProductSignals()`, fed by the
product metric snapshot through `snapshotService.normalizeRate` so the CTR threshold means
the same thing on both paths. `adsMonitor` reports the snapshot's own status instead of a
fixed sentence, and `productSignalsMeta` carries the reason when nothing was measured.

**Growth stubs state their absence** — `demandForecast` and `bundleSuggestions` are
`{ status: 'TIDAK_TERSEDIA', items: [], message }`. Bundling needs order item lines;
`ShopeeOrderSummary` stores daily totals only, so it is stated rather than approximated.

**Category share carries its coverage** — `getDashboardOverview` now emits
`categorySalesMeta`, because the share is computed over the top-selling page of the
catalog, not the whole catalog, and the UI has to be able to say so.

Verify all of the above with `node test_phase5_verification.js` (read-only, no sync).

## AI feature — fixed 2026-08-05

"Mayoritas fitur AI tidak bisa digunakan" traced to a real, measured cause, not a code
defect: the Gemini key in use is on the free tier's
`GenerateRequestsPerDayPerProjectPerModel-FreeTier` quota — **20 requests/day** for
`gemini-2.5-flash`. Live-testing all 5 `aiService.js` functions the same day this was
diagnosed produced 4 immediate 429s out of 5 calls.

Two things made it worse than the raw quota number:

1. **No retry.** A 429 is often transient — a second attempt seconds later would
   succeed — but the old code gave up on the first failure. `aiService.js` now retries
   up to twice, waiting the `retryDelay` Gemini itself returns (`classifyGeminiError` +
   `generateJson`), and only reports failure once retries are genuinely exhausted. A
   non-retryable failure (bad request, unparsable model output) still fails on the first
   attempt — see `docs/AI_SERVICE.md` for the full classification table.
2. **The daily briefing fired on every dashboard visit, uncached.** It runs
   automatically on mount — unlike the other four AI features, which wait for a click —
   so simply browsing the dashboard repeatedly could burn the day's quota before a user
   ever tried anything else. `frontend/lib/api.js` now caches it for 10 minutes;
   `frontend/components/DailyBriefingCard.jsx`'s refresh button bypasses the cache.

Also cleaned up while in this file: `aiController.js`'s five near-identical
try/catch/setApiKey handlers collapsed into one `aiEndpoint(...)` factory; five identical
try/catch tails inside `aiService.js` collapsed into `callGemini(...)`;
`test-ai-suite.js` (previously live-called all 5 features, spending real quota on every
"test" run) replaced with a mocked regression suite; `test_ai_gemini.js` (pointed at
routes that no longer exist) deleted.

No amount of code can restore a quota that is already spent for the day — the fixes
above stop the app from spending it needlessly and make a real exhaustion say so plainly
(`errorCode: 'RATE_LIMITED'`) instead of a generic "gagal". Full write-up:
`docs/AI_SERVICE.md`; `npm run docs:ai` for a terminal summary.

## Dead code removed (2026-08-05)

Each item below was verified to have zero references anywhere in the repo (`grep` across
routes, controllers, services, scripts, tests) before removal — do not re-add any of
these without the same check.

- `src/utils/prismaClient.js` — a second, independent `PrismaClient` built from the
  default `@prisma/client` output. The one actually in use
  (`src/utils/prisma.js`) is deliberately built from the non-standard
  `node_modules/.prisma/client-active` path (constraint 7 above). This one was not
  merely unused — it was a landmine: anything that imported it would connect to a
  client that never learns about a model added since the last default-path
  `prisma generate`, which nothing in this project runs.
- `src/utils/authMiddleware.js` — a one-line re-export shim
  (`module.exports = require('../middleware/authMiddleware')`). Every route already
  imports the real middleware in `src/middleware/` directly.
- `src/services/warehouseInsightsService.js` — 260 lines, no importer anywhere.

Also removed (untracked working-tree clutter, not source): stray `.patch` files,
`drift.sql`, and two SQLite backup snapshots left over from earlier migration work.

## Remaining, in order

Nothing is unblocked right now.

Recorded, not started: the warehouse account cannot read the endpoints listed as refused
above. If those permissions are granted, `/v1/invertories/transaction` would give a
store-wide inbound feed — the one thing the per-variant flow cannot provide cheaply.

Recorded, not started (constraint 10): `growthIntelligenceService.getOverview()` scores
the catalog with `Math.max(0, 100 - recommendations * 8)`, which floors at 0 once there
are 13 findings. A floored 0 is computed, not fabricated, but it stops discriminating.

## Endpoints — what answers, and what does not

Both blockers below were cleared by probing the endpoints the user documented in
`endpoint_shopee.json` and `warehouse_endpoint.json` with the credentials already stored.
Probe before assuming something is missing; probe again before assuming it is present.

**Wired (verified against the live store, 2026-08-05)**

| Source | Endpoint | Feeds |
|---|---|---|
| Shopee | `/api/mydata/v3/dashboard/key-metrics/` | `ShopeeOrderSummary` — one point per day, 30-day backfill |
| Shopee | `/api/mydata/dashboard/order-performance/` | cancellation & refund columns on the same model |
| Shopee | `/api/mydata/v1/dashboard/traffic-sources/` | live channel breakdown (`GET /api/shopee/traffic-sources`) |
| Gudang | `/v1/invertories/stock_flow` | per-variant movements, both directions |
| Gudang | `/v1/invertories/dashboard/overview` | team inventory KPIs (`GET /api/warehouse/team-overview`) |

Three traps in those APIs, each already paid for once:

- `stock_flow` needs **both** `product_id` and `variant_id`; `product_id` alone hangs past
  the timeout. It pages (one variant here holds 21,290 rows), and **the sign is not a
  direction** — `transfer_out` arrives positive exactly like `transfer_in`, so direction
  comes from the type.
- `key-metrics` omits the running day, which is why its rows are safe to store as final.
  Use the `confirmed_*` series: the rest of the app reports confirmed orders.
- The warehouse endpoints refuse without a `team_id`, and the login response does not
  carry one reliably — resolve it from `/v1/users/info`.

**Refused for this account** (`purna94`, team 63, role owner on domain 63): warehouse
`/v1/invertories/transaction`, `/v1/teams/performance`, `/v1/warehouses/insight/overview`
all return `permission kosong`. That is an access-rights matter, not a code one.

**Confirmed absent — do not synthesise**

- Store health: `accounthealth/.../overview` carries only `penalty_point`,
  `failed_metric_count`, `appeal_count`, `performance_rating`. Chat response rate,
  fulfilment speed and store rating are not there.
- A cancellation **rate**: Shopee publishes the absolute figures but not the denominator,
  so none is derived.
- Product categories: the catalog list returns no category field at all — 1 of 167
  products carries an id. The pie chart reads "Uncategorized" because that is the truth.
- `product-rankings` rejects every `order_by` tried; `v4/product/performance` already
  covers that ground.

## Blocked — do not force

1. **Lifetime stock-in per SKU** — `stock_flow` pages, and a busy variant runs to tens of
   thousands of rows, so the totals shown are for the fetched window and are labelled as
   such. Do not present them as lifetime figures without paging the whole history.

## SKU mapping — measured, 2026-08-05

The catalog sync was run with the user's explicit permission (167 listings, 665 variations,
50 product-metric snapshots) and `node src/scripts/checkSkuMappingFeasibility.js` answered
the open question. **It is the "Empty" branch, and more strongly than expected:**

```
Varian Shopee tersimpan   : 665      SKU gudang unik : 26,237
Varian yang punya SKU     : 0 dari 665
SKU induk cocok           : 0 dari 167
```

Not a format mismatch — there is no SKU to match. Every one of the 167 listings has an
empty `parent_sku` (all 167 rows fall back to the Shopee item id), and all 665 variations
have an empty `model.sku`. Two independent fields both empty means the listings carry no
SKU in Seller Center, not that the mapper reads the wrong key.

Consequences, for whoever builds this next:

- The automatic tier is dead. Do not write one, and do not rebuild name matching either —
  that was already measured at **zero** matches out of 26,212 items.
- The mapping UI has to be an efficient **set-builder**: 665 sellable units, each needing
  its warehouse components chosen by hand. Optimise for bulk selection and reuse of
  component groups across variations of the same listing.
- A Shopee listing is a **SET**; a warehouse item is a **COMPONENT**. The schema for this
  (`ProductMapping`, `ProductMappingComponent`) exists and is still read by nothing.

Re-run the script after any future sync — if the seller starts filling SKUs in Seller
Center, the automatic tier becomes worth revisiting.
