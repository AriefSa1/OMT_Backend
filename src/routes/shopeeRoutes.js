const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { authenticateAdmin } = require('../middleware/adminAuth');
const {
  parseCookie,
  getSessionStatus,
  getAllStores,
  setActiveStore,
  deleteStoreSession,
  getShopeeMetrics,
  getProductDetail,
  updateProductEconomics,
  getShopeeAds,
  getProductPerformance,
  getTrafficSources,
  triggerSync,
  validateCookie,
} = require('../controllers/shopeeController');

const credentialService = require('../services/credentialService');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.use(authMiddleware);

// --- Public-ish routes (user level) ---
router.post('/cookie', parseCookie);
router.get('/session', getSessionStatus);
router.get('/stores', getAllStores);
router.post('/stores/active', setActiveStore);
router.delete('/stores/:storeId', deleteStoreSession);
router.get('/metrics', getShopeeMetrics);
router.get('/product/:id', getProductDetail);
router.put('/product/:id/economics', updateProductEconomics);
router.get('/ads', getShopeeAds);
router.get('/product-performance', getProductPerformance);
router.get('/traffic-sources', getTrafficSources);
router.post('/sync', triggerSync);
router.get('/validate-cookie', validateCookie);

// --- Admin-only routes (store-scoped credential management) ---
const adminRouter = express.Router();

// Rate limit khusus jalur admin: bearer-key statis tanpa pembatasan bisa ditebak
// atau disalahgunakan. 30 request / 5 menit / IP cukup longgar untuk pemakaian sah.
const adminLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: Number(process.env.ADMIN_RATE_LIMIT_MAX) || 30,
  message: 'Terlalu banyak permintaan admin. Coba lagi dalam beberapa menit.',
});
adminRouter.use(adminLimiter, authenticateAdmin);

// GET /api/shopee/credentials — list stored credentials (metadata only; cookie
// terenkripsi TIDAK PERNAH dikembalikan)
adminRouter.get('/credentials', async (req, res) => {
  try {
    const credentials = await credentialService.listCredentials();
    res.json({ credentials });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil daftar credential' });
  }
});

// POST /api/shopee/credentials — save a new Shopee cookie (disimpan terenkripsi)
adminRouter.post('/credentials', async (req, res) => {
  const { cookie, storeId } = req.body;

  if (!cookie || typeof cookie !== 'string' || cookie.length < 100) {
    return res.status(400).json({ error: 'Cookie tidak valid (minimal 100 karakter)' });
  }

  try {
    const cred = await credentialService.saveCredential(cookie, storeId);

    // Jangan pernah mencatat isi cookie — hanya metadata untuk jejak audit.
    console.log('[SECURITY] Shopee cookie saved via admin panel', {
      storeId: cred.storeId,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, id: cred.id, storeId: cred.storeId });
  } catch (err) {
    console.error('[Admin Credential] Save error:', err.message);
    res.status(500).json({ error: 'Gagal menyimpan cookie' });
  }
});

// DELETE /api/shopee/credentials/:id — remove a stored credential (admin only)
adminRouter.delete('/credentials/:id', async (req, res) => {
  const { id } = req.params;
  if (!Number.isInteger(Number(id))) {
    return res.status(400).json({ error: 'ID credential tidak valid' });
  }
  try {
    await credentialService.deleteCredential(id);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: 'Credential tidak ditemukan' });
  }
});

router.use('/admin', adminRouter); // mount admin routes under /api/shopee/admin/*

module.exports = router;
