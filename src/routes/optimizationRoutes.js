const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const {
  getProductOpts,
  getStoreOpts,
  getAdsOpts,
  applyOpt,
  getMarketplaceInsights,
  getCompetitorInsights,
  refreshCompetitorInsights,
} = require('../controllers/optimizationController');

const router = express.Router();

router.use(authMiddleware);

router.get('/products', getProductOpts);
router.get('/store', getStoreOpts);
router.get('/ads', getAdsOpts);
router.get('/marketplace-intelligence', getMarketplaceInsights);
router.get('/competitor-intelligence', getCompetitorInsights);
router.post('/competitor-intelligence', refreshCompetitorInsights);
router.post('/apply', applyOpt);

module.exports = router;
