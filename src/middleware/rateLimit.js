/**
 * Pembatas laju dalam-memori, tanpa dependensi.
 *
 * Kenapa in-memory cukup: Render free tier menjalankan satu instance, jadi tidak ada
 * proses lain yang perlu berbagi hitungan. Bila kelak naik ke beberapa instance,
 * ganti dengan penyimpanan bersama (mis. Redis) — antarmukanya sengaja dibuat sederhana.
 *
 * Tujuannya spesifik: memperlambat penebakan sandi terhadap /api/auth. Enam hash bcrypt
 * akun sudah bocor lewat riwayat git, jadi selama sandi belum semuanya dirotasi, membatasi
 * percobaan login online adalah pertahanan berlapis yang murah.
 */
function createRateLimiter({ windowMs, max, message = 'Terlalu banyak percobaan. Coba lagi nanti.' } = {}) {
  const hits = new Map();

  // Bersihkan entri kedaluwarsa sesekali supaya Map tidak tumbuh tak terbatas dari
  // IP yang tak pernah kembali. unref() agar timer ini tidak menahan proses tetap hidup.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now - entry.start >= windowMs) hits.delete(key);
    }
  }, windowMs);
  if (typeof sweep.unref === 'function') sweep.unref();

  return function rateLimit(req, res, next) {
    // Di belakang proxy Render, IP klien nyata ada di X-Forwarded-For (butuh trust proxy).
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (forwarded ? String(forwarded).split(',')[0].trim() : '') || req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || now - entry.start >= windowMs) {
      hits.set(ip, { count: 1, start: now });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ success: false, error: message });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
