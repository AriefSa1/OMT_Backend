/**
 * Resolusi terpusat untuk secret JWT.
 *
 * Secret ini menandatangani token sesi. Bila nilainya bisa ditebak, siapa pun dapat
 * memalsukan token dan masuk sebagai user mana pun. Karena itu:
 *
 * - Di produksi (NODE_ENV=production) JWT_SECRET WAJIB diisi. Tidak ada fallback — dulu
 *   ada string fallback yang tertulis langsung di berkas ini, dan berkas ini ada di repo
 *   publik, jadi fallback itu justru menjadi kunci umum yang bisa dipakai siapa saja.
 *   Sekarang startup gagal keras daripada berjalan dengan kunci yang diketahui publik.
 * - Di pengembangan lokal, fallback tetap dipertahankan supaya `npm run dev` jalan tanpa
 *   menyetel apa pun. Kunci ini HANYA aman karena mesin lokal tidak terekspos.
 *
 * Di Render, render.yaml menyetel JWT_SECRET lewat generateValue, jadi syarat produksi
 * ini sudah terpenuhi otomatis.
 */
const DEV_FALLBACK_SECRET = 'dev-only-insecure-jwt-secret-do-not-use-in-production';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.trim() !== '') {
    return secret.trim();
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET wajib diisi di produksi. Setel environment variable JWT_SECRET '
      + '(di Render: Dashboard → Environment) sebelum menjalankan server.'
    );
  }

  return DEV_FALLBACK_SECRET;
}

module.exports = {
  getJwtSecret,
};
