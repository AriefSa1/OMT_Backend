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
Catatan penting: endpoint Seller Center ini tidak mengirim `summary` dan membatasi hasil
menjadi maksimal 50 item per halaman. `summary` di atas dihitung dari seluruh halaman
yang cocok dengan filter, sedangkan `products` hanya halaman yang diminta. `totalOrders`,
`totalBuyers`, `totalViews`, dan `totalVisitors` adalah agregat pada grain produk; jangan
menyamakan `totalOrders` dengan buyer/order unik toko pada Product Overview tanpa
rekonsiliasi definisi metrik. `totalSales` dan `totalUnits` dapat dibandingkan dengan
`confirmed_gmv` dan `confirmed_unit_num` pada Product Overview untuk periode native yang
sama.

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

## Hermes Agent lokal

Jalur Hermes dibuat terpisah dari `/api/ai/*` dan tidak mengubah provider Gemini/OpenRouter.
Endpoint ini membutuhkan autentikasi aplikasi yang sama dengan endpoint terlindungi lainnya.

### `GET /api/hermes/status`

Mengembalikan konfigurasi lokal Hermes tanpa melakukan probe ke service upstream. Field
`availability` selalu `NOT_CHECKED` sampai probe eksplisit ditambahkan; aplikasi tidak boleh
menampilkan status online berdasarkan konfigurasi saja.

### `GET /api/hermes/models`

Membaca daftar model dari upstream Hermes pada `GET /v1/models`. Response dinormalisasi
menjadi `{ id, object, ownedBy }` dan di-cache singkat di memory backend agar membuka
halaman tidak memanggil proxy berulang-ulang. Query `?refresh=true` memaksa discovery baru.
Frontend harus memakai daftar ini sebagai sumber pilihan model, bukan mengasumsikan
`hermes-agent` selalu merupakan model inference yang tersedia.

Pada probe lokal 13 Agustus 2026, upstream mengembalikan 363 model dan
`upstage/solar-pro4:free` tersedia. Nilai ini adalah default deployment saat ini, tetapi
daftar live tetap menjadi sumber kebenaran karena katalog Nous Portal dapat berubah.

### `POST /api/hermes/chat`

Meneruskan request ke Hermes OpenAI-compatible `POST /v1/chat/completions`.

Body minimal:

```json
{
  "messages": [
    { "role": "user", "content": "Halo Hermes" }
  ]
}
```

Field opsional yang diteruskan: `model`, `temperature`, `maxTokens`, `conversation`,
`previousResponseId`, dan `mode`. `mode` defaultnya `EXPLORATORY` dan response diberi
label `grounding: UNVERIFIED_EXPLORATORY`; mode ini tidak membawa data dashboard dan tidak
boleh dianggap sebagai analisa bisnis. `GROUNDED_ANALYSIS` menandai request yang harus
dikaitkan dengan konteks terukur;
jalur analisa bisnis yang benar tetap `POST /api/hermes/analyze` karena endpoint tersebut
memasang sumber kanonik, evidence ledger, rekonsiliasi, dan validator output. Streaming
sengaja belum diaktifkan pada tahap eksperimen awal.

Response sukses membungkus response asli Hermes di field `response`:

```json
{
  "success": true,
  "provider": "HERMES_AGENT",
  "mode": "EXPLORATORY",
  "grounding": "UNVERIFIED_EXPLORATORY",
  "model": "hermes-agent",
  "response": { "id": "...", "choices": [] }
}
```

Konfigurasi lokal berada di `.env`: `HERMES_AGENT_ENABLED`, `HERMES_AGENT_BASE_URL`,
`HERMES_AGENT_API_KEY`, `HERMES_AGENT_MODEL`, dan `HERMES_AGENT_TIMEOUT_MS`. Default URL
adalah `http://127.0.0.1:8642/v1` pada development. Pada production, jika
`HERMES_AGENT_BASE_URL` belum tersedia, backend menggunakan fallback
`https://hermes.ninetyfour.fun/v1`. API key tidak memiliki fallback dan tetap wajib diisi
sebagai secret pada environment backend. Status juga mengembalikan `baseUrlSource` dan
`missingConfiguration` agar UI dapat menjelaskan bagian konfigurasi yang belum lengkap.

### `POST /api/hermes/analyze/validate`

Memvalidasi apakah data aplikasi cukup aman untuk analisa terarah sebelum konteks dikirim
ke Hermes. Endpoint ini tidak memanggil Hermes. Intent yang didukung adalah `IKLAN`,
`PERFORMA_TOKO`, dan `PERFORMA_PRODUK` (juga menerima label pengguna `Iklan`, `Performa
Toko`, dan `Performa Produk`). Jika `startDate` dan `endDate` tidak dikirim, backend
menggunakan tepat 30 tanggal kalender terakhir: hari ini dan 29 hari sebelumnya menurut
zona waktu Asia/Jakarta.

Body opsional:

```json
{
  "intent": "PERFORMA_PRODUK",
  "storeId": "store-example",
  "startDate": "2026-07-14",
  "endDate": "2026-08-12"
}
```

Secara default endpoint memakai adapter live kanonik (`sourceMode: LIVE_CANONICAL` secara
internal), bukan snapshot database lama. Adapter yang dipakai adalah:

- `IKLAN` → response live Shopee Ads;
- `PERFORMA_TOKO` → `Product Overview` dengan field `confirmed_*`;
- `PERFORMA_PRODUK` → `Product Performance` seluruh halaman, direkonsiliasi terhadap
  `Product Overview confirmed` untuk GMV dan unit.

Untuk `PERFORMA_PRODUK`, KPI aggregate (`confirmedSales`, `confirmedOrders`,
`confirmedUnits`, views, visitors, buyers, dan average conversion rate) dihitung dari seluruh
halaman hasil Product Performance. Detail yang dikirim ke Hermes dibatasi pada maksimal 10
produk teratas berdasarkan `confirmedSales`; field response mentah seperti `raw` dan field
harga yang tidak menjadi metric evidence tidak ikut dikirim. Metric per produk teratas
dimasukkan ke evidence ledger dengan `entityId`/`entityName`, sehingga angka detail dapat
disitasi dan divalidasi. Context juga menyertakan `detailScope` agar Hermes tidak menganggap
subset produk sebagai seluruh katalog.

Snapshot lokal hanya dipakai oleh regression test dan diagnostik internal. Jika sumber live
tidak tersedia atau rekonsiliasi core mismatch, status menjadi `BLOCKED` dan tidak ada
request yang diteruskan ke Hermes.

Hasil validasi memiliki `quality.status` berikut:

- `SAFE`: sumber utama memenuhi coverage dan freshness minimum; konteks boleh dianalisa
  penuh sesuai klaim yang diizinkan.
- `LIMITED`: konteks hanya boleh dipakai untuk diagnosis kualitas data. Hermes tidak
  dipanggil karena coverage, freshness, ukuran sampel, atau rekonsiliasi belum aman.
- `BLOCKED`: sumber utama tidak tersedia, toko tidak terikat pada akun, atau data tidak
  memiliki baris valid. Request analisa tidak boleh diteruskan ke Hermes.

Ambang default yang dikembalikan pada `quality.thresholds` adalah coverage minimum 50%,
coverage aman 80%, freshness maksimum 48 jam untuk iklan/toko dan 72 jam untuk produk,
minimal 2 baris campaign untuk konteks kampanye, serta minimal 5 produk terukur untuk
perbandingan portfolio. Nilai yang tidak memiliki sumber atau denominator tetap `null`,
bukan `0`. `dataGaps` dan `blockedClaims` harus dibawa ke prompt agar Hermes tidak
menyimpulkan profit, cancellation rate, rating toko, stok gudang, kategori, atau forecast
yang belum didukung data.

### `POST /api/hermes/analyze`

Menjalankan validasi yang sama secara server-side, membangun `TRUSTED_CONTEXT` yang
dibatasi pada toko milik user (atau toko target yang diizinkan untuk `ADMIN`), lalu
mengirim konteks terstruktur ke Hermes. Endpoint ini menolak dengan `422 DATA_BLOCKED`
ketika status kualitas `BLOCKED`, sehingga data tidak pernah dikirim ke agent dalam kondisi
tersebut. Status `LIMITED` juga tidak diteruskan ke Hermes; hanya status `SAFE` yang boleh
memanggil agent. Body intent dan rentang tanggal sama dengan endpoint validasi.

Response sukses mengembalikan `quality`, `period`, `effectivePeriod`, `evidence`,
`validationWarnings`, dan `analysis` JSON. Output wajib memakai `schemaVersion: "1.0"`:

- setiap finding menunjuk `evidenceIds`;
- setiap hipotesis menunjuk `supportingEvidenceIds` dan `howToTest`;
- setiap tindakan menunjuk evidence serta `expectedMeasurement`;
- nilai numerik terstruktur harus ada pada evidence ledger atau trusted metrics.

Output JSON yang tidak memenuhi kontrak evidence ditolak sebagai `INVALID_RESPONSE`. Angka
aritmetika seperti ROAS, CTR, AOV, dan conversion rate dihitung di backend dari field sumber;
Hermes hanya menafsirkan angka trusted tersebut.

Metadata learning loop pada tindakan (`metricKey`, `windowDays`, `baseline`, dan `target`)
bersifat opsional. Jika Hermes mengirim metric key yang tidak ada di katalog intent atau unit
yang tidak sesuai, metadata tracking itu dibuang dan dicatat sebagai `validationWarnings`;
tindakan tetap dikembalikan sebagai tindakan kualitatif tanpa outcome tracking. Dengan begitu,
kesalahan pada metadata rekomendasi tidak menggagalkan seluruh analisa yang evidence utamanya
valid. Angka yang tidak ditemukan pada evidence/trusted metrics tetap dikosongkan menjadi
`null` dan tidak boleh ditampilkan sebagai angka terukur.

Untuk mendiagnosis kegagalan, response error analisis menyertakan `requestId`,
`validationErrors`, `validationWarnings`, dan object `diagnostic`. Backend juga menulis satu
baris JSON berlabel `[Hermes][Diagnostic]` ke terminal, berisi tahap kegagalan, intent, periode,
dan alasan validator tanpa mencetak credential atau payload mentah. Jika perlu memeriksa
respons mentah model secara lokal, set `HERMES_DEBUG=true`; output tersebut dipotong maksimal
4.000 karakter dan hanya boleh dipakai pada environment development.

Payload `TRUSTED_CONTEXT` yang dikirim ke agent melewati sanitizer recursive: key credential,
cookie, token, secret, password, dan authorization direduksi menjadi `[REDACTED]`, sedangkan
string, array, object, dan kedalaman konteks dibatasi agar feedback atau detail sumber tidak
menggelembungkan request. Jika source live tidak memberi `dataAsOf`, field tersebut tetap
`null`; `retrievedAt` tidak boleh dibaca sebagai waktu data dan `freshnessStatus` akan bernilai
`UNKNOWN`.

### Skill dan reviewer Hermes

Intent memilih skill versioned secara deterministik:

- `IKLAN` → `ads-performance-analyst`;
- `PERFORMA_TOKO` → `store-funnel-analyst`;
- `PERFORMA_PRODUK` → `product-portfolio-analyst`.

Sebelum konteks dikirim, `critical reviewer` memeriksa status `SAFE`, keberadaan evidence,
dan untuk Performa Produk status rekonsiliasi `MATCH`. Skill tidak boleh mengubah angka
sumber; skill hanya menentukan aturan interpretasi, klaim terlarang, dan bentuk tindakan
yang perlu diuji.

### Memori, feedback, dan outcome tracking

Setiap response sukses dari `POST /api/hermes/analyze` mencoba menyimpan memori audit
secara fail-soft. Field `memoryId` dan `memoryPersisted` menunjukkan apakah snapshot
konteks, evidence ledger, dan output analisa berhasil disimpan. Kegagalan penyimpanan
memori tidak menggagalkan hasil analisa utama.

- `GET /api/hermes/memories` mengembalikan memori milik user, termasuk feedback,
  tindakan, dan slot evaluasi.
- `GET /api/hermes/memories/:id` mengembalikan satu memori lengkap. Query selalu dibatasi
  oleh `userId`; user tidak dapat membaca memori user lain.
- `POST /api/hermes/analyze/:id/feedback` menerima `rating` bernilai `HELPFUL`,
  `PARTIALLY_HELPFUL`, `NOT_HELPFUL`, atau `INACCURATE`, dan `comment` opsional. Feedback
  bersifat upsert sehingga satu user dapat memperbaiki sinyalnya.
- `POST /api/hermes/analyze/:id/actions` menerima `recommendationIndex` dan menyalin
  rekomendasi yang sudah tervalidasi dari memori. Client tidak dapat mengganti teks
  rekomendasi atau baseline secara sepihak.
- `PATCH /api/hermes/actions/:id` menerima status `PLANNED`, `IN_PROGRESS`, `COMPLETED`,
  `SKIPPED`, atau `CANCELLED`. Saat tindakan ditandai `COMPLETED`, server membuat slot
  evaluasi 7 dan 30 hari.
- `DELETE /api/hermes/actions/:id` hanya menghapus tindakan milik user dengan status
  `PLANNED`/belum dimulai. Tindakan yang sudah dimulai ditolak agar histori pembelajaran
  tidak hilang.
- `POST /api/hermes/actions/:id/evaluate` menerima `windowDays: 7` atau `30`. Sebelum
  jendela waktunya tercapai, response berstatus `NOT_READY`. Setelahnya server membaca
  adapter live kanonik; bila metric key, baseline, atau sumber tidak valid, hasilnya
  `INSUFFICIENT_DATA`, bukan angka pengganti.

Rekomendasi hanya dapat menjadi outcome terukur jika output Hermes menyertakan `metricKey`
yang terdaftar untuk intent tersebut, unit yang cocok, baseline numerik yang ada di evidence,
serta `windowDays` 7 atau 30. Setiap rekomendasi mendapat `recommendationId` stabil seperti
`rec-1`, dan memory menyimpan `promptVersion` serta `outputSchemaVersion` untuk audit.
Untuk kompatibilitas istilah model, `PERFORMA_PRODUK.conversionRate` dinormalisasi server
menjadi metric canonical `averageConversionRate`; nilai yang disimpan dan dievaluasi tetap
memakai nama canonical tersebut.

Feedback dapat menyertakan `reasons`, misalnya `DATA_MISMATCH`, `ANALYSIS_TOO_GENERAL`,
`RECOMMENDATION_NOT_EXECUTABLE`, `NUMBERS_CORRECT_INTERPRETATION_WRONG`,
`INSUFFICIENT_DATA`, `ACTION_WORKED`, atau `OUTCOME_NOT_IMPROVED`.

Evaluasi menyimpan `baselineValue`, `targetValue`, `actualValue`, `deltaValue`, verdict,
evidence, periode efektif, dan `periodStatus`. `periodStatus` membedakan `EXACT`,
`NATIVE_PERIOD`, `PERIOD_MISMATCH`, `SOURCE_BLOCKED`, dan `NOT_CHECKED`. Pada
`NATIVE_PERIOD` hanya valid jika periode tindakan tepat sama dengan rolling window 7/30 hari
saat evaluasi dijalankan. `PERIOD_MISMATCH` tidak memaksakan verdict. Verdict yang tersedia tetap merupakan
perbandingan terhadap baseline, bukan klaim bahwa tindakan tersebut menyebabkan perubahan.
Outcome terukur dan feedback yang sudah tersimpan dibaca sebagai sinyal pembelajaran pada
analisa berikutnya, dengan batasan tersebut tetap dibawa ke prompt.
