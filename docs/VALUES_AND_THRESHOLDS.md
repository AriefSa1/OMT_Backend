# Nilai dan ambang batas yang bisa diubah

Katalog setiap konstanta bisnis (bukan sekadar styling) yang tersebar di kode backend,
lokasinya, dan apa yang perlu diperhatikan sebelum mengubahnya. Untuk field respons API,
lihat `API_REFERENCE.md`. Untuk field frontend, lihat `frontend/docs/VALUES_AND_THRESHOLDS.md`.

## Kesegaran data (`freshnessMinutes`)

`src/services/snapshotService.js`, argumen `freshnessMeta({...})`:

| Snapshot | Ambang | Baris |
|---|---|---|
| Katalog (`getCatalogSnapshot`) | 45 menit | `:186` |
| Produk tunggal (`getProductSnapshot`) | 45 menit | `:369` |
| Iklan (`getAdsSnapshot`) | 24 jam (`24*60`) | `:441` |
| Gudang (`getWarehouseSnapshot`) | 45 menit | `:790` |

Menaikkan angka ini membuat data "Tertunda" lebih lambat muncul (lebih toleran terhadap
data lama). Tidak memengaruhi kapan Sync benar-benar berjalan — itu diatur cron interval
di Pengaturan.

## Kunci sinkronisasi

`src/services/syncLockService.js:5` — `DEFAULT_TTL_MS = 20 * 60 * 1000` (20 menit). Kalau
sync sungguhan bisa memakan waktu lebih lama dari ini pada katalog besar, kunci akan
kedaluwarsa sebelum sync selesai dan sync berikutnya bisa mulai bertumpuk — naikkan TTL,
jangan hapus kuncinya.

## Gudang aktif

`src/constants/warehouseConstants.js` — daftar 4 gudang yang benar-benar dipakai sistem:
```js
[{ id: 38, name: 'PDC Warehouse' }, { id: 94, name: 'Palem Warehouse' },
 { id: 67, name: 'Febri Warehouse' }, { id: 96, name: 'Cemara Warehouse' }]
```
Dipakai di semua query gudang untuk **mengecualikan** gudang lain yang mungkin ada di data
mentah API tapi tidak relevan secara operasional. **Menambah gudang baru ke sini
otomatis membuatnya muncul di filter, agregasi total, dan halaman gudang** — tidak perlu
sentuh kode lain. Hapus dengan hati-hati: banyak query mengasumsikan daftar ini tidak kosong.

## Klasifikasi tipe produk gudang

`src/services/warehouseService.js:648-674`, `determineProductType(prod, team)`:
- `priority` — jika field `priority`/`isPriority` dari API bernilai true
- `research` — heuristik: kode tim `'00'`, nama tim mengandung "internal"/"riset"/"research",
  flag `cross_locked`, atau `ref_id`/`name` berawalan/berisi `RS-`/`RSC-`/`RISET`
- `general` — selainnya

**Ubah aturan ini hati-hati** — heuristik nama/kode ini spesifik untuk struktur tim PDC
Gudang saat ini; jangan digeneralisasi tanpa data nyata dari tim baru.

## Pemetaan tim → gudang fallback

`src/services/warehouseService.js:676-699`, `determineProductWarehouse(prod, team)` — peta
`teamId → { warehouseId, warehouseName, warehouseLocation }` hardcoded (tim 40 → Pdc
Srengat, tim 88/1 → Palem, tim 67 → Febri, tim 92 → LGIS, tim 96 → Cemara, selainnya → PDC
Center). Dipakai hanya sebagai **fallback** ketika API `list_sku` tidak mengembalikan
lokasi gudang eksplisit untuk suatu varian. Menambah tim baru di sini mencegah produknya
jatuh ke fallback generik "PDC Center".

## Ambang rekonsiliasi stok

`src/services/warehouseService.js:1671`:
```js
status = variance === 0 ? 'MATCHED' : Math.abs(variance) > 5 ? 'CRITICAL' : 'DISCREPANCY'
```
Selisih di atas 5 unit dianggap `CRITICAL`. **Prasyarat penting**: rekonsiliasi ini
sekarang tidak reliabel secara sistemik — SKU gudang dan SKU katalog Shopee tidak
tumpang tindih (lihat `reconciliationTrust` di `API_REFERENCE.md` dan `AGENTS.md` § SKU
mapping). Mengubah ambang ini tidak memperbaiki masalah itu.

## Skor kesehatan optimasi

`src/services/optimizationService.js:4-7`:
```js
healthScore = recommendations.length ? Math.max(0, 100 - Σ(bobot)) : null
// bobot: HIGH=12, MEDIUM=6, LOW=3
```
**Catatan yang sudah tercatat di `AGENTS.md`**: skor ini mentok di 0 setelah ~13 temuan
HIGH-priority, sehingga berhenti membedakan "buruk" dari "sangat buruk". Bukan bug — nilai
hasil hitungan asli, bukan karangan — tapi perlu keputusan produk sebelum diubah (skala
ulang bobot, atau ganti formula).

## Rekomendasi otomatis — ambang pemicu

`src/services/snapshotService.js`, `buildProductRecommendations()` (baris 825-855):
- CTR rendah: `impressions ≥ 100 && 0 < CTR < 1%`
- Hambatan checkout: `addToCartBuyers > 0 && confirmedOrders === 0`
- Risiko stok: `stock ≤ 3 && salesCount > 0` (prioritas `HIGH` jika `stock === 0`)

`buildAdsRecommendations()` (baris 857-866): kampanye dengan `spend > 0` dan
(`CTR < 1%` **atau** `ROAS < 2`) — prioritas `HIGH` jika `ROAS < 1`.

`shopeeInsightsService.buildProductSignals()` (`src/services/shopeeInsightsService.js:76-112`)
punya ambang yang **sama persis** untuk fitur "marketplace intelligence" — kedua tempat ini
harus tetap sinkron kalau ambangnya diubah, karena keduanya menilai definisi masalah yang
sama dari dua sumber data yang berbeda (snapshot lokal vs live Shopee).

## Divisor nominal iklan Shopee

`src/services/shopeeService.js:17` — `ADS_AMOUNT_DIVISOR = 100000`. Shopee mengirim nilai
rupiah dikali 100.000 secara internal; semua field `spend/sales/dailyBudget/voucher*`
dibagi angka ini sebelum ditampilkan. **Jangan ubah tanpa memverifikasi ulang lewat
`amountAudit.divisor`** di respons `/api/shopee/ads` — kalau Shopee mengubah skalanya,
`rawSpend` dkk. tetap tersimpan mentah untuk audit ulang.

## Retry & kuota AI

Lihat `AI_SERVICE.md` — `maxRetries` di `generateJson()`, dan tabel klasifikasi error
(`RATE_LIMITED`, dsb).

## Konvensi umum: `null` vs `0`

Ini bukan satu nilai tunggal untuk diubah, tapi pola yang berulang di seluruh backend dan
**harus dipertahankan** saat menambah field baru: sebuah angka yang belum terukur (belum
ada data, koneksi gagal, sumber tidak mendukung) harus `null`, bukan `0`. `0` terbaca
sebagai "sudah dicek, hasilnya nol masalah" — itu klaim yang tidak boleh dibuat tanpa
data. Contoh yang sudah diterapkan: `kpis.warehouseUnits`, `totals.discrepanciesCount`,
`stats.totalIn` (gudang), `salesTrend[].adSpend`. Lihat constraint 1 di `AGENTS.md`.
