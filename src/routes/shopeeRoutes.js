const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const {
  parseCookie,
  getSessionStatus,
  getShopeeMetrics,
  getProductDetail,
  updateProductEconomics,
  getShopeeAds,
  getProductPerformance,
  getTrafficSources,
  triggerSync,
  validateCookie
} = require('../controllers/shopeeController');

const router = express.Router();

router.use(authMiddleware);

router.post('/cookie', parseCookie);
router.get('/session', getSessionStatus);
router.get('/metrics', getShopeeMetrics);
router.get('/product/:id', getProductDetail);
router.put('/product/:id/economics', updateProductEconomics);
router.get('/ads', getShopeeAds);
router.get('/product-performance', getProductPerformance);
router.get('/traffic-sources', getTrafficSources);
router.post('/sync', triggerSync);
router.get('/validate-cookie', validateCookie);

module.exports = router;
