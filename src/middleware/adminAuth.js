/**
 * Admin authentication middleware — proteksi endpoint kritis seperti
 * pengelolaan Shopee cookie.
 *
 * Hanya menerima request dengan header:
 *   Authorization: Bearer <ADMIN_API_KEY>
 *
 * ADMIN_API_KEY didefinisikan di environment (.env), TIDAK diekspor ke frontend.
 */
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token tidak ditemukan' });
  }

  const token = authHeader.split(' ')[1];
  const expectedKey = process.env.ADMIN_API_KEY;

  if (!expectedKey || token !== expectedKey) {
    return res.status(403).json({ error: 'Unauthorized — akses admin saja' });
  }

  req.user = { role: 'admin' };
  next();
};

module.exports = { authenticateAdmin };