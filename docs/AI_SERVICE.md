# Fitur AI — cara kerja dan cara mengubah

Referensi untuk `src/services/aiService.js`, `src/controllers/aiController.js`, dan
`src/routes/aiRoutes.js`. Untuk ringkasan cepat di terminal, jalankan:

```bash
npm run docs:ai
```

## Kenapa fitur AI sering gagal (2026-08-05)

Bukan bug. Kunci Gemini yang dipakai berada di **free tier** dengan kuota
`GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20 permintaan/hari` untuk model
`gemini-2.5-flash`. Diagnosis terukur pada tanggal di atas: dari 5 fitur, 4 gagal dengan
HTTP 429 `RESOURCE_EXHAUSTED` pada percobaan pertama.

Dua penyebab digabung:

1. **Kuota habis** — di luar kendali kode; hanya reset harian atau upgrade paket yang
   memulihkannya.
2. **Tidak ada retry** — sebagian kegagalan 429 sebenarnya transien (percobaan kedua
   berhasil dalam hitungan detik), tapi kode lama langsung menyerah begitu Gemini
   menjawab 429 sekali. Ini sudah diperbaiki (lihat "Retry & klasifikasi error" di bawah).
3. **Briefing harian menembak Gemini di setiap kunjungan dashboard** tanpa cache — bisa
   menghabiskan kuota 20/hari hanya dari navigasi biasa, sebelum pengguna sempat mencoba
   4 fitur lain. Sudah diperbaiki dengan cache 10 menit di `frontend/lib/api.js`.

Jalankan `npm run test:ai` untuk memverifikasi logika tanpa memakai kuota sama sekali
(seluruhnya di-mock). Untuk mengecek kuota harian tersisa, buka
https://ai.dev/rate-limit dengan akun yang memiliki kunci API tersebut.

## Lima fungsi AI (`src/services/aiService.js`)

| # | Fungsi | Dipanggil dari | Input wajib |
|---|---|---|---|
| 1 | `generateABTestCopy` | `POST /api/ai/ab-copy` | `name` |
| 2 | `predictRestockAndLiquidation` | `POST /api/ai/predictive-restock` | `warehouseStock` (bukan `null`) |
| 3 | `simulateDynamicPricing` | `POST /api/ai/pricing-simulator` | `platformFeePercent` (bukan `null`) |
| 4 | `generateDailyBriefing` | `GET/POST /api/ai/daily-briefing` | — (menyusun snapshot sendiri) |
| 5 | `optimizeAdsKeywordsAndBids` | `POST /api/ai/ads-keyword-optimization` | — |

Setiap fungsi mengikuti pola yang sama:

1. **Validasi & hitung dulu** — apa pun yang bisa dihitung secara pasti (metrik stok,
   margin harga) dihitung di JavaScript biasa, bukan diminta ke model. Kalau input yang
   dibutuhkan tidak ada (`warehouseStock`, `platformFeePercent`), fungsi berhenti dengan
   `missingInput(...)` — **tidak pernah menebak**.
2. **Jika `this.ai` kosong** (kunci belum diisi) → `notConfigured(...)`, membawa hanya
   angka yang sudah dihitung sendiri di langkah 1. Tidak ada saran/skor karangan.
3. **Jika terkonfigurasi** → `this.callGemini({ prompt, trusted, fallbackPayload,
   failMessage, logLabel })`. Ini titik tunggal yang memanggil Gemini, dipakai oleh
   kelima fungsi (dulu setiap fungsi menulis try/catch sendiri-sendiri — sekarang
   digabung supaya perbaikan retry/klasifikasi berlaku otomatis ke semuanya).

## Amplop respons (kontrak yang harus tetap sama)

Setiap fungsi selalu mengembalikan salah satu dari empat bentuk ini (dibangun oleh
`notConfigured` / `missingInput` / `aiFailed` / `aiResult`):

```js
{ success: false, provider: 'NOT_CONFIGURED', model, message, ...trusted }
{ success: false, provider: 'MISSING_INPUT',  model, message, ...trusted }
{ success: false, provider: 'ERROR', errorCode, model, message, ...trusted, ...fallbackPayload }
{ success: true,  provider: 'REAL_GEMINI_API', model, ...trusted, ...parsedModelOutput }
```

`trusted` selalu di-spread **setelah** hasil Gemini (`aiResult`) atau **digabung** ke
`fallbackPayload` (`aiFailed`) — itu sebabnya nilai yang dihitung sendiri (mis.
`calculations`, `metrics`) tidak akan pernah tertimpa oleh keluaran model.

Frontend membaca `provider` (dan sekarang `errorCode`) lewat
`frontend/components/AIStatusNotice.jsx` untuk menentukan pesan apa yang ditampilkan.
**Jangan ubah nama field ini tanpa mengubah komponen itu juga.**

## Retry & klasifikasi error

`classifyGeminiError(err)` di bagian atas `aiService.js` membaca `err.status` (dari SDK
`@google/genai`) dan mengurai `retryDelay` dari body JSON errornya:

| Kode | Kondisi | Retry otomatis? |
|---|---|---|
| `RATE_LIMITED` | HTTP 429 | Ya, sampai 2x, menunggu `retryDelay` (maks 20 detik) |
| `UNAVAILABLE` | HTTP 5xx | Ya, sama seperti di atas |
| `INVALID_RESPONSE` | Keluaran model bukan JSON valid | Tidak |
| `HTTP_4xx` lain / `UNKNOWN` | Selain di atas | Tidak |

`generateJson(prompt, { maxRetries = 2 })` yang menjalankan retry ini. Ubah angka
`maxRetries` di sana kalau perlu — ingat, setiap retry adalah **permintaan sungguhan**
yang ikut memakai kuota harian, jadi jangan dinaikkan sembarangan.

## Cara mengubah sesuatu

**Mengubah prompt / format keluaran satu fitur** — edit string `prompt` di dalam
fungsi FITUR terkait (mis. `generateABTestCopy`). Contoh JSON di dalam prompt itu adalah
skema yang diminta ke model — ubah bentuknya di sana, lalu sesuaikan komponen frontend
yang membacanya (lihat tabel "Dipanggil dari" di atas untuk peta rute → komponen).

**Mengubah field yang diteruskan dari request** — edit `pickArgs` di
`src/controllers/aiController.js` (fungsi `aiEndpoint(...)`). Jangan tambah field baru di
sana tanpa menambah parameter yang sesuai di fungsi `aiService`-nya.

**Menambah fitur AI baru** —
1. Tulis method baru di `AIService` (ikuti pola: hitung dulu → guard → `callGemini`).
2. Tambah satu baris di `aiController.js`:
   `const namaEndpoint = aiEndpoint('namaMethodDiAiService', (body) => ({ ...field yang dipakai }));`
3. Export dari `module.exports = wrapHandlers({ ... })` dan daftarkan rute baru di
   `aiRoutes.js`.
4. Tambah kasus uji di `test-ai-suite.js` (mock, bukan panggilan nyata).

**Mengubah model** — ubah `this.modelName` di constructor `AIService`. Model lain punya
kuota terpisah di free tier, jadi ini salah satu cara mengurangi dampak kuota 20/hari
yang sedang membatasi fitur ini — verifikasi dulu limitnya di
https://ai.google.dev/gemini-api/docs/rate-limits sebelum mengganti.

**Mengubah kunci API saat runtime** — jangan edit `.env`. Kunci disimpan di tabel
`SystemConfig` lewat halaman Pengaturan (`POST /api/settings`), dan setiap request AI
memanggil `aiService.setApiKey(geminiApiKey)` dulu jika body membawa field itu — lihat
`aiEndpoint(...)` di `aiController.js`.

## Menguji

```bash
npm run test:ai     # logika retry/klasifikasi/kontrak — TIDAK memakai kuota
```

Tidak ada skrip di repo ini yang boleh memanggil Gemini secara langsung hanya untuk
"tes" — itulah yang menghabiskan kuota 20/hari sebelumnya (`test-ai-suite.js` versi lama
memanggil kelima fitur secara live setiap dijalankan; `test_ai_gemini.js` bahkan
menembak rute yang sudah tidak ada — keduanya sudah dibersihkan). Kalau perlu memverifikasi
sungguhan terhadap Gemini, lakukan itu manual satu kali lewat UI Pengaturan → panel AI,
bukan lewat skrip yang bisa terulang dijalankan tanpa sadar.
