const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const {
  generateTitle,
  generateStoreCopy,
  generateAds,
  generateABCopy,
  predictRestock,
  simulatePricing,
  getDailyBriefing,
  optimizeAdsKeywords,
} = require('../controllers/aiController');

const router = express.Router();

router.use(authMiddleware);

// Legacy routes
router.post('/generate-title', generateTitle);
router.post('/generate-store-copy', generateStoreCopy);
router.post('/generate-ads-keywords', generateAds);

// 5 New AI feature routes
router.post('/ab-copy', generateABCopy);
router.post('/predictive-restock', predictRestock);
router.post('/pricing-simulator', simulatePricing);
router.get('/daily-briefing', getDailyBriefing);
router.post('/daily-briefing', getDailyBriefing);
router.post('/ads-keyword-optimization', optimizeAdsKeywords);

module.exports = router;
