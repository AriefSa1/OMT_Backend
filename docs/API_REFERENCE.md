# Referensi API — endpoint, field respons, dan cara mengubahnya

Setiap endpoint di bawah mengikuti rantai yang sama:
**route** (`src/routes/*.js`) → **controller** (`src/controllers/*.js`, memvalidasi input &
membentuk respons HTTP) → **service** (`src/services/*.js`, tempat field respons benar-benar
dihitung/diambil).

**Untuk mengubah nilai sebuah field di respons endpoint: field itu HAMPIR SELALU dihitung di
`service`, bukan di `controller`.** Controller kebanyakan hanya meneruskan objek yang
dikembalikan service. Tabel di bawah menunjuk persis file + fungsi tempat tiap field lahir.

Semua rute (kecuali `/api/auth/register`, `/api/auth/login`) memerlukan header
`Authorization: Bearer <token>` — ditegakkan oleh `src/middleware/authMiddleware.js`.

Lihat juga: `ARCHITECTURE.md` (alur permintaan & model data), `VALUES_AND_THRESHOLDS.md`
(konstanta bisnis yang dipakai berbagai endpoint di bawah), `AI_SERVICE.md` (khusus `/api/ai/*`).

---

## Auth — `src/routes/authRoutes.js`

### `POST /api/auth/register`
`authController.register` → menulis langsung ke `prisma.user` (tidak lewat service terpisah).
- Body: `{ name, email, password }`
- Respons: `{ success, token, user: { id, name, email, role, createdAt } }`
- **Ubah aturan validasi** (panjang password, format email) → langsung di `register()`,
  `src/controllers/authController.js`.
- **Ubah role default user baru** → `role: 'ANALYST'` di fungsi yang sama.
- **Ubah masa berlaku token** → `generateToken()` di file yang sama, `expiresIn: '24h'`.

### `POST /api/auth/login`
`authController.login` — sama, langsung ke `prisma.user`.
- Body: `{ email, password }` → Respons: `{ success, token, user: { id, name, email, role } }`

### `GET /api/auth/me`
`authController.getMe` → Respons: `{ success, user: { id, name, email, role, createdAt, updatedAt } }`
- **Ubah field yang dikembalikan** → objek `select` di `getMe()`.

---

## Settings — `src/routes/settingsRoutes.js` → `settingsController.js` → `configService.js`

Penyimpanan: tabel `SystemConfig` (key/value), dibaca lewat `configService.getAll()` yang
menggabungkan baris DB di atas `DEFAULTS` (env var sebagai fallback awal — lihat
`src/services/configService.js:3`).

### `GET /api/settings`
Respons: `{ success, settings: {...}, config: {...} }` (dua field sama, untuk kompatibilitas
kode lama). Isi `settings`:

| Field | Sumber |
|---|---|
| `storeName`, `cronInterval`, `warehouseLoginUrl`, `warehouseInventoryUrl`, `warehouseUsername`, `warehouseLoginFrom`, `shopeeAdsUrl`, `shopeeOrderSummaryUrl` | Nilai mentah dari `SystemConfig` |
| `warehouseLoginConfigured` | `Boolean(warehouseLoginUrl && warehouseInventoryUrl)` |
| `warehouseCredentialsConfigured` | `Boolean(warehouseUsername && warehousePassword)` |
| `cookieConfigured` | `Boolean(cookieString)` |
| `geminiApiKeyConfigured` | `Boolean(geminiApiKey)` |

**Catatan keamanan yang disengaja**: `warehousePassword`, `cookieString`, dan `geminiApiKey`
sendiri **tidak pernah** dikembalikan mentah — hanya versi `*Configured: true/false`. Jangan
tambahkan field mentahnya ke respons ini.

**Ubah field yang ditampilkan** → objek `settingsObj` di `settingsController.getSettings()`
(baris ~12) — ubah juga versi yang sama persis di `updateSettings()` (baris ~102), keduanya
harus identik.

### `POST /api/settings` (juga `PUT`)
Body boleh berisi subset dari semua field di atas plus `warehousePassword`, `geminiApiKey`
(alias `geminiKey`), `cookieString` (alias `rawCookie`), `warehouseUrl` (alias lama untuk
`warehouseInventoryUrl`). Field yang tidak dikirim (`undefined`) **tidak diubah** — bukan
dikosongkan (`configService.setMany` memfilter `undefined`).

Efek samping saat field tertentu dikirim (langsung aktif tanpa restart server):
- `geminiApiKey` → `aiService.setApiKey(...)`
- `cookieString` → `shopeeService.setCookie(...)`
- salah satu field gudang → `warehouseService.setWarehouseConfig(...)`
- `cronInterval` → `initCronJobs(...)` (jadwal ulang cron sync)

**Tambah field settings baru** → 3 tempat harus disentuh bersamaan:
1. `DEFAULTS` di `src/services/configService.js`
2. Destructuring + `settingsObj` (dua tempat) di `src/controllers/settingsController.js`
3. `EMPTY_FORM` + form input di `frontend/app/settings/page.jsx`

### `POST /api/settings/test-warehouse`
`settingsController.testWarehouseConnection` → `warehouseService.testConnection(...)`. Login
percobaan + satu panggilan inventori (`limit=10`), tidak menyimpan apa pun. Respons:
`{ success, message, team: { id, name }, user: { id, name, username }, totalWarehouseItems, previewItemsCount, resolvedInventoryUrl }` atau `{ success: false, error, message, stage }`.
- **Ubah pesan error per skenario** → blok `catch` di `warehouseService.testConnection()`,
  `src/services/warehouseService.js:1009`.

---

## Status & Sync

### `GET /api/status`
`statusController.getStatus` → menggabungkan `configService`, `shopeeService.getActiveSession()`,
`prisma.syncJobLog`, dan tiga snapshot (`snapshotService.getCatalogSnapshot/getAdsSnapshot/getWarehouseSnapshot`, masing-masing `limit: 1` — hanya untuk `meta`-nya).

```
{
  connections: {
    shopee:    { status: 'CONFIGURED'|'DISCONNECTED', storeName, lastSyncedAt },
    gemini:    { status: 'CONFIGURED'|'NOT_CONFIGURED' },
    warehouse: { status: 'CONFIGURED'|'BASELINE' },
  },
  snapshots: { shopee: meta, ads: meta, warehouse: meta },  // lihat "Objek meta" di ARCHITECTURE.md
  latestSync: SyncJobLog terakhir (semua jenis),
}
```
**Ubah syarat status "CONFIGURED"** → `src/controllers/statusController.js:getStatus`, baris
kondisi masing-masing koneksi.

### `GET /api/sync/logs`
`syncController.getSyncLogs` → `prisma.syncJobLog.findMany({ take: 50 })` mentah.
`{ success, logs: [{ id, jobType, status, message, timestamp }] }`.
**Ubah jumlah baris** → angka `50` di `syncController.js`.

### `POST /api/sync/run`
`syncController.runFullSync` → `syncService.syncAll({ origin: 'MANUAL' })`. Menjalankan
`syncShopee` → `syncAds` → `syncWarehouse` berurutan di bawah kunci eksklusif
(`syncLockService`, TTL 20 menit — lihat `VALUES_AND_THRESHOLDS.md`). Respons:
`{ success, status: 'SUCCESS'|'DEGRADED'|'FAILED', message, startedAt, results: [shopeeResult, adsResult, warehouseResult] }`.

---

## Shopee — `src/routes/shopeeRoutes.js` → `shopeeController.js`

### `POST /api/shopee/cookie`
Body: `{ rawCookie, storeName }`. Mem-parse cookie (`utils/cookieParser.js`), menolak jika
tak ada token CSRF (`CTOKEN`/`SPC_CDS`) atau identitas toko (`SPC_U`/`SPC_SI`), lalu
menyimpan sesi (`shopeeService.saveSession`) **dan langsung memicu `syncService.syncShopee`**.
Respons: `{ success, analysis: { isValid, missingTokens, storeId, hasCsrfToken }, session, sync, message }`.

### `GET /api/shopee/session`
`{ success, session: { storeName, storeId, isActive, cookieConfigured, csrfConfigured, lastSyncedAt, createdAt, updatedAt } }`
— cookie/token asli tidak pernah dikembalikan, hanya bendera `*Configured`.

### `GET /api/shopee/metrics` — katalog produk
`snapshotService.getCatalogSnapshot(req.query)`. Query: `page, limit(≤100), search, category, sort∈{updatedAt,name,price,stock,salesCount,views}, direction`.
```
{
  products: [{ ...kolom ShopeeProduct, metric: ProductMetricSnapshot terbaru | null,
               economics: { unitCost, unitAdCost, shippingCost, platformFeePercent } }],
  filters: { categories: [...], activeCategory },
  pagination: { page, limit, total, totalPages },
  meta,        // lihat "Objek meta" di ARCHITECTURE.md
  dataSource, dataAsOf, message,   // = meta.source / meta.dataAsOf / meta.message
}
```
**Ubah kolom yang di-sort/filter** → `allowedSort` set di
`snapshotService.getCatalogSnapshot()`, `src/services/snapshotService.js:156`.

### `GET /api/shopee/product/:id`
`snapshotService.getProductSnapshot(id)` → 404 jika produk tak ada di snapshot lokal.
```
{
  product: {
    ...kolom ShopeeProduct, metric, metricHistory (30 hari terakhir),
    economics: { unitCost, unitAdCost, shippingCost, platformFeePercent,
                 estimatedMargin, estimatedMarginPercent },
  },
  warehouseStock: jumlah availableStock lintas gudang aktif, atau null jika tak ada SKU cocok,
  meta,
}
```
**Aturan margin**: `estimatedMargin` hanya dihitung bila SEMUA empat input biaya terisi
(`economicsComplete` check) — mengisi satu field saja tidak membuat tiga lainnya dianggap
nol. Ubah rumus margin → `snapshotService.getProductSnapshot()`, `src/services/snapshotService.js:377-395`.

### `PUT /api/shopee/product/:id/economics`
Body: subset dari `{ unitCost, unitAdCost, shippingCost, platformFeePercent }` (angka atau
`null`). Menulis langsung ke `prisma.shopeeProduct.update`. Respons: `{ success, product }`.

### `GET /api/shopee/ads`
Dua jalur: **live** (default, `force_snapshot=false`) memanggil Shopee langsung lewat
`shopeeService.fetchShopeeAdsMetrics()`, menyimpan latar belakang ke DB bila
`period∈{real_time,today}`, lalu mengembalikan hasil live + 30 hari riwayat dari DB. Jika
live gagal atau `force_snapshot=true` → jatuh ke `snapshotService.getAdsSnapshot()`.
Query: `period, start_time, end_time, sort_by∈{name,state,dailyBudget,spend,sales,ctr,roas}, direction, force_snapshot`.
```
{
  totalSpend, totalSalesGenerated, roas, impressions, clicks, ctr, voucherSpend, voucherSales,
  amountAudit: { rawSpend, rawSales, rawVoucherSpend, rawVoucherSales, divisor },
  topCampaigns: [{ id, name, type, state, dailyBudget, spend, sales, roas, ctr, impressions, clicks, ... }],
  sort: { sortBy, direction },
  history: [{ date, spend, sales, roas, ctr, dataAsOf }],  // 30 hari
  period, meta, dataSource, dataAsOf,
}
```
**Nilai nominal Shopee dibagi `amountDivisor` (100000)** sebelum ditampilkan — jangan
menghapus pembagian ini tanpa mengecek `ADS_AMOUNT_DIVISOR` di `shopeeService.js:17`.
**Ubah field yang bisa disortir** → `sortFields` map, `shopeeController.getShopeeAds()`,
`src/controllers/shopeeController.js:142`.

### `GET /api/shopee/product-performance`
Live via `shopeeService.fetchProductPerformance()`; jatuh ke
`snapshotService.getProductPerformanceSnapshot()` bila live gagal/kosong. Query:
`period, start_time, end_time, keyword, category_type, category_id, page_size, page_num, order_type, order_by`.
`order_by` yang diterima Shopee ada di `SHOPEE_ORDER_BY` map, `shopeeService.js:18-28` —
nilai di luar map itu jatuh ke `confirmed_sales.desc`.
```
{
  products: [{ rank, itemId, name, sku, image, price, confirmedSales, confirmedOrders,
                confirmedUnits, confirmedBuyers, views, visitors, addToCartUnits,
                addToCartRate, conversionRate, bounceRate, currency: 'IDR' }],
  summary: { totalSales, totalOrders, totalUnits, totalViews, totalVisitors, totalBuyers, averageConversionRate },
  pagination: { page, pageSize, total, totalPages },
  period, startTime, endTime, message,
}
```

### `GET /api/shopee/traffic-sources`
Live-only, tanpa snapshot fallback (`shopeeService.fetchTrafficSources`). Query: `days` (≤30).
```
{
  success: (source === 'SHOPEE_API'),
  days, dataAsOf, totalSales,
  channels: [{ key, label, sales, ratio, changeRatio }],  // ratio TIDAK dijumlahkan jadi 1
  message,
}
```
**Ubah kanal yang ditampilkan** → array `definitions` di
`shopeeService.fetchTrafficSources()`, `src/services/shopeeService.js:675-681`. Setiap
entri butuh `overview[key]` ada di respons Shopee — kanal yang tidak dikirim Shopee otomatis
tersaring (`.filter`), tidak dipaksa muncul sebagai nol.

### `POST /api/shopee/sync`
`syncService.syncShopee({ origin: 'MANUAL' })` — lihat `ARCHITECTURE.md` § Sync.

### `GET /api/shopee/validate-cookie`
Bukan pengujian langsung ke Shopee — hanya membaca status kesegaran snapshot katalog
(`meta.status ∈ {Segar, Tertunda}` → `valid: true`). Untuk validasi sungguhan, jalankan Sync.

---

## Warehouse — `src/routes/warehouseRoutes.js` → `warehouseController.js`

### `GET /api/warehouse/inventory`
`snapshotService.getWarehouseSnapshot(req.query)`. Query: `page, limit(≤100), search, type∈{all,priority,research,general}, warehouseId, teamId, sort/sortBy, direction, includeReconciliationList`.

Baris digabung **per SKU** (SUM lintas gudang jika `warehouseId=all`), dihitung langsung di
SQL (`$queryRawUnsafe`) untuk performa — lihat `ARCHITECTURE.md` § Performa gudang.
```
{
  items: [{ ...kolom WarehouseItem teragregasi, warehouseId, warehouseName, stockValue,
             reconciliation: baris StockReconciliation terbaru | null }],
  totals: { skus, totalPhysicalUnits, totalAvailableUnits, totalValuation,
            discrepanciesCount: number | null },  // null jika reconciliationTrust.reliable === false
  reconciliationTrust: { reliable, mappedSkuCount, warehouseSkuCount, message },
  counts: { all, priority, research, general },
  filters: { warehouses: [{id,name,count}], teams: [{id,name,code,count}], activeType, activeWarehouseId, activeTeamId },
  reconciliation: [] | daftar penuh (hanya jika includeReconciliationList === true, strict boolean),
  pagination, meta, dataSource, message,
}
```
**PENTING**: `discrepanciesCount` bernilai `null`, bukan `0`, ketika `reconciliationTrust.reliable === false` — SKU gudang tidak match dengan katalog Shopee sama sekali saat ini
(lihat `AGENTS.md` § SKU mapping). Jangan ubah ini menjadi `0` — itu akan terbaca sebagai
"tidak ada masalah" padahal sebenarnya "tidak terhitung".
**Ubah field yang bisa disortir** → `sortAliases`/`sortExpressions` map,
`snapshotService.getWarehouseSnapshot()`, `src/services/snapshotService.js:529-558`.
**Ubah daftar gudang aktif** → `src/constants/warehouseConstants.js` (lihat
`VALUES_AND_THRESHOLDS.md`).

### `GET /api/warehouse/inventory/:sku`
`warehouseService.getProductDetail(sku, { warehouseId, variantId })` → 404
(`{ success:false, error, message }`) jika SKU tak ada di snapshot lokal.
```
{
  product: WarehouseItem, shopeeProduct: ShopeeProduct | null,
  stats: { totalIn: number|null, totalOut, currentStock, valuation, movementCount },
  movements: [{ id, sku, type: 'IN'|'OUT', warehouseId, warehouseName, flowType, quantity,
                 status, counted, reference, source, note, timestamp, sentAt, arrivedAt, actor }],
  movementAvailability: { inbound, outbound, source: 'PDC_GUDANG'|'LOCAL_SNAPSHOT',
                            window?: { rows, totalItems, complete }, message },
  snapshots, reconciliations, warehouseSkuDetail, warehouseStockOptions, warehouseDetailSource,
}
```
`totalIn` adalah `null` (bukan `0`) ketika sumber live gudang tidak terjangkau — lihat
`warehouseService.getProductDetail()`, `src/services/warehouseService.js:1181`, dan
`fetchVariantStockFlow()`/`normalizeStockFlowRow()` untuk arah mutasi (constraint: tanda
angka BUKAN arah — `order` negatif, `transfer_out` justru positif; arah diambil dari `type`).

### `GET /api/warehouse/inventory/:sku/history`
`warehouseService.getProductStockHistory(sku, { limit, type })` — subset dari respons detail
di atas (`{ sku, totalIn, totalOut, count, movements, movementAvailability }`), untuk
komponen yang hanya butuh riwayat mutasi tanpa detail produk lengkap.

### `GET /api/warehouse/reconciliation`
`{ success, totalAudited, matchedCount, discrepanciesCount, reconciliationList: [...] , meta, dataSource, message }`
— daftar penuh (bukan hanya ringkasan `totals`). `reconciliationList[i]`: lihat
`warehouseService.calculateReconciliation()`, `src/services/warehouseService.js:1673-1699`
(`sku, name, price, warehouseStock, shopeeStock, variance, status∈{MATCHED,DISCREPANCY,CRITICAL}, recommendedAction`).
**Ambang `CRITICAL`** → `Math.abs(variance) > 5`, `warehouseService.js:1671`.

### `GET /api/warehouse/team-overview`
Live-only (`warehouseService.getTeamInventoryOverview()`), **cakupan satu tim**, bukan
seluruh gudang. Lihat `API_REFERENCE.md` di atas untuk `/inventory` yang mencakup semua tim.
```
{
  success: (source === 'WAREHOUSE_API'),
  dataAsOf, message,
  data: {
    team: { id, name, code },
    products: { productCount, skuCount, bundleCount },
    ready: { stock, skuCount, assetsTotal } | null,
    ongoing: [{ type, stock, skuCount, assetsTotal }],  // hanya kategori yang benar-benar dilaporkan API
    invoice: { count, total } | null,
    invoiceFromOtherTeam: { count, total } | null,
    orderCount: number | null,
  },
}
```

### `POST /api/warehouse/sync`
`syncService.syncWarehouse({ origin: 'MANUAL' })` — lihat `ARCHITECTURE.md` § Sync.

---

## Dashboard, Actions, Optimization, Growth

### `GET /api/dashboard/overview`
`analyticsController` bukan ada — ini `dashboardController.getOverview` →
`analyticsService.getDashboardOverview()` (delegator tipis) →
`snapshotService.getDashboardOverview()`. **Ini endpoint terbesar** — lihat
`src/services/snapshotService.js:904-1015` untuk implementasi penuh. Field kunci:

| Field | Sumber / catatan |
|---|---|
| `storeName`, `lastSyncedAt` | `StoreSession` + `SyncJobLog` terbaru |
| `dataState.{catalog,ads,warehouse}` | Objek `meta` masing-masing snapshot |
| `kpis.totalGmv/totalOrders/conversionRate/averageOrderValue` | Baris `ShopeeOrderSummary` terbaru; `null` jika belum ada baris — bukan `0` |
| `kpis.roas`, `kpis.adSpend` | Dari `getAdsSnapshot()` |
| `kpis.warehouseUnits`, `kpis.discrepanciesAlerts` | `null` kecuali status snapshot gudang `Segar`/`Tertunda` |
| `reconciliationTrust` | Sama seperti `/warehouse/inventory` |
| `history.orderAvailable`, `history.message` | Apakah ada baris `ShopeeOrderSummary` sama sekali |
| `salesTrend` | 30 hari `{ day, gmv, orders, adSpend }`; `adSpend` bisa `null` (hari tanpa snapshot iklan) — jangan diubah jadi `0`, itu akan tergambar seolah biaya iklan nol |
| `orderQuality` | Pembatalan/retur absolut, lihat baris 939-954. **Tidak ada rate pembatalan** — Shopee tidak memberi penyebutnya |
| `categorySales`, `categorySalesMeta` | Pangsa kategori dihitung HANYA dari halaman produk terlaris (`limit:8`), bukan seluruh katalog — `categorySalesMeta.message` menyatakan cakupan ini |
| `topProducts` | = `catalog.products` (8 teratas berdasar `salesCount`) |

**Perilaku sampingan**: fungsi ini juga memicu pembaruan latar belakang (fetch iklan +
ringkasan pesanan real-time dari Shopee) setiap kali dipanggil, jika ada sesi aktif — lihat
baris 909-924. Ini WIP milik pemilik repo per 2026-08-05, bukan bagian dari dokumentasi
service snapshot murni.

### `GET /api/tasks`
`taskController.listTasks` → `taskService.list(req.query)` (query: `status, search, limit≤200`)
digabung dengan `snapshotService.getActionSnapshot()` untuk daftar rekomendasi.
`{ success, tasks: [...], recommendations, recommendationTotal, sources }`.

### `POST /api/tasks`
Body: `{ recommendationId, type, title, description, source, entityType, entityId, priority }`.
Menolak duplikat (rekomendasi yang sudah punya task aktif `PROPOSED/APPROVED/IN_PROGRESS`
dikembalikan sebagai `{ duplicate: true }`, bukan dibuat lagi). **Ubah daftar status task** →
`TASK_STATUS` array, `src/services/taskService.js:4`.

### `PATCH /api/tasks/:id`
Body: `{ status, note }`. Menolak status di luar `TASK_STATUS`.

### `GET /api/optimization/products` | `/store` | `/ads`
Ketiganya memfilter `snapshotService.getActionSnapshot().recommendations` berdasarkan
`source` (`KATALOG_SHOPEE`/`GUDANG`/`IKLAN_SHOPEE`), lalu menghitung skor kesehatan
(`healthScore()` — `100 - Σ(prioritas × bobot)`, bobot `HIGH=12, MEDIUM=6, LOW=3`, di
`src/services/optimizationService.js:4-7`). Lihat `VALUES_AND_THRESHOLDS.md` untuk cara
mengubah bobot ini.

### `GET /api/optimization/marketplace-intelligence`
Menggabungkan katalog + iklan; `productSignals` dibangun oleh
`shopeeInsightsService.buildProductSignals()` dari metrik produk tersimpan (CTR rendah,
cart-tanpa-order, bounce rate tinggi — ambang di `src/services/shopeeInsightsService.js:86-109`).

### `GET/POST /api/optimization/competitor-intelligence`
`GET`: status kesiapan (butuh `l2CategoryId`+`l3CategoryId` di snapshot produk). `POST`:
memanggil Shopee langsung (`shopeeInsightsService.getCompetitorProducts`) — eksplisit atas
permintaan pengguna, bukan otomatis.

### `POST /api/optimization/apply`
Membuat `OptimizationTask` dari sebuah rekomendasi (sama seperti `POST /api/tasks` tapi
menerima bentuk `recommendation` langsung). **Tidak pernah mengubah apa pun di Seller
Center** — hanya mencatat niat sebagai task.

### `GET /api/growth-intelligence/overview`
`growthIntelligenceService.getOverview()` — versi legacy dari halaman `/growth`, membaca
snapshot yang sama dengan `/api/tasks` dan `/api/optimization/*`. `demandForecast` dan
`bundleSuggestions` SENGAJA berupa `{ status: 'TIDAK_TERSEDIA', items: [], message }` —
tidak ada model yang menghitungnya; lihat `AGENTS.md` § AI feature / dead code untuk histori.

---

## AI — lihat `AI_SERVICE.md`

`/api/ai/*` didokumentasikan terpisah karena sifatnya berbeda (bergantung kuota Gemini
eksternal, punya retry/klasifikasi error sendiri). Ringkasan cepat: `npm run docs:ai`.
