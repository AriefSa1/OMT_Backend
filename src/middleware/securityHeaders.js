/**
 * Header keamanan dasar, tanpa dependensi (tanpa helmet).
 *
 * Ini API JSON, bukan penyaji HTML, jadi hanya header yang benar-benar relevan yang
 * dipasang — tidak perlu Content-Security-Policy untuk halaman karena tidak ada halaman.
 * Frontend (94media.art) disajikan terpisah oleh Hostinger dan mengatur header-nya sendiri.
 */
function securityHeaders(req, res, next) {
  // Jangan pernah menebak tipe konten dari isi respons.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Respons API tidak untuk ditanam dalam frame mana pun.
  res.setHeader('X-Frame-Options', 'DENY');
  // Jangan bocorkan URL lengkap ke tujuan lintas-origin.
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Matikan API browser yang tak dipakai bila respons ini sempat dirender.
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Paksa HTTPS hanya di produksi. HSTS di localhost akan mengunci http://localhost
  // di browser pengembang selama berbulan-bulan — menyakitkan dan tak perlu.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  next();
}

module.exports = { securityHeaders };
