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

const prisma = require('../utils/prisma');

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

// GET /api/shopee/credentials — list stored credentials (admin only)
adminRouter.get('/credentials', authenticateAdmin, async (req, res) => {
  try {
    const credentials = await prisma.shopeeCredential.findMany({
      select: {
        id: true,
        storeId: true,
        createdAt: true,
        updatedAt: true,
        // NOTE: cookie is intentionally NOT returned for security
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ credentials });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil daftar credential' });
  }
});

// POST /api/shopee/credentials — save a new Shopee cookie (admin only)
adminRouter.post('/credentials', authenticateAdmin, async (req, res) => {
  const { cookie, storeId } = req.body;

  if (!cookie || typeof cookie !== 'string' || cookie.length < 100) {
    return res.status(400).json({ error: 'Cookie tidak valid (minimal 100 karakter)' });
  }

  try {
    const cred = await prisma.shopeeCredential.upsert({
      where: { storeId: storeId || 'global' },
      update: { cookie, storeId: storeId || 'global' },
      create: { cookie, storeId: storeId || 'global' },
    });

    console.log(`[SECURITY] Shopee cookie saved via admin panel`, {
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
adminRouter.delete('/credentials/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.shopeeCredential.delete({ where: { id: Number(id) } });
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: 'Credential tidak ditemukan' });
  }
});

router.use('/admin', adminRouter); // mount admin routes under /api/shopee/admin/*

module.exports = router;
