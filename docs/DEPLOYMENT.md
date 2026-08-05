# Rencana Deploy — Backend ke Render, Frontend ke Hostinger

Disusun 2026-08-06. Semua angka dan kemampuan platform di bawah **diverifikasi langsung**
terhadap akun dan basis data yang sebenarnya, bukan diasumsikan.

Target:
- **Backend** (`OMT_Backend`) → Render free tier
- **Frontend** (`OMT_Frontend`) → Hostinger Business Web Hosting (`94media.art`)

---

## STATUS SAAT INI (per 2026-08-06)

Sudah **terdeploy dan berjalan**:
- Backend: `https://omt-backend-34ap.onrender.com` (Render free tier, region Singapura) — health OK.
- Frontend: `https://94media.art` (+ `www`) — mengarah ke backend di atas via `NEXT_PUBLIC_API_BASE`.
- Basis data: PostgreSQL Neon (bukan lagi SQLite — blocker §0.2 sudah teratasi).

Postur keamanan runtime sudah diverifikasi terhadap deploy langsung:
- Endpoint data balas 401 tanpa token; CORS menolak origin selain `94media.art`.
- `/api/settings` tidak mengembalikan nilai secret (hanya `*Configured: boolean`).
- Fallback JWT publik sudah dihapus — produksi kini wajib `JWT_SECRET` (Render menyetelnya
  otomatis; diverifikasi token invalid → 401, bukan 500).

Pengerasan deploy (2026-08-06, diuji lokal 9/9 + bootstrap):
- **Registrasi terbuka DITUTUP.** Dulu `POST /api/auth/register` tanpa auth — siapa pun
  bisa mendaftar dan melihat data toko. Sekarang wajib kode undangan `REGISTRATION_SECRET`
  (kecuali user pertama saat DB kosong → jadi ADMIN). **Set `REGISTRATION_SECRET` di Render
  Environment** agar bisa menambah user lewat form; tanpa itu, pakai `node manage_admin.js`.
- **Rate limit** `/api/auth`: 20 percobaan / 15 mnt / IP (setel via `AUTH_RATE_LIMIT_MAX`).
- **Header keamanan**: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, HSTS (produksi).
- **Batas body** 1 MB; `x-powered-by` disembunyikan; `trust proxy` untuk IP nyata di Render.
- Frontend: form daftar menampilkan field **Kode undangan**; cookie rute `Secure` di HTTPS.

**Yang MASIH terbuka dan hanya Anda yang bisa tuntaskan** — lihat §0.1. Keputusan Anda
2026-08-06: repo **tetap publik** dan riwayat **tidak** ditulis ulang. Konsekuensinya
kredensial di riwayat harus dianggap bocor permanen sampai **dirotasi**.

## 0. Dua hal yang harus diselesaikan SEBELUM deploy pertama

### 0.1 Kredensial produksi ada di dalam riwayat git — WAJIB ROTASI (repo publik, riwayat dibiarkan)

> Pindaian ulang 2026-08-06 pada blob di riwayat (commit `c6eb1ca`): **14 cookie sesi
> Shopee (`SPC_*`), 6 hash bcrypt akun, username+password gudang, kunci Gemini**. Repo
> `AriefSa1/OMT_Backend` publik dan riwayat sengaja tidak dibersihkan, jadi rotasi bukan
> opsional — ini satu-satunya perbaikan nyata.

Dua berkas backup basis data ikut ter-commit ke repositori:

```
64,8 MB  prisma/dev.db.before-audit-20260804.bak
30,8 MB  prisma/dev.db.before-multiwarehouse.bak
```

Isinya diperiksa (tanpa menampilkan nilainya):

| Isi | Keterangan |
|---|---|
| `cookieString` | 2.989 karakter — sesi penuh Shopee Seller Center toko Anda |
| `geminiApiKey` | 53 karakter |
| `warehouseUsername` + `warehousePassword` | kredensial PDC Gudang, tersimpan apa adanya |
| `warehouseLoginUrl`, `warehouseInventoryUrl` | endpoint internal PDC |
| 6 akun `User` | beserta hash bcrypt-nya |

Repositori ini ada di GitHub (`AriefSa1/OMT_Backend`). Selama kedua berkas itu berada di
riwayat git, siapa pun yang memiliki akses repositori memiliki akses penuh ke Seller
Center dan sistem gudang — dan `git rm` biasa **tidak** menghapusnya dari riwayat.

Yang harus dilakukan, berurutan:

1. **Anggap ketiga kredensial itu sudah bocor** dan ganti sekarang, tanpa menunggu
   pembersihan git selesai:
   - Keluar dari semua sesi Seller Center lalu ambil cookie baru
   - Cabut kunci Gemini lama di Google AI Studio, buat yang baru
   - Ganti password akun PDC Gudang
   - Minta 6 user dashboard mengganti password (hash-nya bocor)
2. (DILEWATI atas keputusan Anda) Membersihkan riwayat: bila kelak berubah pikiran,
   `git filter-repo --path prisma/dev.db.before-audit-20260804.bak --path prisma/dev.db.before-multiwarehouse.bak --invert-paths` lalu force-push. Menulis ulang riwayat & memicu redeploy Render.
3. `.gitignore` sudah mencakup `*.bak` dan `prisma/*.db`, jadi backup baru tidak terulang. ✅

Karena riwayat dibiarkan publik, langkah 1 (rotasi) adalah pertahanan satu-satunya.

### 0.2 SQLite di Render free tier = data hilang setiap deploy

`render.yaml` saat ini menetapkan:

```yaml
DATABASE_URL: "file:./dev.db"
```

Render free tier tidak memiliki penyimpanan permanen (persistent disk adalah fitur
berbayar). Sistem berkasnya kembali ke hasil build setiap kali layanan **di-deploy,
di-restart, atau bangun dari tidur** — dan free tier tidur otomatis setelah ±15 menit
tanpa lalu lintas.

Yang hilang setiap kali itu terjadi:

| Data | Jumlah | Bisa dibuat ulang? |
|---|---|---|
| `User` | 6 akun | **Tidak** — pengguna tidak bisa login lagi |
| `SystemConfig` | 12 baris | **Tidak** — cookie Shopee, kunci Gemini, kredensial gudang harus diisi ulang manual |
| `StoreSession` | 1 | **Tidak** |
| `OptimizationTask` + event | 3 + 5 | **Tidak** — ini pekerjaan manusia |
| `ShopeeProduct`, `ShopeeAdsData`, `ShopeeOrderSummary`, `ProductMetricSnapshot`, `WarehouseItem` | 168 / 30 / 32 / 184 / 31.388 | Ya, lewat Sync |

Artinya: setiap deploy akan mengembalikan aplikasi ke keadaan kosong tanpa pengguna dan
tanpa koneksi — bukan hanya kehilangan riwayat, tapi tidak bisa dipakai sampai seseorang
login (padahal akunnya juga hilang) dan mengisi ulang seluruh kredensial.

**Solusi: pindah ke Postgres terkelola.** Ini keputusan yang perlu Anda ambil, jadi tiga
pilihan beserta konsekuensinya ada di bagian 2.

---

## 1. Arsitektur target

```
 Pengguna
    │  https://94media.art
    ▼
 Hostinger Business — Next.js (Node 24, app_type "next", deploy dari git)
    │  fetch  →  NEXT_PUBLIC_API_BASE
    ▼
 Render free tier — Express (OMT_Backend)
    │
    ├─→ Postgres terkelola (Neon / Supabase / Render)
    ├─→ Shopee Seller Center  (cookie dari SystemConfig)
    └─→ PDC Gudang            (kredensial dari SystemConfig)
```

Kemampuan Hostinger sudah terbukti, bukan asumsi: akun `u515949342` domain `94media.art`
tercatat **16 deployment Next.js berhasil** (`app_type: "next"`, `node_version: 24`,
`output_directory: ".next"`, `build_script: "build"`, sumber git). Jadi:

- **Tidak perlu** static export (`output: 'export'`)
- `middleware.js` tetap berfungsi — gerbang autentikasi tidak perlu diubah
- Route dinamis `/product/[id]` tetap dirender di server

---

## 2. Basis data — pilih satu

| Pilihan | Kuota gratis | Catatan penting |
|---|---|---|
| **Neon** (disarankan) | 0,5 GB, selalu hidup | Postgres serverless; cocok karena backend Render sering tidur lalu bangun |
| **Supabase** | 500 MB | Proyek gratis **dijeda setelah 7 hari tanpa aktivitas** — cocok bila dipakai harian, berisiko bila tidak |
| **Render Postgres** | 1 GB | Instans gratis **dihapus setelah 30 hari**. Hanya untuk uji coba, jangan untuk produksi |

### 2.1 Ramping-kan dulu sebelum migrasi

Basis data saat ini 176 MB, tapi sebagian besar adalah data mati:

```
59,9 MB  StockReconciliation            (617.988 baris)
29,8 MB  index sqlite_autoindex_StockReconciliation_1
25,0 MB  index StockReconciliation_sku_warehouseId_checkedAt_idx
21,5 MB  WarehouseStockSnapshot
16,0 MB  WarehouseItem                  (31.388 baris)
```

`StockReconciliation` sendiri ±115 MB (tabel + indeksnya) dan **penulisannya sudah
dinonaktifkan** — lihat komentar di `warehouseService.calculateReconciliation()`: baris-
barisnya adalah artefak perbandingan dua himpunan SKU yang tidak beririsan, ditulis
berulang tanpa upsert. Membersihkannya membuat basis data muat nyaman di kuota gratis
mana pun.

Jangan hapus tanpa backup lebih dulu, dan jalankan `VACUUM` setelahnya agar ruangnya
benar-benar kembali.

### 2.2 Langkah migrasi

1. Backup: salin `prisma/dev.db` ke luar repositori (bukan ke dalam folder repo — itu yang
   menyebabkan masalah 0.1).
2. Bersihkan `StockReconciliation`, lalu `VACUUM`.
3. Ubah `provider` di `datasource db` dari `sqlite` ke `postgresql`.
4. `prisma/migrations/migration_lock.toml` saat ini berisi `provider = "sqlite"` —
   riwayat migrasi harus dibuat ulang untuk Postgres. Cara paling bersih: arsipkan folder
   `migrations` lama, lalu `prisma migrate dev --name init_postgres` terhadap basis data
   Postgres kosong.
5. Pindahkan datanya. Untuk volume sekecil ini setelah dibersihkan, skrip Node yang membaca
   dari SQLite dan menulis ke Postgres lewat Prisma sudah memadai — atau isi ulang lewat
   Sync dan masukkan kembali `User`, `SystemConfig`, `StoreSession`, `OptimizationTask`
   secara manual (hanya empat tabel itu yang tidak bisa dibuat ulang).
6. `npx prisma generate` — ingat `generator client` menulis ke path non-standar
   `node_modules/.prisma/client-active`, dan tidak ada yang menyegarkannya otomatis.

---

## 3. Deploy backend ke Render

### 3.1 Perbaiki `render.yaml`

Yang sudah benar: `healthCheckPath: /api/health` (endpoint itu memang ada di `server.js`),
region Singapore, `buildCommand` yang menjalankan `prisma generate && prisma migrate deploy`.

Yang harus diubah:

```yaml
envVars:
  - key: DATABASE_URL
    sync: false          # bukan "file:./dev.db" — isi dengan URL Postgres, jangan ditulis di repo
  - key: JWT_SECRET
    generateValue: true  # sudah benar, tapi lihat 3.2
  - key: GEMINI_API_KEY
    sync: false          # sudah benar
  - key: CORS_ALLOWED_ORIGINS
    value: https://94media.art
```

Catatan `generateValue: true`: Render membuat nilainya sekali saat layanan dibuat. Bila
layanan dihapus dan dibuat ulang, nilainya berubah dan **semua token login lama menjadi
tidak valid** — pengguna harus login ulang. Itu perilaku yang wajar, cukup diketahui.

### 3.2 Dua celah keamanan yang harus ditutup sebelum publik

**JWT_SECRET punya nilai cadangan yang tertulis di repositori.** Di
`src/controllers/authController.js:6` dan `src/middleware/authMiddleware.js:4`:

```js
const JWT_SECRET = process.env.JWT_SECRET || 'aesthetic_girly_fashion_analytics_secret_key_2026';
```

Bila variabel lingkungan gagal terpasang, aplikasi **tetap berjalan** memakai kunci yang
bisa dibaca siapa pun di repositori — dan siapa pun bisa membuat token admin palsu.
Perbaikannya: di produksi, berhenti dengan pesan jelas bila `JWT_SECRET` kosong, jangan
diam-diam memakai cadangan.

**CORS memantulkan asal mana pun.** `server.js:26`:

```js
app.use(cors({ origin: true, credentials: true }));
```

`origin: true` memantulkan header `Origin` apa pun yang datang. Untuk produksi, batasi ke
domain frontend saja (dibaca dari `CORS_ALLOWED_ORIGINS` agar tetap mudah diubah, dan
tetap mengizinkan `localhost:3000` saat `NODE_ENV !== 'production'`).

### 3.3 Cron tidak akan berjalan andal di free tier

`src/cron/syncCron.js` menjadwalkan sync di dalam proses (`node-cron`). Layanan free tier
tidur setelah ±15 menit tanpa lalu lintas, dan proses yang tidur tidak menjalankan cron.
Permintaan pertama setelah tidur juga memakan waktu ±1 menit untuk bangun.

Akibatnya: **snapshot tidak akan diperbarui otomatis**. Pilihan:

- Terima saja, dan andalkan tombol Sync manual (paling sederhana, sesuai sifat aplikasi
  ini yang memang berbasis snapshot eksplisit)
- Panggil `POST /api/sync/run` dari penjadwal eksternal gratis (cron-job.org, GitHub
  Actions `schedule`) — sekaligus membangunkan layanan
- Naik ke paket berbayar Render bila sync otomatis benar-benar dibutuhkan

Jangan memakai ping-bot hanya untuk menahan layanan tetap bangun: itu menghabiskan kuota
750 jam/bulan free tier lebih cepat.

---

## 4. Deploy frontend ke Hostinger

Jalur yang sudah terbukti di akun ini: deploy dari git, `app_type: next`, Node 24,
`build_script: build`, `output_directory: .next`.

**Satu hal yang paling sering salah:** `NEXT_PUBLIC_API_BASE` di `lib/api.js:3` dibaca
Next.js **saat build**, bukan saat runtime — nilainya ditanam ke dalam bundel JavaScript.
Jadi variabel itu harus tersedia di lingkungan build Hostinger. Menyetelnya setelah build
selesai tidak berpengaruh apa pun; bundelnya akan tetap menunjuk `http://localhost:5000/api`
dan seluruh aplikasi akan gagal memuat data di produksi.

```
NEXT_PUBLIC_API_BASE=https://<nama-layanan>.onrender.com/api
```

Setelah backend punya URL Render tetap, setel nilai itu lalu **build ulang** frontend.

---

## 5. Menghubungkan keduanya — daftar periksa

| Hal | Nilai |
|---|---|
| Frontend memanggil | `NEXT_PUBLIC_API_BASE` = URL Render + `/api` |
| Backend mengizinkan | `CORS_ALLOWED_ORIGINS` = `https://94media.art` |
| Token | Disimpan di `localStorage` + cookie `auth_token`; `middleware.js` membaca cookie itu |
| Cookie | Bukan lintas-domain — di-set oleh JavaScript frontend di domainnya sendiri, jadi beda domain backend tidak masalah |
| HTTPS | Wajib keduanya. Halaman HTTPS yang memanggil API HTTP akan diblokir browser (mixed content) |

Uji setelah deploy, berurutan: `GET /api/health` → login → dashboard memuat data → tombol
Sync → satu panel AI.

---

## 6. Tetap aman untuk pengembangan ke depan

1. **Jangan pernah memakai basis data produksi untuk pengembangan.** Setelah pindah ke
   Postgres, buat basis data terpisah untuk lokal — `DATABASE_URL` di `.env` lokal
   menunjuk ke sana. Constraint 5 di `AGENTS.md` (jangan `db push` pada basis data
   berisi data) berlaku dua kali lipat untuk produksi.
2. **Migrasi lewat `migrate deploy`, bukan `db push`.** `buildCommand` di Render sudah
   menjalankannya otomatis setiap deploy — itu perilaku yang benar dan jangan diganti.
   Setiap perubahan skema harus punya berkas migrasi yang ikut ter-commit.
3. **Backup terjadwal.** Neon dan Supabase punya point-in-time recovery di paket gratisnya
   dengan retensi terbatas. Untuk data yang tidak bisa dibuat ulang (`User`,
   `SystemConfig`, `StoreSession`, `OptimizationTask`), ekspor berkala ke luar platform
   layak dilakukan — dan simpan **di luar repositori**.
4. **Rahasia hanya lewat variabel lingkungan.** Cookie Shopee, kunci Gemini, dan kredensial
   gudang saat ini disimpan di tabel `SystemConfig` melalui halaman Pengaturan. Itu tidak
   apa-apa selama basis datanya tidak pernah ikut ter-commit — masalah 0.1 terjadi justru
   karena backup basis data masuk ke git.
5. **Kuota AI tidak berubah oleh deploy.** Gemini tetap dibatasi 20 permintaan/hari di
   paket gratis, dan kuota itu milik kunci API, bukan milik server. Deploy ke produksi
   tidak menambahnya — lihat `docs/AI_SERVICE.md`.
6. **Alur kerja yang disarankan:** kembangkan lokal → `npm run build` (frontend) dan
   `npm run test:ai` (backend) lulus → commit → push → Render membangun otomatis, Hostinger
   di-deploy dari git. Selalu **restart server frontend setelah build ulang** bila menguji
   `next start` secara lokal (lihat catatan di `frontend/AGENTS.md`).

---

## Urutan pengerjaan yang disarankan

1. Ganti ketiga kredensial yang terekspos (0.1 langkah 1) — **paling mendesak**
2. Bersihkan riwayat git dari kedua berkas `.bak` (0.1 langkah 2)
3. Tutup dua celah keamanan produksi: JWT fallback dan CORS (3.2)
4. Ramping-kan basis data, lalu migrasi ke Postgres (2)
5. Perbaiki `render.yaml`, deploy backend, uji `/api/health` (3)
6. Setel `NEXT_PUBLIC_API_BASE`, build dan deploy frontend (4)
7. Uji rantai lengkap (5), lalu putuskan strategi cron (3.3)

Langkah 1–3 tidak bergantung pada apa pun dan bisa dikerjakan kapan saja. Langkah 5 tidak
boleh mendahului langkah 4, dan langkah 6 tidak boleh mendahului langkah 5 — URL Render
belum ada sebelum backend berjalan.
