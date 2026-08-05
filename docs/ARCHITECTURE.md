# Arsitektur backend

Ringkasan alur & peta modul. Untuk field respons endpoint, lihat `API_REFERENCE.md`. Untuk
konstanta/ambang yang boleh diubah, lihat `VALUES_AND_THRESHOLDS.md`.

## Lapisan (satu arah, jangan dibalik)

```
routes/  →  controllers/  →  services/  →  Prisma (utils/prisma.js) / axios (Shopee, PDC Gudang)
```

- **`routes/*.js`** — hanya deklarasi path + `authMiddleware`. Tidak ada logika.
- **`controllers/*.js`** — memvalidasi `req.body`/`req.query`, memanggil satu atau beberapa
  service, membentuk bentuk JSON respons. **Field respons endpoint biasanya sudah datang
  jadi dari service — controller jarang menghitung apa pun sendiri.**
- **`services/*.js`** — logika bisnis nyata: query Prisma, panggilan HTTP ke Shopee/PDC
  Gudang, perhitungan (margin, skor kesehatan, rekonsiliasi).
- Semua akses database lewat `src/utils/prisma.js` (satu instance singleton, dibangun dari
  path generator non-standar `node_modules/.prisma/client-active` — lihat constraint 7 di
  `AGENTS.md`. **Jangan bikin instance Prisma Client kedua** — itu persis masalah yang
  dihapus 2026-08-05, lihat `AGENTS.md` § Dead code removed).

## Dua sumber data yang harus dibedakan

Setiap fitur yang menampilkan data Shopee/gudang punya dua jalur:

1. **Snapshot lokal** (`snapshotService.js`) — dibaca dari tabel Prisma, cepat, tidak
   memanggil Shopee/gudang sama sekali. Ini yang dipakai mayoritas halaman.
2. **Live read** — memanggil Shopee/PDC Gudang langsung saat request masuk (contoh:
   `GET /api/warehouse/team-overview`, `GET /api/shopee/traffic-sources`,
   `GET /api/shopee/ads` tanpa `force_snapshot=true`). Dipakai hanya ketika datanya benar
   perlu "saat ini juga" dan tidak ada snapshot yang masuk akal untuk itu.

**Snapshot diperbarui HANYA lewat Sync** (`syncService.js`, dipicu manual dari UI atau cron
terjadwal). Constraint 8 di `AGENTS.md`: sync memanggil Shopee sungguhan atas akun toko
pengguna — jangan pernah menjalankannya tanpa izin eksplisit.

## Objek `meta` (freshnessMeta)

Hampir setiap snapshot (`getCatalogSnapshot`, `getAdsSnapshot`, `getWarehouseSnapshot`)
mengembalikan objek `meta` yang dibangun oleh `freshnessMeta()`,
`src/services/snapshotService.js:75`:

```js
{
  source,            // 'SHOPEE_SNAPSHOT' | 'SHOPEE_ADS_SNAPSHOT' | 'WAREHOUSE_SNAPSHOT'
  dataAsOf,           // ISO timestamp data terakhir, atau null
  status,             // 'Segar' | 'Tertunda' | 'Perlu Koneksi' | 'Gagal' | 'Tidak Tersedia'
  ageMinutes,
  message,            // kalimat siap-tampil menjelaskan status di atas
}
```

Aturan penentuan `status` (baris 82-86, urutan pengecekan penting — jangan diubah urutannya
tanpa memikirkan ulang precedence-nya):
1. `!connectionReady` → `Perlu Koneksi`
2. Sync terakhir `FAILED` setelah data tersimpan → `Gagal`
3. Tidak ada data sama sekali → `Tidak Tersedia`
4. Data lebih tua dari `freshnessMinutes` → `Tertunda`
5. Selain itu → `Segar`

**Ubah ambang "basi"** → parameter `freshnessMinutes` di tiap pemanggilan `freshnessMeta()`
(katalog 45 menit, iklan 24 jam, gudang 45 menit — lihat `VALUES_AND_THRESHOLDS.md`).

## Alur Sync (`syncService.js` + `syncCron.js`)

```
syncAll()
  └─ syncLockService.runExclusive()   // kunci DB, TTL 20 menit — cegah dua sync jalan bersamaan
       ├─ syncShopee()   → fetchLiveShopeeMetrics() + syncOrderSummaryHistory() → persistProducts, ShopeeOrderSummary
       ├─ syncAds()      → fetchShopeeAdsMetrics()  → persistAdsSnapshot()      → ShopeeAdsData, ShopeeAdsCampaignSnapshot
       └─ syncWarehouse()→ calculateReconciliation()→ persistWarehouseSnapshots()→ WarehouseStockSnapshot
```

Tiap langkah menulis satu baris `SyncJobLog` (`jobType, status, message, timestamp`) —
inilah yang mengisi `GET /api/sync/logs` dan panel "Aktivitas Sync" di dashboard.

Cron (`src/cron/syncCron.js`) memanggil `syncAll({ origin: 'CRON' })` sesuai interval di
Pengaturan (`5m|15m|30m|1h`, default `15m`). **Ubah pemetaan interval → cron expression** →
`toCronExpression()` di file itu.

## Model data (Prisma) — kelompok fungsional

Skema penuh: `prisma/schema.prisma`. Ringkasan per kelompok:

| Kelompok | Model | Dipakai oleh |
|---|---|---|
| Auth & konfigurasi | `User`, `SystemConfig` | `authController`, `configService` |
| Sesi Shopee | `StoreSession` | `shopeeService.getActiveSession/saveSession` |
| Katalog Shopee | `ShopeeProduct`, `ShopeeListingVariation`, `ProductMetricSnapshot` | `snapshotService.getCatalogSnapshot`, sync katalog |
| Pesanan Shopee | `ShopeeOrderSummary` | dashboard KPI, `orderQuality` |
| Iklan Shopee | `ShopeeAdsData`, `ShopeeAdsCampaignSnapshot` | `snapshotService.getAdsSnapshot` |
| Gudang | `WarehouseLocation`, `WarehouseItem`, `WarehouseStockSnapshot`, `StockMovement` | `warehouseService`, `snapshotService.getWarehouseSnapshot` |
| Pemetaan SKU (skema ada, **belum dipakai**) | `ProductMapping`, `ProductMappingComponent` | — lihat `AGENTS.md` § SKU mapping |
| Rekonsiliasi | `StockReconciliation` | `warehouseService.calculateReconciliation` (penulisan baru dinonaktifkan — lihat komentar di service) |
| Sinkronisasi | `SyncJobLog`, `SyncRunLock` | `syncService`, `syncLockService` |
| Tugas operasional | `OptimizationTask`, `OptimizationTaskEvent` | `taskService`, `/api/tasks` |

**Setelah mengubah `schema.prisma`**: jalankan `npx prisma migrate dev --name ...` (BUKAN
`db push` — lihat constraint 5 di `AGENTS.md`, tabel `StockReconciliation` menyimpan data
nyata), lalu **wajib** `npx prisma generate` (constraint 7 — client di-generate ke path
non-standar dan tidak refresh sendiri).

## Fitur AI

Terpisah sepenuhnya dari alur snapshot/sync di atas — `src/services/aiService.js` tidak
menyentuh Prisma sama sekali, hanya memanggil Gemini. Didokumentasikan penuh di
`AI_SERVICE.md` (`npm run docs:ai` untuk ringkasan terminal).

## Middleware & util bersama

- `src/middleware/authMiddleware.js` — validasi JWT, mengisi `req.user`. Satu-satunya
  salinan (yang di `src/utils/authMiddleware.js` sudah dihapus — itu shim mati).
- `src/utils/asyncHandler.js` — `wrapHandlers({...})` membungkus setiap fungsi controller
  supaya `Promise` yang reject diteruskan ke error-middleware Express
  (`server.js`), bukan menggantung tanpa respons. Semua modul `controllers/*.js`
  mengekspor lewat `wrapHandlers`.
- `src/utils/headerGenerator.js` — header HTTP yang meniru Seller Center (User-Agent,
  Referer, token CSRF dari cookie).
- `src/utils/cookieParser.js` — mem-parse cookie Shopee mentah jadi token-token yang
  dibutuhkan (`parseShopeeCookie`).
- `src/utils/taskOrdering.js` — `sortTasksByPriority`, urutan tampil task/rekomendasi.

## Skrip mandiri (`src/scripts/`)

Dijalankan manual, tidak diimpor modul lain:
- `checkSkuMappingFeasibility.js` — cek apakah SKU varian Shopee cocok dengan SKU gudang
  (baca `AGENTS.md` § SKU mapping sebelum menjalankan ulang).
- `migrateAdsAmounts.js` — migrasi data satu kali untuk normalisasi nominal iklan lama.
